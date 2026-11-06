import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TerrainManager, type TerrainConfig } from '../TerrainManager.js';

/**
 * Material variants for the imagery illumination contract (#204). No GL
 * context: the tile materials are inspected and their shader hooks run on a
 * stand-in shader, which is enough to prove which tiles are relit.
 */
const NO_RENDERER = undefined as unknown as THREE.WebGLRenderer;
const MOON: [number, number, number] = [1737.4, 1737.4, 1737.4];
const imagery = (illumination?: 'reflectance' | 'baked' | 'unknown') =>
  ({ url: 'https://example.invalid/{z}/{x}/{y}.png', illumination });

const make = (over: Partial<TerrainConfig> = {}) => new TerrainManager(
  { type: 'quantized-mesh', url: 'https://example.invalid/moon/', ...over } as TerrainConfig, MOON, NO_RENDERER);

/** An unlit imagery tile, as XYZTilesPlugin / KHR_materials_unlit produce. */
function unlitTile(): { scene: THREE.Group; mesh: THREE.Mesh } {
  const map = new THREE.Texture();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map }));
  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, mesh };
}

/** A lit PBR tile, as a quantized mesh or glTF tile arrives. */
function litTile(): { scene: THREE.Group; mesh: THREE.Mesh } {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, mesh };
}

const customize = (tm: TerrainManager, scene: THREE.Object3D) =>
  (tm as unknown as { customizeTileMaterial(s: THREE.Object3D, t: unknown): void }).customizeTileMaterial(scene, {});

const FRAG = 'void main(){\n#include <opaque_fragment>\n}';
const compile = (mat: THREE.Material) => {
  const shader = { vertexShader: '#include <project_vertex>', fragmentShader: FRAG, uniforms: {} as Record<string, unknown> };
  (mat.onBeforeCompile as unknown as (s: typeof shader, r: unknown) => void)(shader, undefined);
  return shader;
};
const mixLine = 'outgoingLight = mix(outgoingLight, diffuseColor.rgb, uSurfaceAsIs);';

describe('surface illumination provenance resolution', () => {
  it('defaults to the legacy `unknown` path when a catalog declares nothing', () => {
    expect(make({ imagery: imagery() }).surfaceIllumination).toBe('unknown');
    expect(make({ type: '3dtiles', url: 'https://example.invalid/t.json' }).surfaceIllumination).toBe('unknown');
  });

  it('treats an untextured quantized mesh as neutral albedo', () => {
    expect(make().surfaceIllumination).toBe('reflectance');
  });

  it('honours declared sources and claims a stack only when its layers agree', () => {
    expect(make({ imagery: imagery('reflectance') }).surfaceIllumination).toBe('reflectance');
    expect(make({ imagery: [imagery('baked'), imagery('baked')] }).surfaceIllumination).toBe('baked');
    expect(make({ imagery: [imagery('reflectance'), imagery('baked')] }).surfaceIllumination).toBe('unknown');
    expect(make({ imagery: [imagery('reflectance'), imagery()] }).surfaceIllumination).toBe('unknown');
    expect(make({ type: '3dtiles', url: 'https://example.invalid/t.json', illumination: 'baked' }).surfaceIllumination).toBe('baked');
  });
});

const uniformOf = (mat: THREE.Material) => compile(mat).uniforms.uSurfaceAsIs as { value: number };

