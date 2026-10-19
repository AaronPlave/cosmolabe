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
  it('shares datum-aware heights between contours and tint, and releases only unused attributes', () => {
    const style = new SurfaceAppearance(datum), tile = mesh();
    style.attach(tile, new THREE.Matrix4().makeTranslation(3396190 - 8765, 0, 0));
    style.set({ ...defaults, contours: true }); style.update(Infinity);
    const heights = tile.geometry.getAttribute('surfaceHeightKm');
    expect(heights.getX(0)).toBeCloseTo(-8.765, 5);
    expect(tile.geometry.hasAttribute('surfaceGround')).toBe(true);
    expect(tile.geometry.hasAttribute('surfaceReliefNormal')).toBe(false);
    const shader = compile(tile.material);
    expect(shader.fragmentShader).toContain('saContourLine');
    expect(shader.fragmentShader).not.toMatch(/vCartographic|cartoOpacity|atan\(/);
    const version = tile.material.version;
    style.set({ ...defaults, contours: true, contourColor: '#123456', contourOpacity: 0.6, contourDensity: 2 });
    expect(tile.material.version).toBe(version);
    expect(shader.uniforms).toHaveProperty('saContourOpacity.value', 0.6);
    style.set({ ...defaults, baseColor: 'elevation' }); style.update(Infinity);
    expect(tile.geometry.getAttribute('surfaceHeightKm')).toBe(heights);
    expect(tile.geometry.hasAttribute('surfaceGround')).toBe(false);
    style.set({ ...defaults });
    expect(tile.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    expect(compile(tile.material).fragmentShader).toBe(THREE.ShaderLib.standard.fragmentShader);
  });

  it('masks skirt walls for contours without allocating hillshade normals', () => {
    const tile = mesh(), style = new SurfaceAppearance(datum);
    tile.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 20, 0, 10, 0, 15, 0, 0, -10, 0, 20, -10, 10, 0, -10], 3));
    tile.geometry.setIndex([0, 1, 2, 3, 4, 5]);
    tile.geometry.addGroup(0, 3, 0); tile.geometry.addGroup(3, 3, 0);
    style.attach(tile, new THREE.Matrix4().makeTranslation(3396190, 0, 0));
    style.set({ ...defaults, contours: true }); style.update(Infinity);
    expect(Array.from(tile.geometry.getAttribute('surfaceGround').array)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(tile.geometry.hasAttribute('surfaceReliefNormal')).toBe(false);
    expect(compile(tile.material).fragmentShader).toContain('step(0.999, vSAContourGround)');
  });

  it('composes unlit contours after terrain lighting, eclipse and aerial perspective', () => {
    const style = new SurfaceAppearance(datum), tile = mesh();
    tile.material.onBeforeCompile = shader => {
      shader.uniforms.imagerySentinel = { value: 1 };
      injectShadowIntoShader(shader, makeShadowUniforms());
      injectAerialPerspectiveIntoShader(shader, {});
    };
    style.attach(tile, new THREE.Matrix4().makeTranslation(0, 0, -3376200));
    style.set({ ...defaults, contours: true, baseColor: 'elevation', hillshade: true });
    style.update(Infinity);
    const shader = compile(tile.material), fs = shader.fragmentShader;
    expect(shader.uniforms).toHaveProperty('imagerySentinel');
    expect(fs.indexOf('vec3 saTint')).toBeLessThan(fs.indexOf('float saFootprint'));
    expect(fs.indexOf('#include <lights_physical_fragment>')).toBeLessThan(fs.indexOf('float saFootprint'));
    expect(fs.indexOf('outgoingLight = diffuseColor.rgb')).toBeLessThan(fs.indexOf('AerialPerspectiveResult _ap'));
    expect(fs.indexOf('outgoingLight *= computeEclipseShadow()')).toBeLessThan(fs.indexOf('float saFootprint'));
    expect(fs.indexOf('outgoingLight = outgoingLight * _ap.transmittance')).toBeLessThan(fs.indexOf('float saFootprint'));
    expect(fs.indexOf('outgoingLight = mix(outgoingLight, saContourColor')).toBeLessThan(fs.indexOf('#include <opaque_fragment>'));
    expect(shader.vertexShader.match(/attribute float surfaceHeightKm/g)).toHaveLength(1);
    // Styling settings on one body cannot bleed into another.
    expect(new SurfaceAppearance(datum).current.contours).toBe(false);
  });

  it('keeps contour height fields stable at tile boundaries and a lunar pole across origin shifts', () => {
    const moon = { ...datum, referenceShape: { kind: 'sphere' as const, radiusKm: 1737.4 } };
    const style = new SurfaceAppearance(moon), a = mesh(), b = mesh();
    // Identical body-fixed pole in two different tile-local frames, metres.
    a.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, -1, 0, 10, -2], 3));
    b.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-100, 0, 0, -90, 0, -1, -100, 10, -2], 3));
    style.attach(a, new THREE.Matrix4().makeTranslation(0, 0, -1738400));
    style.attach(b, new THREE.Matrix4().makeTranslation(100, 0, -1738400));
    b.visible = false;
    style.set({ ...defaults, contours: true }); style.update(Infinity);
    expect(b.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    b.visible = true; style.update(Infinity);
    expect(a.geometry.getAttribute('surfaceHeightKm').array).toEqual(b.geometry.getAttribute('surfaceHeightKm').array);
    expect(a.geometry.getAttribute('surfaceHeightKm').getX(0)).toBeCloseTo(1);
    const heights = a.geometry.getAttribute('surfaceHeightKm').array.slice();
    a.position.set(1e9, -1e9, 1e9); a.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1);
    style.update(Infinity);
    expect(a.geometry.getAttribute('surfaceHeightKm').array).toEqual(heights);
    style.set({ ...defaults, contours: true, hillshade: true }); style.update(Infinity);
    style.set({ ...defaults, contours: true });
    expect(a.geometry.hasAttribute('surfaceGround')).toBe(true);
    expect(a.geometry.hasAttribute('surfaceReliefNormal')).toBe(false);
  });

  it('has no relief-normal perturbation on coarse and fine constant-height reference surfaces', () => {
    for (const shape of [{ kind: 'sphere' as const, radiusKm: 3396.19 }, datum.referenceShape]) {
      for (const segments of [4, 16]) {
        const reference = { ...datum, referenceShape: shape };
        const g = new THREE.SphereGeometry(1, segments, segments);
        const p = g.getAttribute('position');
        for (let j = 0; j < p.count; j++) {
          const direction = new THREE.Vector3().fromBufferAttribute(p, j).normalize();
          const radii = shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm;
          const r = 1000 / Math.hypot(direction.x / radii[0], direction.y / radii[1], direction.z / radii[2]);
          p.setXYZ(j, direction.x * r, direction.y * r, direction.z * r);
        }
        const tile = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
        const style = new SurfaceAppearance(reference);
        style.attach(tile, new THREE.Matrix4());
        style.set({ ...defaults, hillshade: true }); style.update(Infinity);
        // A reference ellipsoid has no topographic slope, regardless of its
        // triangulation or latitude. The fragment adds analytic local up.
        const correction = g.getAttribute('surfaceReliefNormal');
        for (let j = 0; j < correction.count; j++) {
          expect(Math.hypot(correction.getX(j), correction.getY(j), correction.getZ(j))).toBeLessThan(1e-5);
        }
      }
    }
  });

  it('defers cached hidden tiles and yields between visible tiles during activation', () => {
    const style = new SurfaceAppearance(datum), a = mesh(), b = mesh(), cached = mesh();
    cached.visible = false;
    for (const tile of [a, b, cached]) style.attach(tile, new THREE.Matrix4());
    style.set({ ...defaults, baseColor: 'elevation', hillshade: true });
    expect(a.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    expect(compile(a.material).fragmentShader).toBe(THREE.ShaderLib.standard.fragmentShader);
    const first = style.update(0);
    expect(first.meshes).toBe(1);
    expect(first.vertices).toBe(3);
    expect(b.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    style.update(Infinity);
    expect(b.geometry.hasAttribute('surfaceHeightKm')).toBe(true);
    expect(cached.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    cached.visible = true;
    style.update(Infinity);
    expect(cached.geometry.hasAttribute('surfaceHeightKm')).toBe(true);
    style.set({ ...defaults });
    expect(cached.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
  });

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
    style.attach(tile, new THREE.Matrix4().makeTranslation(3396190, 0, 0)); style.update(Infinity);
    expect(compile(tile.material).fragmentShader).toBe(THREE.ShaderLib.standard.fragmentShader);
    expect(tile.material.customProgramCacheKey()).toBe(originalKey);
    expect(tile.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    style.set({ ...defaults, baseColor: 'elevation' }); style.update(Infinity);
    expect(tile.geometry.getAttribute('surfaceHeightKm').getX(2)).toBeCloseTo(0.01, 4);
    expect(tile.geometry.getAttribute('position').array).toEqual(positions);
    style.set({ ...defaults }); style.update(Infinity);
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
    style.set({ ...defaults, hillshade: true, baseColor: 'elevation' }); style.update(Infinity);
    style.attach(tile, new THREE.Matrix4().makeTranslation(3396190, 0, 0)); style.update(Infinity);
    const shader = compile(tile.material);
    expect(shader.uniforms).toHaveProperty('overlaySentinel');
    expect(shader.fragmentShader).toContain('getShadowMask()');
    expect(shader.fragmentShader.indexOf('outgoingLight = diffuseColor.rgb')).toBeLessThan(shader.fragmentShader.indexOf('AerialPerspectiveResult _ap'));
    expect(shader.fragmentShader).toContain('normalize(saUp + vSAReliefNormal)');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mix');
    layers = 3;
    expect(tile.material.customProgramCacheKey()).toContain('overlay-3');
  });

  it('updates uniforms without recompilation and attaches settings to later streamed tiles', () => {
    const style = new SurfaceAppearance(datum), tile = mesh();
    style.set({ ...defaults, hillshade: true }); style.update(Infinity);
    style.attach(tile, new THREE.Matrix4().makeTranslation(0, 0, 3376200)); style.update(Infinity);
    const shader = compile(tile.material), version = tile.material.version;
    style.set({ ...defaults, hillshade: true, azimuthDeg: 90 }); style.update(Infinity);
    expect(tile.material.version).toBe(version);
    expect((shader.uniforms as Record<string, { value: THREE.Vector3 }>).saLight.value.x).toBeCloseTo(Math.SQRT1_2);
    expect(tile.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    expect(tile.geometry.hasAttribute('surfaceGround')).toBe(true);
    style.forget(tile);
    style.set({ ...defaults, baseColor: 'elevation' }); style.update(Infinity);
    expect(tile.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
  });

  it('separates terrain slopes from skirt walls without changing physical buffers', () => {
    const tile = mesh();
    tile.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 20, 0, 10, 0, 15, 0, 0, -10, 0, 20, -10, 10, 0, -10], 3));
    tile.geometry.setIndex([0, 1, 2, 3, 4, 5]);
    tile.geometry.addGroup(0, 3, 0);
    tile.geometry.addGroup(3, 3, 0);
    const style = new SurfaceAppearance(datum);
    style.set({ ...defaults, hillshade: true }); style.update(Infinity);
    style.attach(tile, new THREE.Matrix4()); style.update(Infinity);
    expect(Array.from(tile.geometry.getAttribute('surfaceGround').array)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(compile(tile.material).fragmentShader).toContain('normalize(saUp + vSAReliefNormal)');
    expect(compile(tile.material).fragmentShader).not.toContain('vSANormal');
    style.set({ ...defaults }); style.update(Infinity);
    expect(tile.geometry.hasAttribute('surfaceGround')).toBe(false);
    expect(Array.from(tile.geometry.index!.array)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('shares area-weighted normals across loaded tile edges and updates on eviction', () => {
    const style = new SurfaceAppearance(datum);
    style.set({ ...defaults, hillshade: true }); style.update(Infinity);
    const left = mesh(), right = mesh();
    left.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, -1, 0, 0], 3));
    // Small cross-LOD height differences must not prevent a shared geographic
    // edge from receiving one normal field (physical vertices remain separate).
    right.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 10, 1, 0, 11, 0, 1, 10], 3));
    const matrix = new THREE.Matrix4().makeTranslation(0, 0, 3376200);
    style.attach(left, matrix); style.attach(right, matrix); style.update(Infinity);
    const ln = left.geometry.getAttribute('surfaceReliefNormal'), rn = right.geometry.getAttribute('surfaceReliefNormal');
    const reconstructed = new THREE.Vector3(ln.getX(0), ln.getY(0), 1 + ln.getZ(0)).normalize();
    expect(reconstructed.x).toBeCloseTo(-1 / Math.sqrt(5));
    expect(reconstructed.z).toBeCloseTo(2 / Math.sqrt(5));
    expect(rn.getX(0)).toBe(ln.getX(0)); expect(rn.getZ(0)).toBe(ln.getZ(0));
    expect(rn.getX(2)).toBe(ln.getX(1));
    style.forget(right);
    expect(ln.getX(0)).toBeCloseTo(0); expect(ln.getZ(0)).toBeCloseTo(0);
    style.set({ ...defaults }); style.update(Infinity);
    expect(left.geometry.hasAttribute('surfaceReliefNormal')).toBe(false);
  });

  it('uses only visible LOD normal contributions through refinement and cached zoom-out', () => {
    const matrix = new THREE.Matrix4().makeTranslation(0, 0, 3376200);
    const make = (fine: boolean) => {
      const tile = mesh();
      tile.geometry.setAttribute('position', new THREE.Float32BufferAttribute(fine
        ? [0, 0, 10, 1, 0, 11, 0, 1, 10]
        : [0, 0, 0, 0, 1, 0, -1, 0, 0], 3));
      return tile;
    };
    const read = (tile: THREE.Mesh) => Array.from(tile.geometry.getAttribute('surfaceReliefNormal').array);
    const direct = (fine: boolean) => {
      const style = new SurfaceAppearance(datum), tile = make(fine);
      style.attach(tile, matrix); style.set({ ...defaults, hillshade: true }); style.update(Infinity);
      return read(tile);
    };
    const expectedFine = direct(true), expectedCoarse = direct(false);
    const style = new SurfaceAppearance(datum), coarse = make(false), fine = make(true);
    const fineParent = new THREE.Group(); fineParent.add(fine); fineParent.visible = false;
    style.attach(coarse, matrix); style.attach(fine, matrix);
    style.set({ ...defaults, hillshade: true }); style.update(Infinity);
    expect(read(coarse)).toEqual(expectedCoarse);
    for (let cycle = 0; cycle < 3; cycle++) {
      coarse.visible = false; fineParent.visible = true;
      style.update(Infinity);
      expect(read(fine)).toEqual(expectedFine);
      // Cached, already-prepared tiles must rejoin when visible, including
      // when the preparation budget has expired and no new work is allowed.
      coarse.visible = true; fineParent.visible = false;
      style.update(0);
      expect(read(coarse)).toEqual(expectedCoarse);
    }
    // Removing an inactive tile must not subtract its contribution twice.
    style.forget(fineParent);
    expect(read(coarse)).toEqual(expectedCoarse);
    style.set({ ...defaults });
    style.set({ ...defaults, hillshade: true }); style.update(Infinity);
    expect(read(coarse)).toEqual(expectedCoarse);
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
    (tm as unknown as { surfaceStyle: SurfaceAppearance }).surfaceStyle.update(Infinity);
    expect(tileMesh.geometry.getAttribute('surfaceHeightKm').getX(2)).toBeCloseTo(0.01, 4);
    expect(compile(tileMesh.material).fragmentShader).toContain('saTint');
    tiles.dispatchEvent({ type: 'dispose-model', scene, tile: {} });
    const version = tileMesh.material.version;
    tm.setSurfaceAppearance({ ...defaults, hillshade: true });
    expect(tileMesh.material.version).toBe(version);
  });
});

