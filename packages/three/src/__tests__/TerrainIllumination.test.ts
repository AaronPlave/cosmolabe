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
const asIsLine = 'outgoingLight = diffuseColor.rgb;';

describe('surface illumination provenance resolution', () => {
  it('defaults to the legacy `unknown` path when a catalog declares nothing', () => {
    expect(make({ imagery: imagery() }).surfaceIllumination).toBe('unknown');
    expect(make({ type: '3dtiles', url: 'https://example.invalid/t.json' }).surfaceIllumination).toBe('unknown');
  });

  it('treats an untextured quantized mesh as neutral albedo', () => {
    expect(make().surfaceIllumination).toBe('reflectance');
  });

  it('honours declared sources and combines stacks conservatively', () => {
    expect(make({ imagery: imagery('reflectance') }).surfaceIllumination).toBe('reflectance');
    expect(make({ imagery: [imagery('reflectance'), imagery('baked')] }).surfaceIllumination).toBe('baked');
    expect(make({ imagery: [imagery('reflectance'), imagery()] }).surfaceIllumination).toBe('unknown');
    expect(make({ type: '3dtiles', url: 'https://example.invalid/t.json', illumination: 'baked' }).surfaceIllumination).toBe('baked');
  });
});

describe('tile material variants', () => {
  it('relights reflectance and legacy unknown imagery with the Sun: no as-is hook', () => {
    for (const illumination of ['reflectance', undefined] as const) {
      const { scene, mesh } = unlitTile();
      customize(make({ imagery: imagery(illumination) }), scene);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      expect(mat.isMeshStandardMaterial).toBe(true);
      expect(mat.customProgramCacheKey?.() ?? '').not.toContain('asis');
      expect(mat.onBeforeCompile.toString()).not.toContain('diffuseColor');
    }
  });

  it('shows illumination-baked unlit imagery as-is, so the Sun cannot double-light it', () => {
    const { scene, mesh } = unlitTile();
    customize(make({ imagery: imagery('baked') }), scene);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const shader = compile(mat);
    expect(shader.fragmentShader).toContain(asIsLine);
    expect(shader.fragmentShader.indexOf(asIsLine)).toBeLessThan(shader.fragmentShader.indexOf('#include <opaque_fragment>'));
    expect(mat.customProgramCacheKey!()).toContain('_asis_v1');
  });

  it('applies the same as-is path to tiles that arrive as lit PBR materials', () => {
    const { scene, mesh } = litTile();
    customize(make({ imagery: imagery('baked') }), scene);
    expect(compile(mesh.material as THREE.Material).fragmentShader).toContain(asIsLine);
    const { scene: relit, mesh: relitMesh } = litTile();
    customize(make({ imagery: imagery('reflectance') }), relit);
    expect((relitMesh.material as THREE.MeshStandardMaterial).customProgramCacheKey?.() ?? '').not.toContain('asis');
  });

  it('keeps baked and relit programs distinct and adds only one variant per provenance', () => {
    const keys = new Set<string>();
    for (const illumination of ['baked', 'reflectance'] as const) {
      const { scene, mesh } = unlitTile();
      const tm = make({ imagery: imagery(illumination) });
      tm.enableAerialPerspective({} as never);
      customize(tm, scene);
      keys.add((mesh.material as THREE.Material).customProgramCacheKey!());
    }
    expect(keys.size).toBe(2);
  });

  it('leaves tile geometry, positions and picking data untouched', () => {
    const { scene, mesh } = litTile();
    const before = Array.from(mesh.geometry.getAttribute('position').array);
    customize(make({ imagery: imagery('baked') }), scene);
    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(before);
  });
});
