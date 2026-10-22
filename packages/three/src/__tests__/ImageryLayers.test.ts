import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultLayerName, describeImageryLayers, overlapsBounds, layerStatus, nativeMetersPerPixel,
  reorderedLayers, resolveGlobeSurfaceConfig,
} from '../ImageryLayers.js';
import { TerrainManager, fallBackToParentTiles, tileInMainView, type TerrainConfig } from '../TerrainManager.js';
import { makeShadowUniforms } from '../EclipseShadow.js';

const MARS_EQ_KM = 3396.19;
const VIKING = 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg';
const CTX = 'https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{y}/{x}';
const HIRISE = 'https://trek.nasa.gov/tiles/Mars/EQ/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd/1.0.0/default/default028mm/{z}/{y}/{x}.png';

describe('resolveGlobeSurfaceConfig', () => {
  const qm = { type: 'quantized-mesh', url: 'https://example.invalid/terrain/' };

  it('leaves terrain-only catalogs as written', () => {
    const terrain = { ...qm, imagery: { url: VIKING } };
    expect(resolveGlobeSurfaceConfig({ terrain })).toBe(terrain);
  });

  it('renders sibling imagery on the ellipsoid when there is no terrain', () => {
    expect(resolveGlobeSurfaceConfig({ imagery: { url: VIKING, levels: 8 } })).toEqual({
      type: 'imagery', imagery: [{ url: VIKING, levels: 8 }],
    });
  });

  it('drapes sibling imagery on terrain without touching the catalog object', () => {
    const geometry = { terrain: { ...qm }, imagery: [{ url: VIKING }, { url: HIRISE, bounds: [77.22, 18.31, 77.58, 18.67] }] };
    const cfg = resolveGlobeSurfaceConfig(geometry)!;
    expect(cfg.type).toBe('quantized-mesh');
    expect(cfg.url).toBe(qm.url);
    expect(cfg.imagery).toHaveLength(2);
    expect((geometry.terrain as TerrainConfig).imagery).toBeUndefined();
  });

  it('lets an imagery-typed terrain block carry tuning for the sibling stack', () => {
    const cfg = resolveGlobeSurfaceConfig({ terrain: { type: 'imagery', showAtPixels: 120 }, imagery: [{ url: VIKING }] })!;
    expect(cfg).toMatchObject({ type: 'imagery', showAtPixels: 120, imagery: [{ url: VIKING }] });
  });

  it('prefers the sibling stack over terrain.imagery and says so', () => {
    const warnings: string[] = [];
    const cfg = resolveGlobeSurfaceConfig({ terrain: { ...qm, imagery: { url: CTX } }, imagery: { url: VIKING } }, (m) => warnings.push(m))!;
    expect(cfg.imagery).toEqual([{ url: VIKING }]);
    expect(warnings).toHaveLength(1);
  });

  it('returns null for a Globe with nothing to stream', () => {
    expect(resolveGlobeSurfaceConfig({})).toBeNull();
    expect(resolveGlobeSurfaceConfig({ terrain: { type: 'imagery' } })).toBeNull();
    expect(resolveGlobeSurfaceConfig({ terrain: { type: 'quantized-mesh' } })).toBeNull();
    expect(resolveGlobeSurfaceConfig({ imagery: [{ url: '' }, { levels: 3 }] })).toBeNull();
    expect(resolveGlobeSurfaceConfig({ terrain: { type: 'cesium-ion', cesiumIonAssetId: 0 } })?.type).toBe('cesium-ion');
  });
});

