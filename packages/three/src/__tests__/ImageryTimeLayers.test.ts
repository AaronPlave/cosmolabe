import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WMTSCapabilitiesLoader } from '3d-tiles-renderer/three/plugins';
import { TerrainManager, type TerrainConfig, type TerrainImageryConfig } from '../TerrainManager.js';
import type { ImageryTemporalConfig } from '../ImageryTime.js';

const BACKDROP = 'https://example.invalid/backdrop/{z}/{y}/{x}.jpg';
const DAILY = 'https://gibs.example/wmts/epsg4326/best/Daily_TrueColor/default/2020-01-01/250m/{z}/{y}/{x}.jpg';
const TILE = 'https://gibs.example/wmts/epsg4326/best/Daily_TrueColor/default/2020-01-01/250m/3/4/5.jpg';
const at = (iso: string) => Date.parse(iso);

const NO_RENDERER = undefined as unknown as THREE.WebGLRenderer;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

type Overlay = { preprocessURL: (url: string) => string };
type Plugin = { overlays: unknown[]; addOverlay: (o: unknown, i?: number) => unknown };
const internals = (tm: TerrainManager) => tm as unknown as {
  activeOverlays: Map<string, Overlay>;
  capabilitiesCache: Map<string, Promise<unknown>>;
  overlayPlugin: Plugin;
};
const plugin = (tm: TerrainManager) => (tm.tiles as unknown as { getPluginByName(n: string): Plugin }).getPluginByName('IMAGE_OVERLAY_PLUGIN');
const tileUrl = (tm: TerrainManager, id: string, url = TILE) => internals(tm).activeOverlays.get(id)!.preprocessURL(url);
const layerOf = (tm: TerrainManager, id: string) => tm.imageryLayers.find((l) => l.id === id)!;

