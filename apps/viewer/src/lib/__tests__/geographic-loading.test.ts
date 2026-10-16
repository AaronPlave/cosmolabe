import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseGeographicGeoJson, type CatalogJson, type GeographicLayer } from '@cosmolabe/core';
import { prepareGeographicCatalogs, parseGeographicInWorker, GEOGRAPHIC_SCENE_WAIT_MS } from '../geographic-loading';

const json: CatalogJson = { name: 'Local Moon', geographicCoordinates: {
  latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
  referenceShape: { kind: 'sphere', radiusKm: 1737.4 },
}, geographicLayers: [{ id: 'sites', name: 'Sites', body: 'Moon', source: 'data/sites.geojson' }] };
const text = '{"type":"FeatureCollection","features":[{"type":"Feature","id":"site","properties":{"name":"South pole"},"geometry":{"type":"Point","coordinates":[179.8,-89.5]}}]}';
const graph = [{ url: 'scene.json', json }];
const parser = async (args: Parameters<typeof parseGeographicGeoJson>): Promise<GeographicLayer> => parseGeographicGeoJson(...args);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('viewer geographic loading', () => {
  it('opens catalog + local GeoJSON using exact paths or a unique basename, retaining local ownership', async () => {
    const result = await prepareGeographicCatalogs(graph, new AbortController().signal, new Map([['sites.geojson', text]]), parser);
    expect(result[0].source).toBe('scene.json');
    expect(result[0].loads[0].layer).toMatchObject({ ownership: 'transient', source: { identity: 'data/sites.geojson' } });
    expect(result[0].loads[0].layer!.features[0].properties).toEqual({ name: 'South pole' });
  });
  it('rejects missing/ambiguous local sources and never falls through to the network', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const result = await prepareGeographicCatalogs(graph, new AbortController().signal,
      new Map([['a/sites.geojson', text], ['b/sites.geojson', text]]), parser);
    expect(result[0].loads[0].status).toBe('error');
    expect(result[0].loads[0].diagnostics[0].message).toContain('ambiguous');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('loads nested hosted datasets against the declaring catalog URL', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(text));
    const result = await prepareGeographicCatalogs([{ url: 'https://data.test/mission/scene.json', json }], new AbortController().signal, undefined, parser);
    expect(fetcher.mock.calls[0][0]).toBe('https://data.test/mission/data/sites.geojson');
    expect(result[0].loads[0].layer!.source.kind).toBe('catalog');
  });

  class FakeWorker {
    static last: FakeWorker;
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() { FakeWorker.last = this; }
  }
  const args: Parameters<typeof parseGeographicGeoJson> = [text, { ...json.geographicLayers![0], coordinates: json.geographicCoordinates }, { kind: 'local-file', identity: 'sites.geojson' }];
  it('terminates the parser worker after success, parser error and cancellation', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const done = parseGeographicInWorker(args);
    const first = FakeWorker.last;
    const layer = parseGeographicGeoJson(...args);
    first.onmessage!({ data: { layer } });
    expect(await done).toEqual(layer);
    expect(first.terminate).toHaveBeenCalledOnce();

    const error = parseGeographicInWorker(args);
    FakeWorker.last.onmessage!({ data: { error: 'Malformed polygon' } });
    await expect(error).rejects.toThrow('Malformed polygon');
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const cancelled = parseGeographicInWorker(args, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });

  it('bounds unavailable optional sources across the entire graph by one deadline and retains diagnostics', async () => {
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const catalog = { ...json, geographicLayers: Array.from({ length: 16 }, (_, i) => ({ ...json.geographicLayers![0], id: `layer-${i}` })) };
    let completed = false;
    const loading = prepareGeographicCatalogs([
      { url: 'https://data.test/a.json', json: catalog }, { url: 'https://data.test/b.json', json },
    ], new AbortController().signal).then(result => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(GEOGRAPHIC_SCENE_WAIT_MS - 1);
    expect(completed).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    const result = await loading;
    expect(result.map(x => x.loads.length)).toEqual([16, 1]);
    expect(result.flatMap(x => x.loads).every(x => x.status === 'error')).toBe(true);
    expect(result[1].loads[0].diagnostics[0].message).toContain('Scene GeoJSON import deadline');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('terminates an in-progress parser at the aggregate deadline and does not turn the timeout into a scene failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(text));
    const loading = prepareGeographicCatalogs([{ url: 'https://data.test/scene.json', json }], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    const worker = FakeWorker.last;
    await vi.advanceTimersByTimeAsync(GEOGRAPHIC_SCENE_WAIT_MS);
    expect((await loading)[0].loads[0].status).toBe('error');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