describe('cube surface/skirt topology', () => {
  it('excludes ungrouped skirt triangles from relief normals and inherits edge corrections', () => {
    const datum: TerrainDatum = { referenceShape: { kind: 'sphere', radiusKm: 1 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' };
    const build = (skirt: boolean) => {
      const g = new THREE.BufferGeometry();
      const points = [new THREE.Vector3(1000, 0, 0), new THREE.Vector3(1000, 10, 0), new THREE.Vector3(1002, 0, 10)];
      if (skirt) points.push(...points.map(p => p.clone().multiplyScalar(0.9).add(new THREE.Vector3(0, 0.0002, 0))));
      g.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap(p => p.toArray()), 3));
      g.setIndex(skirt ? [0, 1, 2, 0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5] : [0, 1, 2]);
      g.userData.surfaceTriangles = 1;
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
      const style = new SurfaceAppearance(datum); style.attach(mesh, new THREE.Matrix4());
      style.set({ ...defaults, hillshade: true }); style.update(Infinity);
      return g;
    };
    const ground = build(false), skirt = build(true);
    const a = ground.getAttribute('surfaceReliefNormal'), b = skirt.getAttribute('surfaceReliefNormal');
    for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) {
      expect(b.getComponent(i, c)).toBeCloseTo(a.getComponent(i, c), 6);
      expect(b.getComponent(i + 3, c)).toBeCloseTo(a.getComponent(i, c), 6);
    }
    expect([...skirt.getAttribute('surfaceGround').array]).toEqual([1, 1, 1, 0, 0, 0]);
  });
});