describe('describeImageryLayers', () => {
  it('names layers after the product in the tile URL', () => {
    expect(defaultLayerName({ url: VIKING })).toBe('Mars_Viking_MDIM21_ClrMosaic_global_232m');
    expect(defaultLayerName({ url: CTX })).toBe('CTX');
    expect(defaultLayerName({ url: 'https://tiles.example.org/{z}/{x}/{y}.png' })).toBe('tiles.example.org');
    expect(defaultLayerName({ type: 'wmts-capabilities', url: 'https://gibs/x.xml', layer: 'BlueMarble' })).toBe('BlueMarble');
  });

  it('keeps the base always on and honours catalog visibility for overlays', () => {
    const layers = describeImageryLayers([
      { url: VIKING, visible: false, name: 'Viking' },
      { url: CTX, minZoom: 5, levels: 14, dimension: 512 },
      { url: HIRISE, visible: false, opacity: 2, bounds: [77.22, 18.31, 77.58, 18.67] },
    ], MARS_EQ_KM);
    expect(layers.map((l) => [l.id, l.role, l.optional, l.visible])).toEqual([
      ['layer-0', 'base', false, true],
      ['layer-1', 'overlay', true, true],
      ['layer-2', 'overlay', true, false],
    ]);
    expect(layers[0].name).toBe('Viking');
    expect(layers[1].attribution).toBe('astro.arcgis.com');
    expect(layers[1]).toMatchObject({ minZoom: 5, maxLevel: 13, bounds: null });
    expect(layers[2].opacity).toBe(1);
    expect(layers[2].bounds).toEqual([77.22, 18.31, 77.58, 18.67]);
  });

  it('keeps ids unique', () => {
    const ids = describeImageryLayers([{ url: VIKING, id: 'a' }, { url: CTX, id: 'a' }], MARS_EQ_KM).map((l) => l.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('estimates native resolution from the tile pyramid', () => {
    // 8 levels of 256 px EPSG:4326 tiles: 2·2^7 tiles across the equator.
    expect(nativeMetersPerPixel({ url: VIKING, levels: 8 }, MARS_EQ_KM)).toBeCloseTo(2 * Math.PI * MARS_EQ_KM * 1000 / (256 * 256), 6);
    // Web Mercator starts from one tile.
    expect(nativeMetersPerPixel({ url: VIKING, levels: 8, projection: 'EPSG:3857' }, MARS_EQ_KM))
      .toBeCloseTo(2 * nativeMetersPerPixel({ url: VIKING, levels: 8 }, MARS_EQ_KM)!, 6);
    expect(nativeMetersPerPixel({ url: 'x', type: 'wmts-capabilities' }, MARS_EQ_KM)).toBeNull();
  });
});

describe('layer helpers', () => {
  it('derives status from requests and failures', () => {
    expect(layerStatus(0, 0)).toBe('idle');
    expect(layerStatus(10, 0)).toBe('ok');
    expect(layerStatus(10, 3)).toBe('partial');
    expect(layerStatus(4, 4)).toBe('failed');
    expect(layerStatus(0, 1)).toBe('failed');
    expect(layerStatus(10, 0, true)).toBe('failed');
  });

  it('tests coverage, including boxes across the antimeridian', () => {
    const r = Math.PI / 180;
    const tile = (w: number, s: number, e: number, n: number) => [w * r, s * r, e * r, n * r];
    const hirise: [number, number, number, number] = [77.22, 18.31, 77.58, 18.67];
    expect(overlapsBounds(tile(-180, -90, 180, 90), null)).toBe(true);
    expect(overlapsBounds(tile(77, 18, 78, 19), hirise)).toBe(true);
    // Off-centre: only the tile's corner reaches the box.
    expect(overlapsBounds(tile(77.5, 18.6, 80, 22), hirise)).toBe(true);
    expect(overlapsBounds(tile(78, 18, 79, 19), hirise)).toBe(false);
    expect(overlapsBounds(tile(77, 19, 78, 20), hirise)).toBe(false);
    expect(overlapsBounds(tile(175, -5, 180, 5), [170, -10, -170, 10])).toBe(true);
    expect(overlapsBounds(tile(-180, -5, -175, 5), [170, -10, -170, 10])).toBe(true);
    expect(overlapsBounds(tile(-10, -5, 10, 5), [170, -10, -170, 10])).toBe(false);
  });

  it('reorders overlays but never moves the base', () => {
    const l = [{ id: 'b', role: 'base' as const }, { id: 'o1', role: 'overlay' as const }, { id: 'o2', role: 'overlay' as const }];
    expect(reorderedLayers(l, 2, 1)!.map((x) => x.id)).toEqual(['b', 'o2', 'o1']);
    expect(reorderedLayers(l, 2, 0)!.map((x) => x.id)).toEqual(['b', 'o2', 'o1']);
    expect(reorderedLayers(l, 0, 2)).toBeNull();
    expect(reorderedLayers(l, 1, 1)).toBeNull();
    expect(reorderedLayers(l, 5, 1)).toBeNull();
  });
});

/**
 * The runtime layer controls against the real ImageOverlayPlugin. No GL
 * context here: the plugin only uses the renderer when compositing, which
 * needs loaded tiles, and none load in this environment.
 */
describe('TerrainManager imagery layer controls', () => {
  const NO_RENDERER = undefined as unknown as THREE.WebGLRenderer;
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  const make = (over: Partial<TerrainConfig> = {}) => new TerrainManager({
    type: 'imagery',
    imagery: [
      { url: VIKING, levels: 8 },
      { url: CTX, levels: 14, dimension: 512, minZoom: 5, id: 'ctx' },
      { url: HIRISE, levels: 17, minZoom: 9, bounds: [77.22, 18.31, 77.58, 18.67], id: 'hirise', visible: false },
    ],
    ...over,
  }, [3396.19, 3396.19, 3376.2], NO_RENDERER);

  type Plugin = { overlays: Array<{ opacity: number }>; overlayInfo: Map<object, { order: number }> };
  const plugin = (tm: TerrainManager) => (tm.tiles as unknown as { getPluginByName(n: string): Plugin }).getPluginByName('IMAGE_OVERLAY_PLUGIN');
  const dispatch = (tm: TerrainManager, e: Record<string, unknown>) => (tm.tiles as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(e);

  it('rejects legacy cube imagery combined with a geographic stack explicitly', () => {
    expect(() => make({ type: '3dtiles', url: 'https://example.invalid/tileset.json',
      cubeSphere: { cpuGrids: 'https://example.invalid/grids.json', imagery: { url: 'https://example.invalid/imagery.json' } },
    })).toThrow('Legacy cube imagery cannot be combined with geographic imagery');
  });

  it('only builds overlays for layers that start on', async () => {
    const tm = make();
    await flush();
    expect(plugin(tm).overlays).toHaveLength(1);
    expect(tm.imageryLayers.map((l) => [l.id, l.visible])).toEqual([['layer-0', true], ['ctx', true], ['hirise', false]]);
    expect(tm.metrics.imagery).toMatchObject({ layers: 3, activeOverlays: 1, overlayResolution: 256 });
    tm.dispose();
  });

  it('adds and removes overlays as layers are switched', async () => {
    const tm = make();
    await flush();
    expect(tm.setImageryLayerVisible('hirise', true)).toBe(true);
    await flush();
    expect(plugin(tm).overlays).toHaveLength(2);
    expect(tm.setImageryLayerVisible('ctx', false)).toBe(true);
    expect(plugin(tm).overlays).toHaveLength(1);
    expect(tm.setImageryLayerVisible('layer-0', false)).toBe(false);
    expect(tm.setImageryLayerVisible('nope', true)).toBe(false);
    tm.dispose();
  });

  it('drops an enable that is switched off before its overlay is ready', async () => {
    const tm = make();
    await flush();
    tm.setImageryLayerVisible('hirise', true);
    tm.setImageryLayerVisible('hirise', false);
    await flush();
    expect(plugin(tm).overlays).toHaveLength(1);
    tm.dispose();
  });

  it('sets opacity live and reorders overlays above the base', async () => {
    const tm = make();
    await flush();
    tm.setImageryLayerVisible('hirise', true);
    await flush();
    expect(tm.setImageryLayerOpacity('ctx', 0.25)).toBe(true);
    expect(plugin(tm).overlays.map((o) => o.opacity).sort()).toEqual([0.25, 1]);
    // The imagery-only base is geometry, not an overlay.
    expect(tm.setImageryLayerOpacity('layer-0', 0.5)).toBe(false);

    expect(tm.moveImageryLayer('hirise', 1)).toBe(true);
    expect(tm.imageryLayers.map((l) => l.id)).toEqual(['layer-0', 'hirise', 'ctx']);
    const orders = [...plugin(tm).overlayInfo.values()].map((i) => i.order).sort();
    expect(orders).toEqual([1, 2]);
    expect(tm.moveImageryLayer('layer-0', 2)).toBe(false);
    tm.dispose();
  });

  it('attributes failures to their layer and falls back when the stream fails', async () => {
    const tm = make();
    await flush();
    const [ctxOverlay] = plugin(tm).overlays;
    dispatch(tm, { type: 'load-error', tile: {}, overlay: ctxOverlay, error: new Error('404'), url: null });
    expect(tm.imageryLayers.find((l) => l.id === 'ctx')).toMatchObject({ failedTiles: 1, status: 'failed' });
    expect(tm.hasStreamFailed()).toBe(false);

    for (let i = 0; i < 4; i++) dispatch(tm, { type: 'load-error', tile: {}, error: new Error('404'), url: 'x' });
    expect(tm.imageryLayers[0].failedTiles).toBe(4);
    expect(tm.hasStreamFailed()).toBe(true);
    expect(tm.isReadyToShow()).toBe(false);
    tm.dispose();
  });

  it('calls a single failure dead only once nothing is left in flight for a while', async () => {
    const tm = make();
    await flush();
    const stats = (tm.tiles as unknown as { stats: Record<string, number> }).stats;
    dispatch(tm, { type: 'load-error', tile: {}, error: new Error('404'), url: 'x' });
    const t = performance.now();
    Object.assign(stats, { queued: 1, downloading: 0, parsing: 0 });
    expect(tm.hasStreamFailed(t + 10_000)).toBe(false);
    Object.assign(stats, { queued: 0 });
    expect(tm.hasStreamFailed(t + 1000)).toBe(false);
    expect(tm.hasStreamFailed(t + 3500)).toBe(true);
    // Any tile that loaded means the stream works; failures are just gaps.
    dispatch(tm, { type: 'load-model', scene: new THREE.Group(), tile: {} });
    expect(tm.hasStreamFailed(t + 10_000)).toBe(false);
    tm.dispose();
  });

  it('reads an XYZ base as equirectangular unless told otherwise, as overlays are', async () => {
    const baseProjection = async (tm: TerrainManager) => {
      await flush();
      const base = (tm.tiles as unknown as { getPluginByName(n: string): { imageSource: { projection: string } } }).getPluginByName('XYZ_TILES_PLUGIN');
      return base.imageSource.projection;
    };
    const trek = make();
    const gibs = make({ imagery: { url: VIKING, levels: 8, projection: 'EPSG:3857' } });
    expect([await baseProjection(trek), await baseProjection(gibs)]).toEqual(['EPSG:4326', 'EPSG:3857']);
    [trek, gibs].forEach((tm) => tm.dispose());
  });

  it('reports each shown overlay against the tiles in view, not the camera sub-point', async () => {
    const tm = make();
    tm.setImageryLayerVisible('hirise', true);
    await flush();
    type Overlay = { calculateLevel(r: number[]): number };
    const overlays = (tm as unknown as { activeOverlays: Map<string, Overlay> }).activeOverlays;
    const tileInfo = (id: string) => (plugin(tm) as unknown as { overlayInfo: Map<unknown, { tileInfo: Map<object, unknown> }> }).overlayInfo.get(overlays.get(id))!.tileInfo;
    for (const id of ['ctx', 'hirise']) overlays.get(id)!.calculateLevel = (r) => (r[2] - r[0] < 0.01 ? 6 : 3);
    // Normalized equirectangular ranges: a southwestern quarter, and a sliver
    // whose corner reaches Jezero though its centre lies outside the HiRISE box.
    const lonX = (lon: number) => (lon + 180) / 360, latY = (lat: number) => (lat + 90) / 180;
    const far = {}, near = {};
    const ranges = new Map([[far, [0, 0, 0.5, 0.5]], [near, [lonX(77.5), latY(18.6), lonX(78.5), latY(18.8)]]]);
    for (const id of ['ctx', 'hirise']) for (const [t, range] of ranges) tileInfo(id).set(t, { range, failed: false });
    const visible = (tm.tiles as unknown as { visibleTiles: Set<object> }).visibleTiles;
    const view = () => Object.fromEntries(tm.imageryLayers.map((l) => [l.id, l.view && { in: l.view.inCoverage, z: l.view.zoomLevel }]));

    // Nothing drawn yet: no verdict, rather than "out of view".
    expect(view().ctx).toBeNull();
    visible.add(far);
    expect(view()).toEqual({ 'layer-0': null, ctx: { in: true, z: 3 }, hirise: { in: false, z: null } });
    visible.add(near);
    expect(view().hirise).toEqual({ in: true, z: 6 });

    // A failed source tile in view counts as degraded; one elsewhere does not.
    const degraded = (tm as unknown as { degradedTiles: Map<string, Set<string>> }).degradedTiles;
    // Level 6 is 128 × 64 tiles, y from the north: Jezero's sliver is x 91, y 25.
    degraded.set('ctx', new Set(['6/91/25', '6/0/0']));
    (tileInfo('ctx').get(near) as { failed: boolean }).failed = true;
    expect(tm.imageryLayers.find((l) => l.id === 'ctx')!.view).toMatchObject({ degradedTiles: 1, missingTiles: 1, cacheFull: false });
    // A full cache stops refinement; the view says so, so "Zoom in" is not blamed on the camera.
    tm.tiles.lruCache.maxBytesSize = 0;
    expect(tm.imageryLayers.find((l) => l.id === 'ctx')!.view!.cacheFull).toBe(true);
    tm.dispose();
  });

  it('forgets degraded source tiles when a layer is rebuilt, and when one loads on retry', async () => {
    const tm = make();
    await flush();
    type Source = { fetchItem(t: number[], s?: AbortSignal): Promise<THREE.Texture> };
    type Overlay = { calculateLevel(r: number[]): number; imageSource: Source };
    const overlays = (tm as unknown as { activeOverlays: Map<string, Overlay> }).activeOverlays;
    const degraded = (tm as unknown as { degradedTiles: Map<string, Set<string>> }).degradedTiles;
    degraded.get('ctx')!.add('6/91/25');

    // Source tile 6/91/25 fails once, then loads. Its parent always loads.
    let failNext = true;
    const proto = Object.getPrototypeOf(overlays.get('ctx')!.imageSource) as Source;
    const fetchItem = vi.spyOn(proto, 'fetchItem').mockImplementation(async ([, , level]) => {
      if (level === 6 && failNext) { failNext = false; throw new Error('undecodable'); }
      return new THREE.Texture({ width: 512, height: 512, close() {} } as unknown as ImageBitmap);
    });
    const g = globalThis as unknown as { createImageBitmap: unknown };
    const saved = g.createImageBitmap;
    g.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    try {
      tm.setImageryLayerVisible('ctx', false);
      tm.setImageryLayerVisible('ctx', true);
      await flush();
      const ctx = overlays.get('ctx')!;
      ctx.calculateLevel = () => 6;
      const tile = {};
      const lonX = (lon: number) => (lon + 180) / 360, latY = (lat: number) => (lat + 90) / 180;
      (plugin(tm) as unknown as { overlayInfo: Map<unknown, { tileInfo: Map<object, unknown> }> }).overlayInfo.get(ctx)!
        .tileInfo.set(tile, { range: [lonX(77.5), latY(18.6), lonX(78.5), latY(18.8)], failed: false });
      (tm.tiles as unknown as { visibleTiles: Set<object> }).visibleTiles.add(tile);
      const degradedInView = () => tm.imageryLayers.find((l) => l.id === 'ctx')!.view!.degradedTiles;

      expect(degradedInView()).toBe(0);
      await ctx.imageSource.fetchItem([91, 25, 6]);
      expect(degradedInView()).toBe(1);
      await ctx.imageSource.fetchItem([91, 25, 6]);
      expect(degradedInView()).toBe(0);
    } finally {
      fetchItem.mockRestore();
      g.createImageBitmap = saved;
      tm.dispose();
    }
  });

  it('counts a tile in the main view only when inside the frustum and not wholly behind the horizon sphere', () => {
    // Camera 3 radii out on +z, looking at the origin with a 30° field of view; terrain above radius 0.99.
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 10);
    cam.position.set(0, 0, 3);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const box = (x: number, y: number, z: number, h = 0.05) => ({
      obb: { points: [-h, h].flatMap((dx) => [-h, h].flatMap((dy) => [-h, h].map((dz) => new THREE.Vector3(x + dx, y + dy, z + dz)))) },
    });
    const sphere = (x: number, y: number, z: number) => ({ sphere: new THREE.Sphere(new THREE.Vector3(x, y, z), 0.05) });
    const eye = cam.position, r = 0.99;
    expect(tileInMainView(box(0, 0, 1), frustum, eye, r)).toBe(true); // facing, centre of view
    expect(tileInMainView(box(0, 0, -1), frustum, eye, r)).toBe(false); // in the frustum, behind the globe
    expect(tileInMainView(box(1, 0, 0.1), frustum, eye, r)).toBe(false); // facing, off screen
    expect(tileInMainView(sphere(0, 0, 1), frustum, eye, r)).toBe(true);
    // Spheres get the frustum test only: no corners to bound the horizon with.
    expect(tileInMainView(sphere(0, 0, -1), frustum, eye, r)).toBe(true);
    // A peak beyond its own tangent plane but above the horizon of the sphere below all terrain stays.
    // (radius 1.0 at z 0.3: below its own tangent plane as seen from z 3, outside the 0.99 sphere's shadow cone)
    const peak = box(Math.sqrt(1 - 0.09), 0, 0.3, 0.002);
    expect(peak.obb.points.every((v) => new THREE.Vector3().subVectors(eye, v).dot(v) < 0)).toBe(true);
    expect(tileInMainView(peak, new THREE.Frustum(), eye, r)).toBe(true);
    // Just past the limb and below the horizon sphere: hidden.
    expect(tileInMainView(box(0.6, 0, -0.6, 0.01), new THREE.Frustum(), eye, r)).toBe(false);
    // A camera inside the sphere hides nothing.
    expect(tileInMainView(box(0, 0, -1), new THREE.Frustum(), new THREE.Vector3(0, 0, 0.5), r)).toBe(true);
  });

  describe('coverage before the static→streamed swap', () => {
    // An imagery-only root: no content, two level-0 tiles that carry it.
    const tile = (loadingState: number, inFrustum = true) => ({ internal: { hasContent: true, loadingState }, traversal: { inFrustum }, children: [] });
    const withRoot = async (...level0: ReturnType<typeof tile>[]) => {
      const tm = make();
      await flush();
      Object.defineProperty(tm.tiles, 'root', { value: { internal: { hasContent: false, loadingState: 4 }, children: level0 } });
      Object.assign((tm.tiles as unknown as { stats: Record<string, number> }).stats, { visible: 1, queued: 0, downloading: 0, parsing: 0 });
      return tm;
    };

    it('keeps the static surface until visible cube blocks have resident imagery', async () => {
      const tm = await withRoot(tile(4));
      const stats = { ready: true, tiles: 1, untexturedBlocks: 1, baseUncoveredBlocks: 0 };
      Object.defineProperty(tm, 'cubeImagery', { value: { stats }, configurable: true });
      expect(tm.isReadyToShow(10_000)).toBe(false);
      stats.untexturedBlocks = 0;
      expect(tm.isReadyToShow(10_001)).toBe(true);
      stats.baseUncoveredBlocks = 1; // valid base manifest, missing base texture
      expect(tm.isReadyToShow(10_002)).toBe(false);
      stats.baseUncoveredBlocks = 0;
      expect(tm.isReadyToShow(10_003)).toBe(true);
      // Resident optional pixels cannot compensate for a failed mandatory base.
      stats.ready = false;
      expect(tm.isReadyToShow(10_002)).toBe(false);
      Object.defineProperty(tm, 'cubeImagery', { value: null });
      tm.dispose();
    });

    it('falls back when one root tile loads and the other fails', async () => {
      const tm = await withRoot(tile(4), tile(-1));
      dispatch(tm, { type: 'load-model', scene: new THREE.Group(), tile: {} });
      expect(tm.hasStreamFailed()).toBe(true);
      expect(tm.isReadyToShow()).toBe(false);
      tm.dispose();
    });

    it('waits out the grace period while a root tile in view is still loading', async () => {
      const tm = await withRoot(tile(4), tile(2));
      Object.assign((tm.tiles as unknown as { stats: Record<string, number> }).stats, { downloading: 1 });
      expect(tm.isReadyToShow(0)).toBe(false);
      expect(tm.isReadyToShow(10_000)).toBe(false);
      tm.dispose();
    });

    it('ignores root tiles out of view, and swaps once those in view load', async () => {
      const tm = await withRoot(tile(4), tile(0, false));
      expect(tm.isReadyToShow(0)).toBe(true);
      tm.dispose();
    });
  });

  it('customizes a tile material once, even when a split tile reloads the same scene', () => {
    const tm = make();
    tm.enableShadowReceiving(makeShadowUniforms());
    const scene = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
    scene.add(mesh);
    for (let i = 0; i < 3; i++) dispatch(tm, { type: 'load-model', scene, tile: {} });
    const shader = { ...THREE.ShaderLib.standard, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mesh.material.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    expect(shader.vertexShader.match(/varying vec3 vShadowWorldPos;/g)).toHaveLength(1);
    tm.dispose();
  });

  it('crossfades LODs on terrain but not on the ellipsoid, where parent and child tiles z-fight', () => {
    const fades = (tm: TerrainManager) => (tm.tiles as unknown as { plugins: Array<{ name?: string }> }).plugins.some((p) => p.name === 'FADE_TILES_PLUGIN');
    const imagery = make();
    const terrain = new TerrainManager({ type: 'quantized-mesh', url: 'https://example.invalid/t/' }, 3396.19, NO_RENDERER);
    const opted = make({ fadeDurationMs: 300 });
    expect([fades(imagery), fades(terrain), fades(opted)]).toEqual([false, true, true]);
    [imagery, terrain, opted].forEach((tm) => tm.dispose());
  });

  it('treats a failed root tileset as a failed stream', () => {
    const tm = new TerrainManager({ type: 'quantized-mesh', url: 'https://example.invalid/t/' }, 3396.19, NO_RENDERER);
    expect(tm.hasStreamFailed()).toBe(false);
    dispatch(tm, { type: 'load-error', tile: null, error: new Error('404'), url: 'layer.json' });
    expect(tm.hasStreamFailed()).toBe(true);
    tm.dispose();
  });

  it('waits for visible tiles, then for the queue or the grace period', async () => {
    const tm = make();
    await flush();
    const stats = (tm.tiles as unknown as { stats: Record<string, number> }).stats;
    stats.visible = 0;
    expect(tm.isReadyToShow(0)).toBe(false);
    Object.assign(stats, { visible: 4, queued: 3, downloading: 2, parsing: 0 });
    expect(tm.isReadyToShow(1000)).toBe(false);
    expect(tm.isReadyToShow(2000)).toBe(false);
    expect(tm.isReadyToShow(2500)).toBe(true);
    tm.resetShowWait();
    expect(tm.isReadyToShow(3000)).toBe(false);
    Object.assign(stats, { queued: 0, downloading: 0 });
    expect(tm.isReadyToShow(3001)).toBe(true);
    tm.dispose();
  });
});

describe('fallBackToParentTiles', () => {
  it('stands in for a failed source tile with its quarter of the parent, and leaves aborts alone', async () => {
    const asked: string[] = [];
    const bitmap = (w: number) => ({ width: w, height: w, close() {} });
    const source = {
      fetchItem: async ([x, y, level]: number[], signal?: AbortSignal) => {
        asked.push(`${level}/${y}/${x}`);
        if (signal?.aborted || level === 3) throw new Error('undecodable');
        return new THREE.Texture(bitmap(512) as unknown as ImageBitmap);
      },
    };
    const cuts: number[][] = [];
    const g = globalThis as unknown as { createImageBitmap: unknown };
    const saved = g.createImageBitmap;
    g.createImageBitmap = async (_img: unknown, sx: number, sy: number, sw: number) => { cuts.push([sx, sy]); return bitmap(sw); };
    try {
      let fallbacks = 0;
      const loaded: string[] = [];
      fallBackToParentTiles(source, (t, fromParent) => { if (fromParent) fallbacks++; else loaded.push(t.join('/')); });
      // Tile x=5 (east half), y=2 (north half) of parent 2/1/2. Bitmaps are pre-flipped,
      // so the north half is the bottom of the parent image.
      const tex = await source.fetchItem([5, 2, 3]);
      expect(asked).toEqual(['3/2/5', '2/1/2']);
      expect(cuts).toEqual([[256, 256]]);
      expect((tex.image as { width: number }).width).toBe(256);
      expect(fallbacks).toBe(1);
      // Only the tile asked for is reported, not the parent fetched for it.
      await source.fetchItem([4, 2, 2]);
      expect(loaded).toEqual(['4/2/2']);
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(source.fetchItem([5, 2, 4], ctrl.signal)).rejects.toThrow('undecodable');
      expect(fallbacks).toBe(1);
    } finally {
      g.createImageBitmap = saved;
    }
  });
});
