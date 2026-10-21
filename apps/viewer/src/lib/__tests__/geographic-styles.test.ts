import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Universe, parseGeographicGeoJson, type GeographicLayer } from '@cosmolabe/core';
import { GeographicVectorLayer } from '@cosmolabe/three';

/** Style state against a real Universe store, the real vector layer and an in-memory localStorage. */
const loadHandlers: (() => void)[] = [];
let renderer: { geographicVectors: GeographicVectorLayer } | null = null;
let universe: Universe | null = null;

vi.mock('../viewer-state.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../viewer-state.svelte')>()),
  getRenderer: () => renderer,
  onViewerEvent: (name: string, handler: () => void) => { if (name === 'load') loadHandlers.push(handler); return () => {}; },
}));
vi.mock('../loader', () => ({ getUniverse: () => universe }));

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}
const storage = new MemoryStorage();
vi.stubGlobal('localStorage', storage);

const {
  geoStyles, setLayerStyle, updateLayerStyle, openStyleEditor, editedSinceOpen, revertStyleEdits, resetLayerStyle,
  setFeatureOverride, featureOverride, featureOverrideCount, moveLayer, layerRank, hasLocalStyle,
} = await import('../geographic-styles.svelte');

function layer(id: string, catalog = 'https://x/scene.json'): GeographicLayer {
  const features = [{ type: 'Feature', id: 'a', properties: { kind: 'rock' }, geometry: { type: 'Point', coordinates: [1, 1] } }];
  return parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features }), {
    id, name: id, body: 'Mars', source: `${id}.geojson`,
    coordinates: { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 3389.5 } },
  }, { kind: 'catalog', identity: `https://x/${id}.geojson`, catalog });
}

function load(...layers: GeographicLayer[]) {
  universe?.dispose();
  renderer?.geographicVectors.dispose();
  universe = new Universe();
  universe.geographicLayers.replaceCatalog('scene', layers.map(l => ({ id: l.id, status: 'ready' as const, layer: l, source: l.source, diagnostics: [] })));
  renderer = { geographicVectors: new GeographicVectorLayer(universe, 1) };
  for (const handler of loadHandlers) handler();
}
const stored = () => JSON.parse(storage.getItem('cosmolabe-geographic-styles') ?? '{"layers":{}}').layers as Record<string, { style: unknown }>;

beforeEach(() => { vi.useFakeTimers(); storage.data.clear(); load(layer('science'), layer('regions')); });
afterEach(() => { vi.useRealTimers(); });

describe('live preview and persistence', () => {
  it('previews after a short debounce and keeps the style for this catalog and layer', () => {
    setLayerStyle('science', { version: 1, point: { color: '#ff0000' } });
    expect(renderer!.geographicVectors.getStyle('science')).toBeNull();
    vi.advanceTimersByTime(100);
    expect(renderer!.geographicVectors.getStyle('science')).toEqual({ version: 1, point: { color: '#ff0000' } });
    expect(stored()['https://x/scene.json::science'].style).toEqual({ version: 1, point: { color: '#ff0000' } });
  });

  it('restores a kept style when the same catalog loads again, ignoring invalid parts with a reason', () => {
    storage.setItem('cosmolabe-geographic-styles', JSON.stringify({ version: 1, layers: {
      'https://x/scene.json::science': { style: { version: 1, line: { widthPx: 4, color: 'javascript:x' } }, updated: 1 },
      'https://other/scene.json::regions': { style: { version: 1, opacity: 0.2 }, updated: 1 },
    } }));
    load(layer('science'), layer('regions'));
    expect(renderer!.geographicVectors.getStyle('science')).toEqual({ version: 1, line: { widthPx: 4 } });
    expect(geoStyles.warnings.science).toEqual(['line.color must be a #rrggbb colour']);
    // Another catalog's layer with the same ID does not inherit it.
    expect(renderer!.geographicVectors.getStyle('regions')).toBeNull();
  });

  it('removes the kept entry when a style returns to defaults', () => {
    setLayerStyle('science', { version: 1, opacity: 0.5 });
    vi.advanceTimersByTime(100);
    resetLayerStyle('science');
    expect(stored()).toEqual({});
    expect(hasLocalStyle('science')).toBe(false);
    expect(renderer!.geographicVectors.getStyle('science')).toBeNull();
  });

  it('bounds what it keeps, dropping the least recently edited', () => {
    for (let i = 0; i < 70; i++) {
      vi.setSystemTime(1000 + i);
      load(layer(`l${i}`));
      setLayerStyle(`l${i}`, { version: 1, opacity: 0.5 });
      vi.advanceTimersByTime(100);
    }
    const keys = Object.keys(stored());
    expect(keys).toHaveLength(64);
    expect(keys).not.toContain('https://x/scene.json::l0');
    expect(keys).toContain('https://x/scene.json::l69');
  });

  it('keeps working for the session when storage is refused', () => {
    const set = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    setLayerStyle('science', { version: 1, opacity: 0.5 });
    vi.advanceTimersByTime(100);
    expect(geoStyles.persistent).toBe(false);
    expect(renderer!.geographicVectors.getStyle('science')).toEqual({ version: 1, opacity: 0.5 });
    set.mockRestore();
  });
});

describe('editor session', () => {
  it('reverts to the style the editor opened with', () => {
    setLayerStyle('science', { version: 1, opacity: 0.5 });
    vi.advanceTimersByTime(100);
    openStyleEditor('science');
    expect(editedSinceOpen()).toBe(false);
    updateLayerStyle('science', (s) => { s.point = { sizePx: 12 }; });
    expect(editedSinceOpen()).toBe(true);
    revertStyleEdits();
    expect(editedSinceOpen()).toBe(false);
    expect(renderer!.geographicVectors.getStyle('science')).toEqual({ version: 1, opacity: 0.5 });
  });
});

describe('feature exceptions', () => {
  const ref = { layerId: 'science', featureId: 'string:a', bodyName: 'Mars' };
  it('adds an explicit exception and removes it again, leaving the layer style', () => {
    setLayerStyle('science', { version: 1, opacity: 0.5 });
    setFeatureOverride(ref, { color: '#000000' });
    expect(featureOverride(ref)).toEqual({ color: '#000000' });
    expect(featureOverrideCount('science')).toBe(1);
    setFeatureOverride(ref, null);
    expect(featureOverride(ref)).toBeNull();
    vi.advanceTimersByTime(100);
    expect(renderer!.geographicVectors.getStyle('science')).toEqual({ version: 1, opacity: 0.5 });
  });
});

describe('draw order', () => {
  it('moves a layer among those on its body', () => {
    expect(layerRank('regions')).toEqual({ index: 1, count: 2 });
    moveLayer('regions', true);
    expect(layerRank('regions')).toEqual({ index: 0, count: 2 });
    expect(renderer!.geographicVectors.layerOrder).toEqual(['regions', 'science']);
    moveLayer('regions', true);
    expect(layerRank('regions').index).toBe(0);
  });
});
