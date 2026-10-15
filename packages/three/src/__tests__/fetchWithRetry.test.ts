import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../fetchWithRetry.js';
import { CubeSphereGridSource, type CubeGridManifest } from '../surface/CubeSphereGrids.js';

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
});
