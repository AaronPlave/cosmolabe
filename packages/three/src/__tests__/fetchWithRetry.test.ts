import type * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, fetchCompleteResponse } from '../fetchWithRetry.js';
import { CubeSphereGridSource, type CubeGridManifest } from '../surface/CubeSphereGrids.js';
import { TerrainManager } from '../TerrainManager.js';
import { CubeImageryLayer } from '../CubeImageryLayer.js';

const respond = (...answers: (number | Error)[]) => vi.fn(async () => {
  const a = answers.shift()!;
  if (a instanceof Error) throw a;
  return new Response('x', { status: a });
});

describe('fetchWithRetry', () => {
  it('retries network errors, 5xx and 429, and returns other answers as they are', async () => {
    const flaky = respond(new TypeError('Failed to fetch'), 503, 429, 200);
    expect((await fetchWithRetry('u', {}, { fetchImpl: flaky, baseMs: 1 })).status).toBe(200);
    expect(flaky).toHaveBeenCalledTimes(4);
    const missing = respond(404);
    expect((await fetchWithRetry('u', {}, { fetchImpl: missing, baseMs: 1 })).status).toBe(404);
    expect(missing).toHaveBeenCalledTimes(1);
    // After `tries`, the last answer (or error) stands.
    expect((await fetchWithRetry('u', {}, { fetchImpl: respond(503, 503), tries: 2, baseMs: 1 })).status).toBe(503);
    await expect(fetchWithRetry('u', {}, { fetchImpl: respond(new TypeError('a'), new TypeError('b')), tries: 2, baseMs: 1 })).rejects.toThrow('b');
  });

  it('stops waiting to retry as soon as the request is aborted', async () => {
    const controller = new AbortController();
    const once = respond(503, 200);
    const pending = fetchWithRetry('u', { signal: controller.signal }, { fetchImpl: once, baseMs: 60_000 });
    await Promise.resolve();
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await expect(pending).rejects.toThrow('Aborted');
    expect(once).toHaveBeenCalledTimes(1);
  });

  it('bounds cube grid requests in flight and retries a transient failure', async () => {
    const tiles: CubeGridManifest['tiles'] = (['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const).flatMap((f) =>
      [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [f, 1, x, y, 0.001] as [typeof f, number, number, number, number]));
    const manifest: CubeGridManifest = {
      format: 'cosmolabe-cube-height-grid-1',
      datum: { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
      source: { id: 't', kind: 'height-grid', version: 'v' }, grid: { width: 2, height: 2, uri: 'h/{face}/{level}/{x}/{y}.f32' },
      heightRangeKm: [0, 1], maxLevel: 1, tiles,
    };
    let inFlight = 0, peak = 0, failedOnce = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('grids.json')) return new Response(JSON.stringify(manifest));
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      if (!failedOnce) { failedOnce = true; throw new TypeError('Failed to fetch'); }
      return new Response(new Float32Array(4).buffer);
    }) as unknown as typeof fetch;
    const source = await CubeSphereGridSource.fromUrl('https://example.invalid/grids.json', { fetch: fetchImpl, residentLevel: 1, maxConcurrentRequests: 3, retryBaseMs: 1 });
    await source.ready;
    expect(peak).toBe(3);
    expect(source.stats).toMatchObject({ residentTiles: 24, failed: 0 });
  });

  it('retries without a limit when asked, with the backoff capped', async () => {
    const outage = respond(503, 503, 503, 503, 503, 503, new TypeError('x'), 200);
    expect((await fetchWithRetry('u', {}, { fetchImpl: outage, tries: Infinity, baseMs: 1, maxDelayMs: 2 })).status).toBe(200);
    expect(outage).toHaveBeenCalledTimes(8);
  });
});

