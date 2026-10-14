import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  defaultLayerName, describeImageryLayers, layerCovers, layerStatus, nativeMetersPerPixel,
  reorderedLayers, resolveGlobeSurfaceConfig,
} from '../ImageryLayers.js';
import { TerrainManager, type TerrainConfig } from '../TerrainManager.js';

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
    expect(layerCovers(null, 80, 10)).toBe(true);
    expect(layerCovers([77.22, 18.31, 77.58, 18.67], 18.4, 77.4)).toBe(true);
    expect(layerCovers([77.22, 18.31, 77.58, 18.67], 18.4, 78)).toBe(false);
    expect(layerCovers([77.22, 18.31, 77.58, 18.67], 18.4, 77.4 - 360)).toBe(true);
    expect(layerCovers([170, -10, -170, 10], 0, 179)).toBe(true);
    expect(layerCovers([170, -10, -170, 10], 0, -175)).toBe(true);
    expect(layerCovers([170, -10, -170, 10], 0, 0)).toBe(false);
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
