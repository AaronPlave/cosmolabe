import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CubeImageryLayer } from '../CubeImageryLayer.js';
import { SurfaceAppearance, DEFAULT_SURFACE_APPEARANCE } from '../SurfaceAppearance.js';
import { cubeFaceToDirection, cubeTileId, type CubeFace } from '../surface/CubeSphere.js';
import { directionToTexel, imageryTileRect, type CubeImageryManifest, type ImageryAddress } from '../surface/CubeImagery.js';

const R = 1737.4e3; // metres, like the tile set
const faces: CubeFace[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const southPole = [0, 0, -1] as const;

/** All faces to level 1, then every tile to `deep` under the level-3 tile holding the south-pole corner. */
function manifest(deep = 9): CubeImageryManifest {
  const tiles: string[] = [];
  for (const face of faces) for (let level = 0; level <= 1; level++) for (let x = 0; x < 2 ** level; x++) for (let y = 0; y < 2 ** level; y++) tiles.push(cubeTileId({ face, level, x, y }));
  const root = directionToTexel(southPole, 3, 256, 4).address;
  for (let level = 2; level <= deep; level++) {
    const shift = level - 3;
    const k = 2 ** Math.max(0, shift);
    const x0 = shift >= 0 ? root.x * k : root.x >> -shift, y0 = shift >= 0 ? root.y * k : root.y >> -shift;
    for (let x = x0; x < x0 + k; x++) for (let y = y0; y < y0 + k; y++) tiles.push(cubeTileId({ face: 'nz', level, x, y }));
  }
  return { format: 'cosmolabe-cube-imagery-1', source: { id: 'test', kind: 'imagery', version: 'v1' }, bodyId: 'Moon',
    registration: { crsId: 'cosmolabe:cube-gnomonic-1/IAU_MOON', pixelConvention: 'corner', registrationErrorKm: 0, resampling: 'test', footprint: 'test' },
    tileSize: 256, gutter: 4, encoding: 'png', colorSpace: 'srgb', minLevel: 0, maxLevel: deep, uri: 'tiles/{face}/{level}/{x}/{y}.png', tiles };
}

/** A geometry tile like the cube product's: a lattice relative to its centre, the centre as the mesh translation. */
function geometryTile(a: ImageryAddress, n = 17): { scene: THREE.Group; mesh: THREE.Mesh } {
  const { u0, v0, size } = imageryTileRect(a);
  const abs: number[][] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) abs.push([...cubeFaceToDirection(a.face, u0 + size * i / (n - 1), v0 + size * j / (n - 1))].map(c => c * R));
  const centre = [0, 1, 2].map(c => abs.reduce((s, p) => s + p[c], 0) / abs.length);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(abs.flatMap(p => p.map((c, k) => c - centre[k]))), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(abs.flatMap(p => p.map(c => c / R))), 3));
  const index: number[] = [];
  for (let j = 0; j + 1 < n; j++) for (let i = 0; i + 1 < n; i++) { const k = j * n + i; index.push(k, k + 1, k + n + 1, k, k + n + 1, k + n); }
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.position.set(centre[0], centre[1], centre[2]);
  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, mesh };
}

/** A loader whose requests resolve or fail only when the test says so. */
function controlledLoader() {
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const aborted: string[] = [];
  const loadTexture = (url: string, signal: AbortSignal) => new Promise<{ texture: THREE.Texture; bytes: number; downloadBytes: number }>((resolve, reject) => {
    const id = /tiles\/(.*)\.png$/.exec(url)![1];
    signal.addEventListener('abort', () => { aborted.push(id); pending.delete(id); reject(new DOMException('Aborted', 'AbortError')); });
    pending.set(id, {
      resolve: () => { pending.delete(id); const t = new THREE.Texture(); t.name = id; resolve({ texture: t, bytes: 264 * 264 * 4 * 4 / 3, downloadBytes: 1000 }); },
      reject: (e) => { pending.delete(id); reject(e); },
    });
  });
  const settle = async (predicate: (id: string) => boolean = () => true, fail = false) => {
    for (const [id, p] of [...pending]) if (predicate(id)) { if (fail) p.reject(new Error('HTTP 503')); else p.resolve(); }
    await new Promise(r => setTimeout(r, 0));
  };
  return { loadTexture, pending, aborted, settle };
}