/** All six faces at level 0, and nz at level 1. */
function gridManifest(): CubeGridManifest {
  const tiles: CubeGridManifest['tiles'] = (['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const).map((f) => [f, 0, 0, 0, 0.001]);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) tiles.push(['nz', 1, x, y, 0.0005]);
  return {
    format: 'cosmolabe-cube-height-grid-1',
    datum: { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    source: { id: 't', kind: 'height-grid', version: 'v' }, grid: { width: 2, height: 2, uri: 'h/{face}/{level}/{x}/{y}.f32' },
    heightRangeKm: [0, 1], maxLevel: 1, tiles,
  };
}

describe('recovery after the retries run out (#233 review)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('retries a resident grid when its 200 response body is interrupted', async () => {
    let bodyAttempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('grids.json')) return new Response(JSON.stringify(gridManifest()));
      if (url.endsWith('h/px/0/0/0.f32') && ++bodyAttempts === 1) {
        return new Response(new ReadableStream({ start(controller) {
          controller.error(new TypeError('connection reset after headers'));
        } }));
      }
      return new Response(new Float32Array(4).buffer);
    }) as unknown as typeof fetch;
    const source = await CubeSphereGridSource.fromUrl('https://example.invalid/grids.json',
      { fetch: (input, init) => fetchCompleteResponse(input, init, fetchImpl), residentLevel: 0, retryBaseMs: 1 });
    await source.ready;
    expect(bodyAttempts).toBe(2);
    expect(source.stats).toMatchObject({ residentTiles: 6, failed: 0, inFlight: 0 });
    expect(source.coverage(0, 0).state).toBe('finest');
    source.dispose();
  });

  it('bounds interrupted-body retries and keeps missing resident grids unavailable', async () => {
    let bodyAttempts = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('grids.json')) return new Response(JSON.stringify(gridManifest()));
      if (url.endsWith('h/px/0/0/0.f32')) {
        bodyAttempts++;
        return new Response(new ReadableStream({ start(controller) {
          controller.error(new TypeError('connection reset after headers'));
        } }));
      }
      return new Response(new Float32Array(4).buffer);
    }) as unknown as typeof fetch;
    const source = await CubeSphereGridSource.fromUrl('https://example.invalid/grids.json',
      { fetch: (input, init) => fetchCompleteResponse(input, init, fetchImpl), residentLevel: 0, retryBaseMs: 1 });
    await expect(source.ready).rejects.toThrow('resident levels failed');
    expect(bodyAttempts).toBe(4);
    expect(source.coverage(0, 0).state).toBe('unloaded');
    expect(source.stats).toMatchObject({ residentTiles: 5, failed: 1, inFlight: 0 });
    source.dispose();
    vi.restoreAllMocks();
  });

  it('requests a CPU grid again once the host recovers: four 503s, then the fifth request succeeds', async () => {
    const down = new Set(['h/nz/1/1/1.f32', 'h/px/0/0/0.f32']); // a detail grid and a resident one
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('grids.json')) return new Response(JSON.stringify(gridManifest()));
      const path = new URL(url).pathname.slice(1);
      requests.push(path);
      return down.has(path) ? new Response('', { status: 503 }) : new Response(new Float32Array(4).buffer);
    }) as unknown as typeof fetch;
    const source = await CubeSphereGridSource.fromUrl('https://example.invalid/grids.json',
      { fetch: fetchImpl, residentLevel: 0, retryBaseMs: 1, retryFailedMs: 20 });
    await source.ready.catch(() => {}); // px/0/0/0 failed at startup
    const count = (path: string) => requests.filter((r) => r === path).length;
    await source.request(-90, 0);
    expect(count('h/nz/1/1/1.f32')).toBe(4);
    expect(source.coverage(-90, 0).state).toBe('parent-fallback');
    // Inside the retry window a query does not hammer the host.
    await source.request(-90, 0);
    expect(count('h/nz/1/1/1.f32')).toBe(4);
    down.clear();
    await new Promise((r) => setTimeout(r, 25));
    await source.request(-90, 0);
    await source.request(0, 0);
    expect(count('h/nz/1/1/1.f32')).toBe(5);
    expect(count('h/px/0/0/0.f32')).toBe(5);
    expect(source.coverage(-90, 0).state).toBe('finest');
    expect(source.coverage(0, 0).state).toBe('finest');
    expect(source.stats.failed).toBe(0);
  });

  it('keeps a cube terrain tile loading through an outage longer than four attempts, so its parent stays drawn', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // the grid manifest is absent here
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (!String(url).endsWith('.glb') ? new Response('', { status: 404 })
      : ++calls <= 6 ? new Response('', { status: 503 }) : new Response('glb'))));
    const tm = new TerrainManager({ type: '3dtiles', url: 'https://example.invalid/tileset.json', datum: { verticalDatum: 'reference-sphere', heightConvention: 'radial' },
      cubeSphere: { cpuGrids: 'https://example.invalid/cpu-grids.json' } }, 1737.4, undefined as unknown as THREE.WebGLRenderer);
    const tiles = (tm as unknown as { tiles: { invokeOnePlugin<T>(fn: (p: { fetchData?: (u: string, o: RequestInit) => Promise<Response> }) => T): T } }).tiles;
    const tile = tiles.invokeOnePlugin((p) => p.fetchData?.('https://example.invalid/nz/5/1/2.glb', { signal: new AbortController().signal }));
    let settled: Response | null = null;
    void tile!.then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(7);
    expect(settled!.status).toBe(200);
    tm.dispose();
  });

  it('waits out a startup outage longer than four attempts for the grid and imagery manifests', async () => {
    vi.useFakeTimers();
    let gridCalls = 0, imageryCalls = 0;
    const gridFetch = vi.fn(async (url: string) => (url.endsWith('grids.json')
      ? (++gridCalls <= 6 ? new Response('', { status: 503 }) : new Response(JSON.stringify(gridManifest())))
      : new Response(new Float32Array(4).buffer))) as unknown as typeof fetch;
    const grids = CubeSphereGridSource.fromUrl('https://example.invalid/grids.json', { fetch: gridFetch, residentLevel: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => (++imageryCalls <= 6 ? Promise.reject(new TypeError('Failed to fetch')) : new Response('{}'))));
    const layer = new CubeImageryLayer({ url: 'https://example.invalid/imagery.json' });
    const imagery = layer.ready.catch((e: Error) => e); // '{}' is not a valid manifest: reaching validation is enough
    await vi.advanceTimersByTimeAsync(120_000);
    expect(gridCalls).toBe(7);
    expect((await grids).manifest.maxLevel).toBe(1);
    expect(imageryCalls).toBe(7);
    expect(String(await imagery)).not.toMatch(/fetch/);
    layer.dispose();
  });

  it('stops waiting for an imagery manifest when the layer is disposed', async () => {
    vi.useFakeTimers();
    const outage = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', outage);
    const layer = new CubeImageryLayer({ url: 'https://example.invalid/imagery.json' });
    const settled = layer.ready.then(() => 'resolved', () => 'rejected');
    await vi.advanceTimersByTimeAsync(5_000);
    layer.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await settled).toBe('rejected');
    expect(outage.mock.calls.length).toBeLessThan(6);
  });
});
