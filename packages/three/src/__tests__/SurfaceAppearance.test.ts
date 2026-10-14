import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SURFACE_APPEARANCE as defaults, SurfaceAppearance, renderedHeightKm, surfaceTintHeightAtHit } from '../SurfaceAppearance.js';
import { TerrainManager } from '../TerrainManager.js';
import { injectAerialPerspectiveIntoShader } from '../AerialPerspective.js';
import { injectShadowIntoShader, makeShadowUniforms } from '../EclipseShadow.js';
import type { TerrainDatum } from '../TerrainSampler.js';

const datum: TerrainDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] }, verticalDatum: 'ellipsoid', heightConvention: 'radial' };
function mesh() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 20, 0, 10, 0, 15], 3));
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}
function compile(material: THREE.Material) {
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
}

describe('surface appearance physical and material contracts', () => {
  it('computes radial height against the true oblate datum at equator and poles', () => {
    expect(renderedHeightKm(new THREE.Vector3(3396.19 - 8.765 + 10, 0, 0), datum)).toBeCloseTo(1.235, 8);
    expect(renderedHeightKm(new THREE.Vector3(0, 0, -3376.2 - 2), datum)).toBeCloseTo(2, 8);
    expect(renderedHeightKm(new THREE.Vector3(0, 3396.19 - 4, 0), datum)).toBeCloseTo(-4, 8);
  });

  it('supports normal height with the existing geodetic convention', () => {
    expect(renderedHeightKm(new THREE.Vector3(0, 0, 3376.2 + 0.5), { ...datum, heightConvention: 'geodetic-normal' })).toBeCloseTo(0.5, 8);
  });

  it('interpolates the displayed elevation value at a transformed triangle hit', () => {
    const tile = mesh();
    tile.geometry.setAttribute('surfaceHeightKm', new THREE.Float32BufferAttribute([-2, 0, 6], 1));
    tile.position.set(100, 200, 300); tile.scale.setScalar(2); tile.updateMatrixWorld(true);
    const point = tile.localToWorld(new THREE.Vector3(2.5, 5, 3.75));
    const hit = { object: tile, point, distance: 1, face: { a: 0, b: 1, c: 2, normal: new THREE.Vector3(), materialIndex: 0 } };
    expect(surfaceTintHeightAtHit(hit)).toBeCloseTo(0.5, 10);
    tile.geometry.deleteAttribute('surfaceHeightKm');
    expect(surfaceTintHeightAtHit(hit)).toBeUndefined();
  });

  it('adds no off-mode shader or heights; restores identical shader and releases attributes', () => {
    const style = new SurfaceAppearance(datum), tile = mesh();
    const positions = tile.geometry.getAttribute('position').array.slice();
    const originalKey = tile.material.customProgramCacheKey();
    const release = vi.fn(() => expect(tile.geometry.hasAttribute('surfaceHeightKm')).toBe(true));
    tile.geometry.addEventListener('dispose', release);
    style.attach(tile, new THREE.Matrix4().makeTranslation(3396190, 0, 0));
    expect(compile(tile.material).fragmentShader).toBe(THREE.ShaderLib.standard.fragmentShader);
    expect(tile.material.customProgramCacheKey()).toBe(originalKey);
    expect(tile.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    style.set({ ...defaults, baseColor: 'elevation' });
    expect(tile.geometry.getAttribute('surfaceHeightKm').getX(2)).toBeCloseTo(0.01, 4);
    expect(tile.geometry.getAttribute('position').array).toEqual(positions);
    style.set({ ...defaults });
    expect(release).toHaveBeenCalledTimes(1);
    expect(tile.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    expect(compile(tile.material).fragmentShader).toBe(THREE.ShaderLib.standard.fragmentShader);
    expect(tile.material.customProgramCacheKey()).toBe(originalKey);
  });

  it('composes imagery/fade callbacks and styles before existing shadows and atmosphere', () => {
    const style = new SurfaceAppearance(datum), tile = mesh();
    tile.material.onBeforeCompile = shader => {
      shader.uniforms.overlaySentinel = { value: 1 };
      injectShadowIntoShader(shader, makeShadowUniforms());
      injectAerialPerspectiveIntoShader(shader, {});
    };
    let layers = 2;
    tile.material.customProgramCacheKey = () => `overlay-${layers}`;
    style.set({ ...defaults, hillshade: true, baseColor: 'elevation' });
    style.attach(tile, new THREE.Matrix4().makeTranslation(3396190, 0, 0));
    const shader = compile(tile.material);
    expect(shader.uniforms).toHaveProperty('overlaySentinel');
    expect(shader.fragmentShader).toContain('getShadowMask()');
    expect(shader.fragmentShader.indexOf('outgoingLight = diffuseColor.rgb')).toBeLessThan(shader.fragmentShader.indexOf('AerialPerspectiveResult _ap'));
    expect(shader.fragmentShader).toContain('normalize(vSAReliefNormal)');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mix');
    layers = 3;
    expect(tile.material.customProgramCacheKey()).toContain('overlay-3');
  });

  it('updates uniforms without recompilation and attaches settings to later streamed tiles', () => {
    const style = new SurfaceAppearance(datum), tile = mesh();
    style.set({ ...defaults, hillshade: true });
    style.attach(tile, new THREE.Matrix4().makeTranslation(0, 0, 3376200));
    const shader = compile(tile.material), version = tile.material.version;
    style.set({ ...defaults, hillshade: true, azimuthDeg: 90 });
    expect(tile.material.version).toBe(version);
    expect((shader.uniforms as Record<string, { value: THREE.Vector3 }>).saLight.value.x).toBeCloseTo(Math.SQRT1_2);
    expect(tile.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    expect(tile.geometry.hasAttribute('surfaceGround')).toBe(true);
    style.forget(tile);
    style.set({ ...defaults, baseColor: 'elevation' });
    expect(tile.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
  });

  it('separates terrain slopes from skirt walls without changing physical buffers', () => {
    const tile = mesh();
    tile.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 20, 0, 10, 0, 15, 0, 0, -10, 0, 20, -10, 10, 0, -10], 3));
    tile.geometry.setIndex([0, 1, 2, 3, 4, 5]);
    tile.geometry.addGroup(0, 3, 0);
    tile.geometry.addGroup(3, 3, 0);
    const style = new SurfaceAppearance(datum);
    style.set({ ...defaults, hillshade: true });
    style.attach(tile, new THREE.Matrix4());
    expect(Array.from(tile.geometry.getAttribute('surfaceGround').array)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(compile(tile.material).fragmentShader).toContain('normalize(vSAReliefNormal)');
    expect(compile(tile.material).fragmentShader).not.toContain('vSANormal');
    style.set({ ...defaults });
    expect(tile.geometry.hasAttribute('surfaceGround')).toBe(false);
    expect(Array.from(tile.geometry.index!.array)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('shares area-weighted normals across loaded tile edges and updates on eviction', () => {
    const style = new SurfaceAppearance(datum);
    style.set({ ...defaults, hillshade: true });
    const left = mesh(), right = mesh();
    left.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, -1, 0, 0], 3));
    // Small cross-LOD height differences must not prevent a shared geographic
    // edge from receiving one normal field (physical vertices remain separate).
    right.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 10, 1, 0, 11, 0, 1, 10], 3));
    const matrix = new THREE.Matrix4().makeTranslation(0, 0, 3376200);
    style.attach(left, matrix); style.attach(right, matrix);
    const ln = left.geometry.getAttribute('surfaceReliefNormal'), rn = right.geometry.getAttribute('surfaceReliefNormal');
    expect(ln.getX(0)).toBeCloseTo(-1 / Math.sqrt(5));
    expect(ln.getZ(0)).toBeCloseTo(2 / Math.sqrt(5));
    expect(rn.getX(0)).toBe(ln.getX(0)); expect(rn.getZ(0)).toBe(ln.getZ(0));
    expect(rn.getX(2)).toBe(ln.getX(1));
    style.forget(right);
    expect(ln.getX(0)).toBeCloseTo(0); expect(ln.getZ(0)).toBeCloseTo(1);
    style.set({ ...defaults });
    expect(left.geometry.hasAttribute('surfaceReliefNormal')).toBe(false);
  });

  it('rejects unavailable elevation sources and keeps style state isolated per body', () => {
    const make = (type: 'quantized-mesh' | '3dtiles', verticalDatum: 'ellipsoid' | 'unknown') => new TerrainManager({ type, url: 'https://example.invalid/', datum: { verticalDatum } }, 1737.4, undefined as never);
    const moon = make('quantized-mesh', 'ellipsoid'), mars = make('quantized-mesh', 'ellipsoid');
    moon.setSurfaceAppearance({ ...defaults, hillshade: true });
    expect(mars.surfaceAppearance?.hillshade).toBe(false);
    expect(moon.surfaceAppearance?.hillshade).toBe(true);
    expect(make('3dtiles', 'ellipsoid').surfaceAppearance).toBeNull();
    expect(make('quantized-mesh', 'unknown').surfaceAppearance).toBeNull();
    expect(new TerrainManager({ type: 'imagery', imagery: { url: 'https://example.invalid/{z}/{x}/{y}.png' } }, 1737.4, undefined as never).surfaceAppearance).toBeNull();
    moon.setSurfaceAppearance({ ...defaults, baseColor: 'elevation', minKm: 10, maxKm: -10, azimuthDeg: NaN });
    expect(moon.surfaceAppearance!.maxKm).toBeGreaterThan(10);
    expect(moon.surfaceAppearance!.azimuthDeg).toBe(315);
  });

  it('styles newly loaded tiles in ECEF before globe/world transforms and forgets disposed tiles', () => {
    const tm = new TerrainManager({ type: 'quantized-mesh', url: 'https://example.invalid/' }, 1737.4, undefined as never);
    tm.group.position.set(1e8, -1e8, 20);
    tm.group.scale.setScalar(1e-6);
    tm.setSurfaceAppearance({ ...defaults, baseColor: 'elevation' });
    const tileMesh = mesh();
    tileMesh.position.set(1737400, 0, 0);
    const scene = new THREE.Group();
    scene.add(tileMesh);
    const tiles = (tm as unknown as { tiles: { group: THREE.Group; dispatchEvent(e: unknown): void } }).tiles;
    tiles.group.add(scene);
    tiles.dispatchEvent({ type: 'load-model', scene, tile: {} });
    expect(tileMesh.geometry.getAttribute('surfaceHeightKm').getX(2)).toBeCloseTo(0.01, 4);
    expect(compile(tileMesh.material).fragmentShader).toContain('saTint');
    tiles.dispatchEvent({ type: 'dispose-model', scene, tile: {} });
    const version = tileMesh.material.version;
    tm.setSurfaceAppearance({ ...defaults, hillshade: true });
    expect(tileMesh.material.version).toBe(version);
  });
});
