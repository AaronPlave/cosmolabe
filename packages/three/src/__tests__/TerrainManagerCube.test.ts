import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerrainManager } from '../TerrainManager.js';
import type { CubeGridManifest } from '../surface/CubeSphereGrids.js';

/**
 * The experimental cube-sphere wiring (#149): with `cubeSphere.cpuGrids`, CPU
 * samples and ray queries come from the cube grids, which load by query
 * location, never from the renderer's tiles.
 */
const NO_RENDERER = undefined as unknown as THREE.WebGLRenderer;
const R = 1737.4, W = 5;
const BASE = 'https://example.invalid/cube/';

function manifest(): CubeGridManifest {
  const tiles: CubeGridManifest['tiles'] = (['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const).map(f => [f, 0, 0, 0, 0.001]);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) tiles.push(['nz', 1, x, y, 0.0005]);
  return {
    format: 'cosmolabe-cube-height-grid-1',
    datum: { referenceShape: { kind: 'sphere', radiusKm: R }, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    source: { id: 'cube-fixture', kind: 'height-grid', version: 'fixture-v1' },
    grid: { width: W, height: W, uri: 'heights/{face}/{level}/{x}/{y}.f32' },
    heightRangeKm: [0.1, 0.2],
    maxLevel: 1,
    tiles,
  };
}

function serve(): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('cpu-grids.json')) return new Response(JSON.stringify(manifest()));
    const level = Number(url.split('/heights/')[1].split('/')[1]);
    return new Response(new Float32Array(W * W).fill(100 * (level + 1)).buffer);
  }));
  return requested;
}