describe('time-indexed imagery layers (#214)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('2026-11-06T12:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  const make = (temporal?: ImageryTemporalConfig, over: Partial<TerrainImageryConfig> = {}) => new TerrainManager({
    type: 'imagery',
    imagery: [
      { url: BACKDROP, levels: 8 },
      { url: DAILY, id: 'daily', name: 'Daily', levels: 8, ...(temporal ? { temporal } : {}), ...over },
    ],
  } as TerrainConfig, [6378.137, 6378.137, 6356.752], NO_RENDERER);

  it('leaves time-independent layers without temporal state or date handling', async () => {
    const tm = make();
    await flush();
    expect(layerOf(tm, 'daily').temporal ?? null).toBeNull();
    expect(tm.followsSimulationTime).toBe(false);
    // The URL is untouched.
    expect(tileUrl(tm, 'daily')).toBe(TILE);
    tm.dispose();
  });

  it('shows nothing until the simulation clock arrives, then the simulation day', async () => {
    const tm = make({ policy: 'follow-simulation', end: 'present' });
    await flush();
    expect(plugin(tm).overlays).toHaveLength(0);
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ policy: 'follow-simulation', date: null });

    tm.updateImageryTime(at('2024-03-09T17:00:00Z'), 0);
    await flush();
    expect(plugin(tm).overlays).toHaveLength(1);
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: '2024-03-09', requestedDate: '2024-03-09', state: 'exact', semantics: 'acquisition', illumination: 'baked' });
    expect(tileUrl(tm, 'daily')).toContain('/default/2024-03-09/');
    tm.dispose();
  });

  it('keeps the legacy `time` field working as a fixed date in the same system', async () => {
    const tm = make(undefined, { time: '2023-05-18' });
    await flush();
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ policy: 'fixed', date: '2023-05-18', state: 'exact' });
    expect(tileUrl(tm, 'daily')).toContain('/default/2023-05-18/');
    // The simulation clock does not move a fixed layer.
    tm.updateImageryTime(at('2001-01-01T00:00:00Z'), 10_000);
    expect(layerOf(tm, 'daily').temporal!.date).toBe('2023-05-18');
    expect(tm.followsSimulationTime).toBe(false);
    tm.dispose();
  });

  it('resolves `yesterday` once, to the UTC day before the wall clock', async () => {
    const tm = make(undefined, { time: 'yesterday' });
    await flush();
    expect(layerOf(tm, 'daily').temporal!.date).toBe('2026-11-05');
    tm.dispose();
  });

  it('replaces the overlay atomically when the day changes, retiring the old one', async () => {
    const tm = make({ policy: 'follow-simulation' });
    tm.updateImageryTime(at('2024-03-09T00:00:00Z'), 0);
    await flush();
    const first = internals(tm).activeOverlays.get('daily')!;

    tm.updateImageryTime(at('2024-03-10T00:00:00Z'), 1100);
    // Debounced: the old day stays until the new one has held.
    expect(internals(tm).activeOverlays.get('daily')).toBe(first);
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: '2024-03-09', pendingDate: '2024-03-10' });
    tm.updateImageryTime(at('2024-03-10T00:00:00Z'), 1600);
    await flush();

    const second = internals(tm).activeOverlays.get('daily')!;
    expect(second).not.toBe(first);
    expect(plugin(tm).overlays).toHaveLength(1);
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: '2024-03-10', pendingDate: null, switches: 2 });
    // The retired overlay can no longer issue a request for its day; the new one asks for the new day only.
    expect(first.preprocessURL(TILE)).toMatch(/^data:image\/png/);
    expect(second.preprocessURL(TILE)).toContain('/default/2024-03-10/');
    expect(second.preprocessURL(TILE)).not.toContain('2024-03-09');
    tm.dispose();
  });

  it('resets the new day’s counters, so a day’s failures are not blamed on the next', async () => {
    const tm = make({ policy: 'follow-simulation' });
    tm.updateImageryTime(at('2024-03-09T00:00:00Z'), 0);
    await flush();
    tileUrl(tm, 'daily');
    expect(layerOf(tm, 'daily').requests).toBe(1);
    (tm as unknown as { layers: Array<{ id: string; failedTiles: number }> }).layers.find((l) => l.id === 'daily')!.failedTiles = 1;
    expect(layerOf(tm, 'daily').status).toBe('failed');
    tm.setImageryLayerTime('daily', { date: '2024-03-12' });
    await flush();
    expect(layerOf(tm, 'daily')).toMatchObject({ requests: 0, failedTiles: 0, status: 'idle' });
    tm.dispose();
  });

  it('never lets an obsolete setup resurrect an old day', async () => {
    const tm = make({ policy: 'follow-simulation' });
    tm.updateImageryTime(at('2024-03-09T00:00:00Z'), 0);
    await flush();
    const creations: string[] = [];
    const add = internals(tm).overlayPlugin.addOverlay.bind(internals(tm).overlayPlugin);
    vi.spyOn(internals(tm).overlayPlugin, 'addOverlay').mockImplementation((o, i) => {
      creations.push((o as Overlay).preprocessURL(TILE));
      return add(o, i);
    });
    // Two quick explicit changes: only the last may end up attached.
    tm.setImageryLayerTime('daily', { date: '2024-04-01' });
    tm.setImageryLayerTime('daily', { date: '2024-04-02' });
    await flush();
    expect(creations).toHaveLength(1);
    expect(creations[0]).toContain('/default/2024-04-02/');
    expect(plugin(tm).overlays).toHaveLength(1);
    tm.dispose();
  });

  it('bounds overlay builds and residency under fast playback', async () => {
    const tm = make({ policy: 'follow-simulation' });
    const addOverlay = vi.spyOn(internals(tm).overlayPlugin, 'addOverlay');
    let maxResident = 0;
    let day = at('2020-01-01T00:00:00Z');
    // A day per frame at 60 fps for 20 s.
    for (let t = 0; t <= 20_000; t += 16) {
      tm.updateImageryTime(day, t);
      day += 86_400_000;
      if (t % 160 === 0) { await flush(); maxResident = Math.max(maxResident, plugin(tm).overlays.length); }
    }
    await flush();
    // Debounce plus max-wait: a handful of builds, never one per day bucket, and one overlay at a time.
    expect(addOverlay.mock.calls.length).toBeLessThanOrEqual(8);
    expect(maxResident).toBeLessThanOrEqual(1);
    expect(plugin(tm).overlays).toHaveLength(1);
    tm.dispose();
  });

  it('does nothing for repeated frames of the same day', async () => {
    const tm = make({ policy: 'follow-simulation' });
    tm.updateImageryTime(at('2024-03-09T01:00:00Z'), 0);
    await flush();
    const addOverlay = vi.spyOn(internals(tm).overlayPlugin, 'addOverlay');
    for (let t = 16; t < 60_000; t += 16) tm.updateImageryTime(at('2024-03-09T01:00:00Z') + t * 60, t);
    await flush();
    // Nearly an hour of simulation time at 60x speed stays within one UTC day.
    expect(addOverlay).not.toHaveBeenCalled();
    expect(layerOf(tm, 'daily').temporal!.switches).toBe(1);
    tm.dispose();
  });

  it('removes the overlay and requests nothing when the day is outside the range, leaving lower layers', async () => {
    const tm = make({ policy: 'follow-simulation', start: '2010-01-01', end: '2024-12-31' });
    tm.updateImageryTime(at('2024-03-09T00:00:00Z'), 0);
    await flush();
    expect(plugin(tm).overlays).toHaveLength(1);

    tm.updateImageryTime(at('2005-01-01T00:00:00Z'), 5000);
    await flush();
    expect(plugin(tm).overlays).toHaveLength(0);
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: null, state: 'before-range', requestedDate: '2005-01-01' });
    // The base is untouched and the layer is not reported as a failure.
    expect(layerOf(tm, 'layer-0')).toMatchObject({ visible: true });
    expect(layerOf(tm, 'daily').status).toBe('idle');

    tm.updateImageryTime(at('2025-06-01T00:00:00Z'), 9000);
    await flush();
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: null, state: 'after-range' });

    tm.updateImageryTime(at('2020-06-01T00:00:00Z'), 13_000);
    await flush();
    expect(plugin(tm).overlays).toHaveLength(1);
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: '2020-06-01', state: 'exact' });
    tm.dispose();
  });

  it('labels the actual day when asked to use the nearest one', async () => {
    const tm = make({ policy: 'follow-simulation', end: '2024-12-31', outOfRange: 'nearest' });
    tm.updateImageryTime(at('2025-02-01T00:00:00Z'), 0);
    await flush();
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: '2024-12-31', requestedDate: '2025-02-01', state: 'nearest', offsetDays: -32 });
    expect(tileUrl(tm, 'daily')).toContain('/default/2024-12-31/');
    tm.dispose();
  });

  it('does not show a day the wall clock says cannot be published yet', async () => {
    const tm = make({ policy: 'follow-simulation', latencyDays: 1 });
    tm.updateImageryTime(at('2026-11-06T08:00:00Z'), 0);
    await flush();
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: null, state: 'not-yet-published' });
    expect(plugin(tm).overlays).toHaveLength(0);
    tm.updateImageryTime(at('2026-11-05T08:00:00Z'), 5000);
    await flush();
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: '2026-11-05', state: 'exact' });
    tm.dispose();
  });

  it('applies an explicit date at once, pins the shown day when switching to fixed, and validates input', async () => {
    const tm = make({ policy: 'follow-simulation' });
    tm.updateImageryTime(at('2024-03-09T00:00:00Z'), 0);
    await flush();

    expect(tm.setImageryLayerTime('daily', { date: 'not-a-date' })).toBe(false);
    expect(tm.setImageryLayerTime('daily', { policy: 'latest' })).toBe(false);
    expect(tm.setImageryLayerTime('daily', { policy: 'follow-simulation', date: '2024-01-01' })).toBe(false);
    expect(tm.setImageryLayerTime('daily', {})).toBe(false);
    expect(tm.setImageryLayerTime('layer-0', { date: '2024-01-01' })).toBe(false);
    expect(tm.setImageryLayerTime('nope', { date: '2024-01-01' })).toBe(false);

    // Pin: the day on screen stays, and the clock no longer moves it.
    expect(tm.setImageryLayerTime('daily', { policy: 'fixed' })).toBe(true);
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ policy: 'fixed', date: '2024-03-09' });
    expect(tm.followsSimulationTime).toBe(false);
    tm.updateImageryTime(at('2025-05-05T00:00:00Z'), 99_000);
    expect(layerOf(tm, 'daily').temporal!.date).toBe('2024-03-09');

    // An explicit date is not throttled.
    expect(tm.setImageryLayerTime('daily', { date: '2024-03-10' })).toBe(true);
    await flush();
    expect(tileUrl(tm, 'daily')).toContain('/default/2024-03-10/');
    expect(tm.setImageryLayerTime('daily', { date: '2024-03-10' })).toBe(false);

    // Back to following picks the simulation day immediately.
    expect(tm.setImageryLayerTime('daily', { policy: 'follow-simulation' })).toBe(true);
    await flush();
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ policy: 'follow-simulation', date: '2025-05-05' });
    tm.dispose();
  });

  it('shows a fixed date outside the range as unavailable rather than another day', async () => {
    const tm = make({ policy: 'fixed', date: '1999-01-01', start: '2010-01-01' });
    await flush();
    expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: null, state: 'before-range' });
    expect(plugin(tm).overlays).toHaveLength(0);
    tm.dispose();
  });

  it('does not follow while hidden, and comes back showing the current day', async () => {
    const tm = make({ policy: 'follow-simulation' }, { visible: false });
    tm.updateImageryTime(at('2024-03-09T00:00:00Z'), 0);
    await flush();
    expect(plugin(tm).overlays).toHaveLength(0);

    tm.updateImageryTime(at('2024-08-01T00:00:00Z'), 60_000);
    await flush();
    expect(plugin(tm).overlays).toHaveLength(0);

    expect(tm.setImageryLayerVisible('daily', true)).toBe(true);
    await flush();
    expect(tileUrl(tm, 'daily')).toContain('/default/2024-08-01/');
    // Switching off removes the overlay; no work remains for any day.
    expect(tm.setImageryLayerVisible('daily', false)).toBe(true);
    expect(plugin(tm).overlays).toHaveLength(0);
    tm.dispose();
  });

  it('keeps overlay state bounded across repeated seeks between two days', async () => {
    const tm = make({ policy: 'fixed', date: '2024-01-01' });
    await flush();
    const addOverlay = vi.spyOn(internals(tm).overlayPlugin, 'addOverlay');
    for (let i = 0; i < 50; i++) {
      tm.setImageryLayerTime('daily', { date: i % 2 ? '2024-01-01' : '2024-02-02' });
      await flush();
      expect(plugin(tm).overlays).toHaveLength(1);
    }
    expect(addOverlay).toHaveBeenCalledTimes(50);
    const internal = tm as unknown as { activeOverlays: Map<string, unknown>; degradedTiles: Map<string, unknown>; overlayLayerIds: WeakMap<object, string> };
    expect(internal.activeOverlays.size).toBe(1);
    expect(internal.degradedTiles.size).toBeLessThanOrEqual(1);
    tm.dispose();
  });

  it('refuses to follow time on the base layer, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tm = new TerrainManager({
      type: 'imagery',
      imagery: [{ url: DAILY, id: 'base', temporal: { policy: 'follow-simulation' } }, { url: BACKDROP, id: 'top' }],
    } as TerrainConfig, [6378.137, 6378.137, 6356.752], NO_RENDERER);
    await flush();
    expect(layerOf(tm, 'base').temporal ?? null).toBeNull();
    expect(tm.followsSimulationTime).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('base layer'))).toBe(true);
    tm.dispose();
    warn.mockRestore();
  });

  it('reports a date that its URL cannot carry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tm = make({ policy: 'fixed', date: '2024-01-01' }, { url: 'https://example.invalid/static/{z}/{y}/{x}.jpg' });
    await flush();
    tileUrl(tm, 'daily', 'https://example.invalid/static/3/4/5.jpg');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('cannot take effect'))).toBe(true);
    tm.dispose();
    warn.mockRestore();
  });

  describe('with a WMTS capabilities time dimension', () => {
    const CAPS_URL = 'https://gibs.example/wmts/epsg4326/best/wmts.cgi?SERVICE=WMTS&request=GetCapabilities';
    const caps = (values: string[], defaultValue: string) => ({
      serviceIdentification: { title: 't', abstract: '', serviceType: 'OGC WMTS', serviceTypeVersion: '1.0.0' },
      tileMatrixSets: [] as unknown[],
      layers: [{
        title: 'Daily', identifier: 'Daily_TrueColor', format: 'image/jpeg',
        boundingBox: { crs: 'urn:ogc:def:crs:EPSG::4326', lowerCorner: [-90, -180], upperCorner: [90, 180], bounds: [-Math.PI, -Math.PI / 2, Math.PI, Math.PI / 2] },
        dimensions: [{ identifier: 'Time', values, current: false, defaultValue }],
        styles: [{ identifier: 'default', title: 'default', isDefault: true }],
        resourceUrls: [{ template: 'https://gibs.example/wmts/epsg4326/best/Daily_TrueColor/default/{Time}/250m/{TileMatrix}/{TileRow}/{TileCol}.jpeg', format: 'image/jpeg', resourceType: 'tile' }],
        tileMatrixSetLinks: ['250m'],
        tileMatrixSets: [{
          identifier: '250m', title: '250m', abstract: '', supportedCRS: 'urn:ogc:def:crs:OGC:1.3:CRS84',
          tileMatrices: [0, 1, 2, 3].map((z) => ({ identifier: String(z), matrixWidth: 2 * 2 ** z, matrixHeight: 2 ** z, tileWidth: 512, tileHeight: 512, tileBounds: [-180, -90, 180, 90].map((v) => v * Math.PI / 180) })),
        }],
      }],
    });
    const makeCaps = (temporal: ImageryTemporalConfig, c = caps(['2002-07-04/2026-11-05/P1D'], '2026-11-05')) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // The constructor starts streaming at once, so the document is served from the loader itself.
      vi.spyOn(WMTSCapabilitiesLoader.prototype, 'loadAsync').mockResolvedValue(c as never);
      const tm = new TerrainManager({
        type: 'imagery',
        imagery: [
          { url: BACKDROP, levels: 8 },
          { type: 'wmts-capabilities', url: CAPS_URL, layer: 'Daily_TrueColor', tileMatrixSet: '250m', id: 'daily', temporal },
        ],
      } as TerrainConfig, [6378.137, 6378.137, 6356.752], NO_RENDERER);
      return tm;
    };
    afterEach(() => { vi.restoreAllMocks(); });

    it('substitutes the day through the time dimension and reads the provider range', async () => {
      const tm = makeCaps({ policy: 'follow-simulation' });
      tm.updateImageryTime(at('2024-03-09T00:00:00Z'), 0);
      await flush();
      expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: '2024-03-09', range: { start: '2002-07-04', end: '2026-11-05', source: 'provider' } });
      const source = (internals(tm).activeOverlays.get('daily') as unknown as { imageSource: { url: string } }).imageSource;
      expect(source.url).toContain('/default/2024-03-09/');
      tm.dispose();
    });

    it('treats a day before the provider’s first as unavailable even when the catalog gave no range', async () => {
      const tm = makeCaps({ policy: 'follow-simulation' });
      tm.updateImageryTime(at('1999-03-09T00:00:00Z'), 0);
      await flush();
      expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: null, state: 'before-range' });
      expect(plugin(tm).overlays).toHaveLength(0);
      tm.dispose();
    });

    it('lets a catalog range narrow the provider’s', async () => {
      const tm = makeCaps({ policy: 'follow-simulation', start: '2020-01-01' });
      tm.updateImageryTime(at('2019-12-31T00:00:00Z'), 0);
      await flush();
      expect(layerOf(tm, 'daily').temporal).toMatchObject({ date: null, state: 'before-range', range: { start: '2020-01-01', end: '2026-11-05' } });
      tm.dispose();
    });

    it('resolves `latest` from the provider only', async () => {
      const tm = makeCaps({ policy: 'latest' });
      await flush();
      expect(layerOf(tm, 'daily').temporal).toMatchObject({ policy: 'latest', date: '2026-11-05', state: 'exact', policies: ['fixed', 'follow-simulation', 'latest'] });
      expect((internals(tm).activeOverlays.get('daily') as unknown as { imageSource: { url: string } }).imageSource.url).toContain('/default/2026-11-05/');
      tm.dispose();

      // A provider with no time dimension gives `latest` nothing to resolve.
      const none = makeCaps({ policy: 'latest' }, { ...caps([], ''), layers: [{ ...caps([], '').layers[0], dimensions: [] }] });
      await flush();
      expect(layerOf(none, 'daily').temporal).toMatchObject({ date: null, state: 'invalid' });
      none.dispose();
    });

    it('does not guess `latest` for sources that cannot declare availability', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tm = make({ policy: 'latest' });
      await flush();
      expect(layerOf(tm, 'daily').temporal).toMatchObject({ policy: 'follow-simulation', policies: ['fixed', 'follow-simulation'] });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('"latest" needs a wmts-capabilities'))).toBe(true);
      tm.dispose();
    });

    it('drops a slow capabilities setup for a day that has since changed', async () => {
      const tm = makeCaps({ policy: 'fixed', date: '2024-01-01' });
      let release!: (c: unknown) => void;
      const slow = new Promise<unknown>((r) => { release = r; });
      internals(tm).capabilitiesCache.set(CAPS_URL, slow);
      // Re-enable so a fresh, slow setup starts for 2024-01-01…
      tm.setImageryLayerVisible('daily', false);
      tm.setImageryLayerVisible('daily', true);
      // …and the day changes before it resolves.
      tm.setImageryLayerTime('daily', { date: '2024-06-06' });
      release(caps(['2002-07-04/2026-11-05/P1D'], '2026-11-05'));
      await flush();
      expect(plugin(tm).overlays).toHaveLength(1);
      expect((internals(tm).activeOverlays.get('daily') as unknown as { imageSource: { url: string } }).imageSource.url).toContain('/default/2024-06-06/');
      tm.dispose();
    });
  });
});