it('reconciles cube LOD ownership independently of hidden source meshes and detached cached scenes', () => {
  const style = new SurfaceAppearance(datum), coarse = mesh(), fine = mesh();
  const group = new THREE.Group(), coarseScene = new THREE.Group(), fineScene = new THREE.Group();
  coarseScene.add(coarse); fineScene.add(fine); group.add(coarseScene);
  // CubeImageryLayer hides the source while drawing blocks. The scene owns visibility.
  coarse.visible = false; fine.visible = false;
  fine.geometry.getAttribute('position').setZ(2, 100);
  style.attach(coarse, new THREE.Matrix4().makeTranslation(3396190, 0, 0), coarseScene);
  style.attach(fine, new THREE.Matrix4().makeTranslation(3396190, 0, 0), fineScene);
  style.set({ ...defaults, hillshade: true }); style.update(Infinity);
  const baseline = coarse.geometry.getAttribute('surfaceReliefNormal').array.slice();
  expect(fine.geometry.hasAttribute('surfaceReliefNormal')).toBe(false);
  for (let i = 0; i < 3; i++) {
    coarseScene.removeFromParent(); group.add(fineScene); style.update(Infinity);
    expect(fine.geometry.hasAttribute('surfaceReliefNormal')).toBe(true);
    fineScene.removeFromParent(); group.add(coarseScene); style.update(Infinity);
    expect(coarse.geometry.getAttribute('surfaceReliefNormal').array).toEqual(baseline);
  }
  style.forget(fineScene); style.update(Infinity);
  expect(coarse.geometry.getAttribute('surfaceReliefNormal').array).toEqual(baseline);
});