function camera(altitudeM: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 1.6, 1, 1e8);
  c.position.set(0, 0, -(R + altitudeM));
  c.up.set(0, 1, 0);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return c;
}

async function setup(options: Partial<ConstructorParameters<typeof CubeImageryLayer>[0]> = {}) {
  const loader = controlledLoader();
  const layer = new CubeImageryLayer({ url: 'http://test/imagery.json', ...options }, { fetchManifest: async () => manifest(), loadTexture: loader.loadTexture });
  await layer.ready;
  const tileSet = new THREE.Group(); // tile-set frame = world here
  const address = directionToTexel(southPole, 3, 256, 4).address; // a coarse geometry tile at the pole
  const { scene, mesh } = geometryTile(address);
  tileSet.add(scene);
  layer.addTile(scene, scene, address);
  const pixelAngle = 2 * Math.tan(Math.PI / 6) / 800;
  const tick = (cam: THREE.Camera, frames = 1) => { for (let i = 0; i < frames; i++) layer.update(cam, tileSet.matrixWorld, pixelAngle, null); };
  return { layer, loader, scene, mesh, address, tick, tileSet };
}

describe('CubeImageryLayer', () => {
  it('preserves source contour heights through imagery clipping, toggles and eviction', async () => {
    const style = new SurfaceAppearance({ referenceShape: { kind: 'sphere', radiusKm: R / 1000 }, heightConvention: 'radial', verticalDatum: 'reference-sphere' }, false);
    const tileSet = new THREE.Group(), loader = controlledLoader();
    const tracked = new Set<THREE.Mesh>();
    const layer = new CubeImageryLayer({ url: 'http://test/imagery.json' }, {
      fetchManifest: async () => manifest(), loadTexture: loader.loadTexture,
      meshLifecycle: {
        added(mesh) {
          // Copy exactly the source's body-fixed transform, excluding any world origin.
          mesh.updateWorldMatrix(true, false);
          style.attach(mesh, tileSet.matrixWorld.clone().invert().multiply(mesh.matrixWorld));
          tracked.add(mesh);
        },
        removing(mesh) { style.forget(mesh); tracked.delete(mesh); },
        beforeSplit(mesh) { style.prepareForDerivedMesh(mesh); },
      },
    });
    await layer.ready;
    const address = directionToTexel(southPole, 3, 256, 4).address;
    const { scene, mesh } = geometryTile(address, 5);
    mesh.geometry.userData.surfaceTriangles = mesh.geometry.index!.count / 3;
    // A coarse reference sphere: its chord interiors are below the datum, but
    // its interpolated source heights remain ~zero. Recomputing at imagery
    // clip vertices would invent many metres of false contour relief.
    tileSet.add(scene); layer.addTile(scene, scene, address);
    const tick = () => layer.update(camera(3_000), tileSet.matrixWorld, 2 * Math.tan(Math.PI / 6) / 800, null);
    style.set({ ...DEFAULT_SURFACE_APPEARANCE, contours: true, hillshade: true, baseColor: 'elevation' });
    expect(style.current).toMatchObject({ hillshade: false, baseColor: 'imagery', contours: true });
    for (let i = 0; i < 10; i++) { tick(); await loader.settle(); }
    const blocks = () => scene.children.filter(c => c.name.startsWith('cube-imagery-block')) as THREE.Mesh[];
    expect(blocks().length).toBeGreaterThan(1);
    for (const block of blocks()) {
      const heights = block.geometry.getAttribute('surfaceHeightKm');
      expect(heights).toBeDefined();
      for (let i = 0; i < heights.count; i++) expect(Math.abs(heights.getX(i))).toBeLessThan(0.00001);
      const material = block.material as THREE.Material;
      const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
      material.onBeforeCompile(shader as never, undefined as never);
      expect(shader.fragmentShader).toContain('cubeImageryTexel');
      expect(shader.fragmentShader).toContain('saContourLine');
      expect(shader.fragmentShader.indexOf('float saFootprint')).toBeGreaterThan(shader.fragmentShader.indexOf('diffuseColor.rgb = mix(diffuseColor.rgb, cubeImageryColor'));
    }
    layer.invalidateBlocks(); style.set({ ...DEFAULT_SURFACE_APPEARANCE }); tick();
    expect(blocks().length).toBeGreaterThan(0);
    for (const block of blocks()) expect(block.geometry.hasAttribute('surfaceHeightKm')).toBe(false);
    layer.invalidateBlocks(); style.set({ ...DEFAULT_SURFACE_APPEARANCE, contours: true }); tick();
    expect(blocks().every(b => b.geometry.hasAttribute('surfaceHeightKm'))).toBe(true);
    layer.removeTile(scene);
    expect(tracked.size).toBe(0);
    layer.dispose();
  });

  it('gives a tile the terrain draw cull hid resident imagery for other views, without splitting, requesting or counting it', async () => {
    const { layer, loader, scene, mesh, address, tick } = await setup();
    await loader.settle();
    // Refine while visible, so the tile is split and holds blocks.
    for (let round = 0; round < 10; round++) { tick(camera(5_000)); await loader.settle(); }
    expect(layer.stats.splitTiles).toBe(1);
    const requests = layer.stats.requests;
    const uniforms = (layer as unknown as { tiles: Map<object, { meshes: { uniforms: { cubeImageryEnabled: { value: number }; cubeImageryLevel: { value: number } } }[] }> })
      .tiles.get(scene)!.meshes[0].uniforms;
    uniforms.cubeImageryEnabled.value = 0; // as for a tile loaded while culled
    // Culled: the instrument view may draw it, so it gets imagery at its own level, whole.
    scene.visible = false;
    tick(camera(5_000), 3);
    expect(mesh.visible).toBe(true);
    expect(scene.children.filter(c => c.name.startsWith('cube-imagery-block') && c.visible)).toHaveLength(0);
    expect(uniforms.cubeImageryEnabled.value).toBe(1);
    expect(uniforms.cubeImageryLevel.value).toBeLessThanOrEqual(address.level);
    expect(layer.stats.tiles).toBe(0);
    expect(layer.stats.blocks).toBe(0);
    expect(layer.stats.queued).toBe(0);
    expect(layer.stats.inFlight).toBe(0);
    expect(layer.stats.requests).toBe(requests);
    scene.visible = true;
    tick(camera(5_000));
    expect(layer.stats.tiles).toBe(1);
    layer.dispose();
  });

  it('refines imagery far below a fixed coarse geometry tile, falling back while finer tiles load', async () => {
    const { layer, loader, scene, mesh, address, tick } = await setup({ maxConcurrentRequests: 4 });
    const positions = mesh.geometry.getAttribute('position');
    // Pinned coarse levels requested up front (levels 0–1 on every face).
    expect(layer.stats.inFlight).toBe(30);
    tick(camera(5_000));
    expect(layer.stats.untexturedBlocks).toBeGreaterThan(0); // nothing resident yet: untextured, not wrong
    await loader.settle();
    let deepest = -1;
    for (let round = 0; round < 40; round++) {
      tick(camera(5_000));
      expect(layer.stats.inFlight).toBeLessThanOrEqual(30 + 4);
      deepest = Math.max(deepest, layer.stats.maxDisplayedLevel);
      await loader.settle();
    }
    tick(camera(5_000));
    const s = layer.stats;
    expect(address.level).toBe(3);
    expect(s.maxDisplayedLevel).toBeGreaterThanOrEqual(7); // imagery 4+ levels deeper than geometry
    expect(s.fallbackBlocks).toBe(0);
    expect(s.splitTiles).toBe(1);
    expect(mesh.visible).toBe(false);
    // The geometry tile itself is untouched: same mesh, same buffer, same vertex count.
    expect(mesh.geometry.getAttribute('position')).toBe(positions);
    const blocks = scene.children.filter(c => c.name.startsWith('cube-imagery-block'));
    expect(blocks.length).toBe(s.blocks);
    // Blocks sit exactly where the original mesh does without waiting for a scene-graph
    // update: TilesGroup only propagates world matrices when the tile set moves.
    for (const b of blocks) expect(b.matrixWorld.equals(mesh.matrixWorld)).toBe(true);
    expect(s.extraDraws).toBe(s.blocks - 1);
    expect(s.blockGeometryBytes).toBeGreaterThan(0);
    // Moving away coarsens imagery without touching geometry; the tile draws whole again.
    tick(camera(2_000_000), 3);
    expect(layer.stats.splitTiles).toBe(0);
    expect(mesh.visible).toBe(true);
    expect(layer.stats.maxDisplayedLevel).toBeLessThan(3);
    // Blocks unused for 2 s are freed; removing the tile frees the rest.
    tick(camera(2_000_000), 125);
    expect(scene.children.filter(c => c.name.startsWith('cube-imagery-block'))).toHaveLength(0);
    layer.removeTile(scene);
    layer.dispose();
  });

  it('falls back to the nearest resident ancestor when a tile fails, and does not hammer it', async () => {
    const { layer, loader, tick } = await setup({ retryFailedMs: 60_000 });
    await loader.settle();
    const cam = camera(20_000);
    tick(cam);
    // Fail every level-4+ request.
    for (let i = 0; i < 6; i++) { await loader.settle(id => Number(id.split('/')[1]) >= 4, true); tick(cam); }
    const s = layer.stats;
    expect(s.failures).toBeGreaterThan(0);
    expect(s.failedTiles).toBeGreaterThan(0);
    expect(s.maxDisplayedLevel).toBeLessThanOrEqual(3);
    expect(s.untexturedBlocks).toBe(0); // coarse coverage remains usable
    expect(s.failedBlocks).toBeGreaterThan(0);
    expect(s.fallbackBlocks).toBe(0); // nothing is reported as still loading
    // Nothing below a failed tile is requested: one failure per failing branch, not per level.
    expect(s.failures).toBeLessThanOrEqual(s.blocks);
    const requests = s.requests;
    tick(cam, 20);
    expect(layer.stats.requests).toBe(requests); // failed tiles are not re-requested inside the retry window
    layer.retryFailed();
    tick(cam);
    expect(layer.stats.requests).toBeGreaterThan(requests);
    layer.dispose();
  });

  it('keeps textures within budget, evicting least recently used unpinned tiles', async () => {
    const tile = 264 * 264 * 4 * 4 / 3;
    const { layer, loader, tick } = await setup({ maxTextureBytes: 40 * tile, maxConcurrentRequests: 16 });
    await loader.settle();
    for (const altitude of [5_000, 50_000, 2_000, 400, 9_000, 1_000, 30_000]) {
      for (let round = 0; round < 10; round++) { tick(camera(altitude)); await loader.settle(); }
      const s = layer.stats;
      expect(s.pinnedTextures).toBe(30);
      expect(s.textureBytes).toBeLessThanOrEqual(40 * tile + 1);
    }
    expect(layer.stats.evicted).toBeGreaterThan(0);
    layer.dispose();
  });

  it('reserves budget for in-flight requests when completions are staggered', async () => {
    const tile = 264 * 264 * 4 * 4 / 3;
    const { layer, loader, tick } = await setup({ maxTextureBytes: 40 * tile, maxConcurrentRequests: 16 });
    await loader.settle();
    // Oblique over the nz/3/4/4 quadrant (nz: u = x/z, v = -y/z): many deep blocks in view at once.
    const oblique = (h: number) => {
      const c = new THREE.PerspectiveCamera(60, 1.6, 1, 1e8);
      c.position.set(-30_000, 30_000, -(R + h));
      c.lookAt(-30_000 - h, 30_000 + h, -R);
      c.updateMatrixWorld();
      return c;
    };
    for (let round = 0; round < 60; round++) {
      tick(oblique(round % 20 < 10 ? 3_000 : 800));
      // One completion per frame: requests started in earlier frames are still outstanding.
      const [first] = loader.pending.keys();
      if (first) await loader.settle(id => id === first);
      const s = layer.stats;
      expect(s.textureBytes + s.inFlight * tile).toBeLessThanOrEqual(40 * tile + 1);
    }
    layer.dispose();
  });

  it('aborts requests nobody wants any more and stays bounded under camera motion', async () => {
    const { layer, loader, tick } = await setup({ maxConcurrentRequests: 6 });
    await loader.settle();
    const low = new THREE.PerspectiveCamera(60, 1.6, 1, 1e8);
    low.position.set(-30_000, 30_000, -(R + 3_000)); // inside the nz/3/4/4 quadrant (nz: u = x/z, v = -y/z), several deep tiles in view
    low.lookAt(-30_000, 30_000, -R);
    low.updateMatrixWorld();
    tick(low);
    const inFlight = layer.stats.inFlight;
    expect(inFlight).toBeGreaterThan(1);
    expect(inFlight).toBeLessThanOrEqual(6);
    tick(camera(5_000_000), 31); // the wanted set collapses to the pinned levels
    expect(loader.aborted.length).toBe(inFlight);
    expect(layer.stats.inFlight).toBe(0);
    expect(layer.stats.aborted).toBe(inFlight);
    // Repeated back-and-forth never queues more than the wanted set nor exceeds concurrency.
    for (let i = 0; i < 30; i++) {
      tick(camera(i % 2 ? 500 : 50_000));
      expect(layer.stats.inFlight).toBeLessThanOrEqual(6);
      await loader.settle(() => Math.random() < 0.5);
    }
    layer.dispose();
    expect(loader.pending.size).toBe(0);
  });

  it('restores the original mesh while another debug view owns the materials', async () => {
    const { layer, loader, mesh, tileSet, scene } = await setup();
    await loader.settle();
    const pixelAngle = 2 * Math.tan(Math.PI / 6) / 800;
    for (let i = 0; i < 20; i++) { layer.update(camera(3_000), tileSet.matrixWorld, pixelAngle, null); await loader.settle(); }
    expect(mesh.visible).toBe(false);
    layer.update(camera(3_000), tileSet.matrixWorld, pixelAngle, null, false);
    expect(mesh.visible).toBe(true);
    expect(scene.children.filter(c => c.name.startsWith('cube-imagery-block') && c.visible)).toHaveLength(0);
    // A tile the renderer has detached is left alone (not counted, not requested for).
    scene.removeFromParent();
    layer.update(camera(3_000), tileSet.matrixWorld, pixelAngle, null);
    expect(layer.stats.tiles).toBe(0);
    layer.dispose();
  });

  it('builds blocks from the triangles the tile draws, and rebuilds them when that changes', async () => {
    const { layer, loader, mesh, scene, tick } = await setup();
    for (let i = 0; i < 20; i++) { tick(camera(3_000)); await loader.settle(); }
    const blockTriangles = () => scene.children.filter(c => c.name.startsWith('cube-imagery-block') && c.visible)
      .reduce((s, c) => s + (c as THREE.Mesh).geometry.index!.count / 3, 0);
    const all = blockTriangles();
    expect(all).toBeGreaterThan(0);
    // Hide the second half of the triangles, as TerrainManager hides skirts.
    const half = mesh.geometry.index!.count / 2;
    mesh.geometry.setDrawRange(0, half);
    layer.invalidateBlocks();
    expect(scene.children.filter(c => c.name.startsWith('cube-imagery-block'))).toHaveLength(0);
    tick(camera(3_000));
    const drawn = blockTriangles();
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(all);
    mesh.geometry.setDrawRange(0, Infinity);
    layer.invalidateBlocks();
    tick(camera(3_000));
    expect(blockTriangles()).toBe(all);
    layer.dispose();
  });
});