describe('tile material variants', () => {
  it('gives relit provenance a zero as-is uniform: reflectance and legacy unknown stay Sun-lit', () => {
    for (const illumination of ['reflectance', undefined] as const) {
      const { scene, mesh } = unlitTile();
      customize(make({ imagery: imagery(illumination) }), scene);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      expect(mat.isMeshStandardMaterial).toBe(true);
      expect(uniformOf(mat).value).toBe(0);
    }
  });

  it('shows illumination-baked unlit imagery as-is, so the Sun cannot double-light it', () => {
    const { scene, mesh } = unlitTile();
    customize(make({ imagery: imagery('baked') }), scene);
    const shader = compile(mesh.material as THREE.Material);
    expect(shader.uniforms.uSurfaceAsIs).toEqual({ value: 1 });
    expect(shader.fragmentShader).toContain(mixLine);
    expect(shader.fragmentShader.indexOf(mixLine)).toBeLessThan(shader.fragmentShader.indexOf('#include <opaque_fragment>'));
  });

  it('applies the same path to tiles that arrive as lit PBR materials', () => {
    const { scene, mesh } = litTile();
    customize(make({ imagery: imagery('baked') }), scene);
    expect(uniformOf(mesh.material as THREE.Material).value).toBe(1);
    const { scene: relit, mesh: relitMesh } = litTile();
    customize(make({ imagery: imagery('reflectance') }), relit);
    expect(uniformOf(relitMesh.material as THREE.Material).value).toBe(0);
  });

  it('shares one program for relit and baked tiles: provenance is a uniform, not a variant', () => {
    const keys = new Set<string>();
    for (const illumination of ['baked', 'reflectance'] as const) {
      const { scene, mesh } = unlitTile();
      customize(make({ imagery: imagery(illumination) }), scene);
      keys.add((mesh.material as THREE.Material).customProgramCacheKey!());
    }
    expect(keys.size).toBe(1);
  });

  it('never lets a bounded baked overlay switch the Sun off for the whole surface', () => {
    const tm = make({ imagery: [imagery('reflectance'), { ...imagery('baked'), id: 'shaded' }] });
    const { scene, mesh } = unlitTile();
    customize(tm, scene);
    // Visible baked overlay over a reflectance base: mixed, so the legacy relit path.
    expect(tm.surfaceIllumination).toBe('unknown');
    expect(uniformOf(mesh.material as THREE.Material).value).toBe(0);
  });

  it('counts only layers that contribute pixels: hidden or zero-opacity layers do not', () => {
    const tm = make({ imagery: [imagery('reflectance'), { ...imagery('baked'), id: 'shaded', visible: false }] });
    const layers = (tm as unknown as { layers: { id: string; visible: boolean; opacity: number }[] }).layers;
    const refresh = () => (tm as unknown as { refreshIllumination(): void }).refreshIllumination();
    const { scene, mesh } = unlitTile();
    customize(tm, scene);
    const uniform = uniformOf(mesh.material as THREE.Material);
    const shaded = layers.find(l => l.id === 'shaded')!;
    expect(tm.surfaceIllumination).toBe('reflectance'); // hidden baked layer ignored
    shaded.visible = true; refresh();
    expect(tm.surfaceIllumination).toBe('unknown'); // mixed
    shaded.opacity = 0; refresh();
    expect(tm.surfaceIllumination).toBe('reflectance'); // opacity zero contributes nothing
    expect(uniform.value).toBe(0);
    // A baked base with a zero-opacity relit overlay is purely baked: as-is, same uniform, no recompile.
    const baked = make({ imagery: [imagery('baked'), { ...imagery('reflectance'), id: 'extra', opacity: 0 }] });
    (baked as unknown as { layers: { id: string; opacity: number }[] }).layers.find(l => l.id === 'extra')!.opacity = 0;
    (baked as unknown as { refreshIllumination(): void }).refreshIllumination();
    expect(baked.surfaceIllumination).toBe('baked');
    const { scene: s2, mesh: m2 } = unlitTile();
    customize(baked, s2);
    expect(uniformOf(m2.material as THREE.Material).value).toBe(1);
  });

  it('leaves tile geometry, positions and picking data untouched', () => {
    const { scene, mesh } = litTile();
    const before = Array.from(mesh.geometry.getAttribute('position').array);
    customize(make({ imagery: imagery('baked') }), scene);
    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(before);
  });
});

describe('shading normals across tiles (blendSphereNormals, #204)', () => {
  // Two tiles meeting at one ECEF vertex, each carrying its own slope-derived
  // normal there, as independently decoded quantized-mesh tiles do.
  const R = 1737.4e3;
  const shared = new THREE.Vector3(R, 0, 0);
  const tile = (center: THREE.Vector3, normal: THREE.Vector3) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...shared.clone().sub(center).toArray()], 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal.clone().normalize().toArray(), 3));
    const mesh = new THREE.Mesh(geometry);
    mesh.position.copy(center);
    return mesh;
  };
  const blend = (mesh: THREE.Mesh, factor: number) =>
    (make() as unknown as { blendSphereNormals(m: THREE.Mesh, f: number): void }).blendSphereNormals(mesh, factor);
  const normalAt = (mesh: THREE.Mesh) => new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('normal') as THREE.BufferAttribute, 0);

  it('shrinks the seam discontinuity and never moves a vertex', () => {
    const a = tile(new THREE.Vector3(R, -500, 0), new THREE.Vector3(1, 0.5, 0)); // leans toward tile B
    const b = tile(new THREE.Vector3(R, 500, 0), new THREE.Vector3(1, -0.5, 0));
    const before = normalAt(a).angleTo(normalAt(b));
    const positionsBefore = [a, b].map(m => Array.from(m.geometry.getAttribute('position').array));
    blend(a, 0.6); blend(b, 0.6);
    const after = normalAt(a).angleTo(normalAt(b));
    expect(before).toBeGreaterThan(0.8);
    expect(after).toBeLessThan(before * 0.5);
    expect(after).toBeGreaterThanOrEqual(0);
    expect([a, b].map(m => Array.from(m.geometry.getAttribute('position').array))).toEqual(positionsBefore);
    // Both converge on the same sphere normal, so tiles agree wherever they share an absolute position.
    expect(normalAt(a).distanceTo(shared.clone().normalize())).toBeLessThan(0.35);
  });

  it('is exactly continuous at blend factor 1 and exactly the source normal at 0', () => {
    const a = tile(new THREE.Vector3(R, -500, 0), new THREE.Vector3(1, 0.5, 0));
    const b = tile(new THREE.Vector3(R, 500, 0), new THREE.Vector3(1, -0.5, 0));
    const untouched = normalAt(a).clone();
    blend(a, 0); blend(b, 1);
    expect(normalAt(a).distanceTo(untouched)).toBeLessThan(1e-6);
    expect(normalAt(b).distanceTo(shared.clone().normalize())).toBeLessThan(1e-6);
  });
});