const make = (radiusKm = R) => new TerrainManager(
  { type: '3dtiles', url: `${BASE}tileset.json`, datum: { verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    cubeSphere: { cpuGrids: `${BASE}cpu-grids.json`, residentLevel: 0 } },
  radiusKm, NO_RENDERER,
);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('TerrainManager with cube-sphere CPU grids', () => {
  it('answers CPU samples from the grids, explicitly unloaded until they arrive', async () => {
    const requested = serve();
    const tm = make();
    expect(tm.sample(-90, 0)).toBeNull();
    expect(tm.cubeCoverage(-90, 0)).toMatchObject({ state: 'unloaded', residentLevel: null });
    await vi.waitFor(() => expect(tm.cubeStats?.residentTiles).toBe(6));
    expect(requested.filter(u => u.includes('/heights/'))).toHaveLength(6);
    expect(tm.cubeCoverage(-90, 0)).toMatchObject({ state: 'parent-fallback', residentLevel: 0, availableLevel: 1 });
    // The query itself requests the finer grid; the renderer is never involved.
    expect(tm.sample(-90, 0)).toMatchObject({ tileId: 'nz/0/0/0', elevationKm: expect.closeTo(0.1, 6), source: { version: 'fixture-v1' } });
    await vi.waitFor(() => expect(tm.cubeCoverage(-90, 0)?.state).toBe('finest'));
    expect(tm.sampleBodyFixed({ xKm: 0, yKm: 0, zKm: -(R + 5) })).toMatchObject({ tileId: 'nz/1/1/1', elevationKm: expect.closeTo(0.2, 6) });
    expect(tm.cpuDiagnostics).toMatchObject({ state: 'ready', tileCount: 7 });
    expect(tm.cpuSource.version).toBe('fixture-v1');
    expect(tm.metrics.tiles.cpu).toBe(7);
  });

  it('answers #148 ray queries from the grids and refines them on request', async () => {
    serve();
    const tm = make();
    const ray = { origin: { xKm: 0, yKm: 0, zKm: -(R + 10) }, direction: [0, 0, 1] as const, nearKm: 0, farKm: 20 };
    expect(tm.intersectSurfaceRay(ray, { maxMeshErrorKm: 0.001 })).toBeNull();
    await vi.waitFor(() => expect(tm.cubeStats?.residentTiles).toBe(6));
    expect(tm.intersectSurfaceRay(ray, { maxMeshErrorKm: 0.001 })).toMatchObject({ kind: 'hit', tileId: 'nz/0/0/0', detail: 'coarse' });
    await vi.waitFor(() => expect(tm.intersectSurfaceRay(ray, { maxMeshErrorKm: 0.001 })).toMatchObject({ kind: 'hit', tileId: expect.stringMatching(/^nz\/1\//) }));
  });

  it('refuses grids whose datum disagrees with the body, rather than sampling them', async () => {
    serve();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tm = make(3396.19);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(tm.sample(-90, 0)).toBeNull();
    expect(tm.cubeCoverage(-90, 0)?.state).toBe('unloaded');
    expect(tm.intersectSurfaceRay({ origin: { xKm: 0, yKm: 0, zKm: -4000 }, direction: [0, 0, 1], nearKm: 0, farKm: 1000 }, { maxMeshErrorKm: 1 })).toBeNull();
  });

  it('drops grids whose revision differs from the tileset\'s asset.tilesetVersion, before or after the tileset loads', async () => {
    serve();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    type Tiles = { rootTileset: object | null; dispatchEvent(e: { type: string }): void };
    // Tileset first, from another revision: the grids are never used.
    const early = make();
    (early as unknown as { tiles: Tiles }).tiles.rootTileset = { asset: { tilesetVersion: 'cube-other' } };
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(early.cubeStats?.version ?? null).toBeNull();
    expect(early.sample(-90, 0)).toBeNull();
    // Grids first: used until the mismatching tileset arrives, then dropped.
    const late = make();
    await vi.waitFor(() => expect(late.cubeStats?.residentTiles).toBe(6));
    const tiles = (late as unknown as { tiles: Tiles }).tiles;
    tiles.rootTileset = { asset: { tilesetVersion: 'cube-other' } };
    tiles.dispatchEvent({ type: 'load-root-tileset' });
    expect(late.sample(-90, 0)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    // The same revision (or a tileset that names none) keeps them.
    const same = make();
    (same as unknown as { tiles: Tiles }).tiles.rootTileset = { asset: { tilesetVersion: 'fixture-v1' } };
    await vi.waitFor(() => expect(same.cubeStats?.residentTiles).toBe(6));
    expect(same.sample(-90, 0)).not.toBeNull();
    for (const tm of [early, late, same]) tm.dispose();
  });

  it('draws only the tiles the main camera can see, and restores them before the next update', async () => {
    serve();
    const tm = make();
    const internals = tm as unknown as { tiles: { visibleTiles: Set<unknown> }; mainView: unknown; cullToMainView(): void };
    // Tile-set metres; the camera 3 radii out on +z, a 30° view of the body centre, no near/far planes.
    const r = R * 1000;
    const cam = new THREE.PerspectiveCamera(30, 1, 1, 10);
    cam.position.set(0, 0, 3 * r);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    frustum.planes[4].constant = frustum.planes[5].constant = Infinity;
    internals.mainView = { frustum, eye: cam.position.clone() };
    const tile = (x: number, y: number, z: number, visible = true) => {
      const scene = new THREE.Object3D();
      scene.visible = visible;
      const h = 0.02 * r;
      const points = [-h, h].flatMap((dx) => [-h, h].flatMap((dy) => [-h, h].map((dz) => new THREE.Vector3(x + dx, y + dy, z + dz))));
      return { engineData: { scene, boundingVolume: { obb: { points } } } };
    };
    const front = tile(0, 0, r), beside = tile(r, 0, 0.1 * r), farSide = tile(0, 0, -r), fadingOut = tile(r, 0, 0.1 * r, false);
    for (const t of [front, beside, farSide, fadingOut]) internals.tiles.visibleTiles.add(t);

    // Before the CPU-grid manifest gives a validated lower surface bound, only the frustum culls.
    internals.cullToMainView();
    expect(beside.engineData.scene.visible).toBe(false);
    expect(farSide.engineData.scene.visible).toBe(true);
    tm.showCulledTiles();
    await vi.waitFor(() => expect(tm.cubeStats?.residentTiles).toBe(6));

    internals.cullToMainView();
    expect(front.engineData.scene.visible).toBe(true);
    expect(beside.engineData.scene.visible).toBe(false); // outside the main frustum
    expect(farSide.engineData.scene.visible).toBe(false); // in it, but behind the body
    expect(fadingOut.engineData.scene.visible).toBe(false);
    // Restoring shows what the cull hid, and nothing another owner (TilesFadePlugin) hid.
    tm.showCulledTiles();
    expect(beside.engineData.scene.visible).toBe(true);
    expect(farSide.engineData.scene.visible).toBe(true);
    expect(fadingOut.engineData.scene.visible).toBe(false);
    // Turned off, the cull leaves everything drawn.
    internals.cullToMainView();
    tm.setDrawCulling(false);
    expect(beside.engineData.scene.visible).toBe(true);
    tm.dispose();
  });
});

describe('known cube-sphere surface appearance capability', () => {
  type Tiles = { rootTileset: object | null; dispatchEvent(e: object): void; group: THREE.Group };
  function root(tm: TerrainManager, asset: object = {}) {
    const tiles = (tm as unknown as { tiles: Tiles }).tiles;
    tiles.rootTileset = { asset: { generator: 'scripts/terrain/dem.py cube-tile', tilesetVersion: 'fixture-v1', ...asset } };
    tiles.dispatchEvent({ type: 'load-root-tileset' });
    return tiles;
  }
  function serveKnown(change: (m: CubeGridManifest) => void = () => {}) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const m = manifest();
      m.grid.encoding = 'float32 little-endian, metres above the reference sphere';
      change(m);
      return url.endsWith('.json') ? new Response(JSON.stringify(m)) : new Response(new Float32Array(W * W).fill(100).buffer);
    }));
  }

  it('waits for matching metadata, then styles both delayed and already loaded glTF meshes without changing physical buffers', async () => {
    serveKnown();
    const tm = make();
    expect(tm.surfaceAppearance).toBeNull();
    const tiles = (tm as unknown as { tiles: Tiles }).tiles;
    // glTF Y up -> tileset Z north. An arbitrary world/camera transform must be excluded.
    tiles.group.position.set(9e9, 2e8, 3e7); tiles.group.scale.setScalar(0.0002);
    const scene = new THREE.Group(); scene.rotation.x = Math.PI / 2;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 0, 10], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2]); g.userData.surfaceTriangles = 1;
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial()); mesh.position.y = R * 1000 + 100;
    scene.add(mesh); tiles.group.add(scene);
    const before = ['position', 'normal'].map(n => g.getAttribute(n).array.slice());
    tiles.dispatchEvent({ type: 'load-model', scene, tile: {} });
    await vi.waitFor(() => expect(tm.cubeStats?.version).toBe('fixture-v1'));
    expect(tm.surfaceAppearance).toBeNull();
    const cpuSample = tm.sample(0, 0);
    root(tm);
    expect(tm.surfaceAppearanceDatum).toEqual(manifest().datum);
    tm.setSurfaceAppearance({ ...tm.surfaceAppearance!, baseColor: 'elevation', hillshade: true });
    const style = (tm as unknown as { surfaceStyle: { update(n: number): void } }).surfaceStyle;
    style.update(Infinity);
    for (let i = 0; i < 3; i++) expect(g.getAttribute('surfaceHeightKm').getX(i)).toBeCloseTo(0.1, 5);
    expect(['position', 'normal'].map(n => g.getAttribute(n).array)).toEqual(before);
    expect(tm.sample(0, 0)).toEqual(cpuSample);
    const late = scene.clone();
    (late.children[0] as THREE.Mesh).geometry = g.clone();
    for (const name of ['surfaceHeightKm', 'surfaceReliefNormal', 'surfaceGround']) (late.children[0] as THREE.Mesh).geometry.deleteAttribute(name);
    tiles.group.add(late); tiles.dispatchEvent({ type: 'load-model', scene: late, tile: {} });
    style.update(Infinity);
    expect((late.children[0] as THREE.Mesh).geometry.hasAttribute('surfaceHeightKm')).toBe(true);
    for (const invalid of ['scale', 'topology', 'height']) {
      const scene = late.clone(), mesh = scene.children[0] as THREE.Mesh;
      mesh.geometry = g.clone();
      for (const name of ['surfaceHeightKm', 'surfaceReliefNormal', 'surfaceGround']) mesh.geometry.deleteAttribute(name);
      if (invalid === 'scale') mesh.scale.setScalar(1000);
      if (invalid === 'topology') mesh.geometry.userData = {};
      if (invalid === 'height') mesh.position.y += 100000;
      tiles.group.add(scene); tiles.dispatchEvent({ type: 'load-model', scene, tile: {} }); style.update(Infinity);
      expect(mesh.geometry.hasAttribute('surfaceHeightKm'), invalid).toBe(false);
    }
    tm.dispose();
  });

  it.each([
    ['generic generator', { generator: 'unknown' }, (_m: CubeGridManifest) => {}],
    ['missing revision', { tilesetVersion: undefined }, (_m: CubeGridManifest) => {}],
    ['wrong revision', { tilesetVersion: 'other' }, (_m: CubeGridManifest) => {}],
    ['unknown encoding', {}, (m: CubeGridManifest) => { m.grid.encoding = 'unknown'; }],
    ['unsupported datum', {}, (m: CubeGridManifest) => { m.datum.verticalDatum = 'unknown'; }],
  ])('excludes %s', async (_name, asset, change) => {
    serveKnown(change); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tm = make(); root(tm, asset);
    await new Promise(r => setTimeout(r, 30));
    expect(tm.surfaceAppearance).toBeNull(); tm.dispose();
  });
});
