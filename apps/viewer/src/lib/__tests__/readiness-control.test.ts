import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseRenderer } from '@cosmolabe/three';
const state = vi.hoisted(() => ({ scene: 1, renderer: null as UniverseRenderer | null, assetsReady: false, assetSummary: null as null | { timedOut: boolean; failed: number; stillPending: unknown[] }, handlers: new Map<string, Set<() => void>>() }));
vi.mock('../viewer-state.svelte', () => ({
  vs: state, sceneId: () => state.scene, getRenderer: () => state.renderer,
  onViewerEvent: (name: string, handler: () => void) => {
    const set = state.handlers.get(name) ?? new Set(); state.handlers.set(name, set); set.add(handler);
    return () => set.delete(handler);
  },
}));
import { getReadiness, waitUntilReady } from '../readiness-control';
const body = () => ({ visible: true, surfaceTransitionState: 'streamed',
  terrainViewCoverage: { physical: true, frameAvailable: true, observed: true, coverageTiles: 1, drawn: 1, missing: 0, failed: 0, pending: 0, targetLod: true },
  imageryLayers: [{ id: 'base', visible: true, opacity: 1, minZoom: 0, status: 'ok', view: { inCoverage: true, zoomLevel: 5, missingTiles: 0, degradedTiles: 0, cacheFull: false } }],
  terrainCubeImageryStats: { ready: true, manifestFailed: false, tiles: 1, baseUncoveredBlocks: 0 },
});
let bm = body();
beforeEach(() => {
  vi.useFakeTimers(); state.scene = 1; state.assetsReady = false; state.assetSummary = null; state.handlers.clear(); bm = body();
  state.renderer = { surfaceViewIsCurrent: () => true, getBodyMesh: (name: string) => name === 'Mars' ? bm : undefined } as unknown as UniverseRenderer;
});
afterEach(() => { vi.useRealTimers(); });
const listeners = () => [...state.handlers.values()].reduce((n, set) => n + set.size, 0);
const emit = (event: string) => { for (const callback of [...state.handlers.get(event) ?? []]) callback(); };

describe('explicit readiness predicates', () => {
  it('separates settled initial assets, asset failures and timeouts from surface readiness', () => {
    expect(getReadiness({ kind: 'assets' }).status).toBe('partial');
    state.assetsReady = true;
    expect(getReadiness({ kind: 'assets' }).status).toBe('ready');
    state.assetSummary = { failed: 2, timedOut: false, stillPending: [] };
    expect(getReadiness({ kind: 'assets' }).status).toBe('failed');
    state.assetSummary.timedOut = true;
    expect(getReadiness({ kind: 'assets' }).status).toBe('timed-out');
    expect(getReadiness({ kind: 'terrain', body: 'Mars' }).status).toBe('ready');
  });
  it('refuses missing sources, hidden data, out-of-coverage and insufficient zoom', () => {
    expect(getReadiness({ kind: 'imagery', body: 'wrong', layer: 'base' }).status).toBe('unavailable');
    expect(getReadiness({ kind: 'imagery', body: 'Mars', layer: 'wrong' }).status).toBe('unavailable');
    const request = { kind: 'imagery' as const, body: 'Mars', layer: 'base' };
    const layer = bm.imageryLayers[0];
    layer.visible = false; expect(getReadiness(request).status).toBe('unavailable'); layer.visible = true;
    layer.view.inCoverage = false; expect(getReadiness(request).status).toBe('unavailable'); layer.view.inCoverage = true;
    layer.minZoom = 6; expect(getReadiness(request).status).toBe('unavailable'); layer.minZoom = 0;
    layer.status = 'failed'; expect(getReadiness(request).status).toBe('failed');
  });
  it('requires all observed imagery tiles and mandatory cube base, with honest scope', () => {
    const request = { kind: 'imagery' as const, body: 'Mars', layer: 'base' };
    bm.imageryLayers[0].view.degradedTiles = 2;
    expect(getReadiness(request).status).toBe('partial');
    bm.imageryLayers[0].view.degradedTiles = 0;
    expect(getReadiness(request).status).toBe('ready');
    bm.terrainCubeImageryStats.baseUncoveredBlocks = 1;
    expect(getReadiness({ kind: 'cube-base', body: 'Mars' }).status).toBe('partial');
    bm.terrainCubeImageryStats.baseUncoveredBlocks = 0;
    expect(getReadiness({ kind: 'cube-base', body: 'Mars' })).toMatchObject({ status: 'ready', limitations: expect.arrayContaining([expect.stringContaining('Missing geometry')]) });
  });
  it('never promotes resident counters across streamed/static/preloading/waiting/fallback transitions', () => {
    const request = { kind: 'imagery' as const, body: 'Mars', layer: 'base' };
    expect(getReadiness(request).status).toBe('ready');
    for (const transition of ['static', 'preloading', 'waiting']) {
      bm.surfaceTransitionState = transition;
      expect(getReadiness(request).status).toBe('partial');
      expect(getReadiness({ kind: 'cube-base', body: 'Mars' }).status).toBe('partial');
      expect(getReadiness({ kind: 'terrain', body: 'Mars' }).status).toBe('partial');
    }
    bm.surfaceTransitionState = 'fallback'; expect(getReadiness(request).status).toBe('failed');
    bm.surfaceTransitionState = 'streamed'; expect(getReadiness(request).status).toBe('ready');
  });
  it('distinguishes footprint coverage, missing physical geometry and target LOD', () => {
    const request = { kind: 'terrain' as const, body: 'Mars' }, coverage = bm.terrainViewCoverage;
    coverage.physical = false; expect(getReadiness(request).status).toBe('unavailable'); coverage.physical = true;
    coverage.missing = 1; expect(getReadiness(request).status).toBe('partial'); coverage.missing = 0;
    coverage.targetLod = false; expect(getReadiness(request).missing).toContain('Drawn geometry has not reached the configured screen-space target LOD.'); coverage.targetLod = true;
    coverage.failed = 1; expect(getReadiness(request).status).toBe('failed'); coverage.failed = 0;
    coverage.drawn = 0; expect(getReadiness(request).status).toBe('partial'); coverage.drawn = 1;
    coverage.observed = false; expect(getReadiness(request).status).toBe('partial'); coverage.observed = true;
    expect(getReadiness(request)).toMatchObject({ status: 'ready', limitations: expect.arrayContaining([expect.stringContaining('product footprint')]) });
  });
  it('refuses old view counters immediately after a camera or source change', () => {
    vi.spyOn(state.renderer!, 'surfaceViewIsCurrent').mockReturnValue(false);
    expect(getReadiness({ kind: 'imagery', body: 'Mars', layer: 'base' }).status).toBe('partial');
    expect(getReadiness({ kind: 'cube-base', body: 'Mars' }).status).toBe('partial');
  });
  it('waits for an observation, times out without fallback, and cleans up', async () => {
    const waiting = waitUntilReady({ kind: 'assets' }, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(50); state.assetsReady = true;
    await vi.advanceTimersByTimeAsync(50);
    expect((await waiting).status).toBe('ready'); expect(listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    state.assetsReady = false;
    const timeout = waitUntilReady({ kind: 'assets' }, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect((await timeout).status).toBe('timed-out'); expect(listeners()).toBe(0);
  });
  it('cancels, detects same-catalog replacement and disposal, removes listeners/timers', async () => {
    const controller = new AbortController();
    const cancelled = waitUntilReady({ kind: 'assets' }, { signal: controller.signal });
    controller.abort(); expect((await cancelled).status).toBe('cancelled'); expect(listeners()).toBe(0);
    const reloaded = waitUntilReady({ kind: 'assets' }); state.scene++; emit('load');
    expect((await reloaded).status).toBe('stale'); expect(listeners()).toBe(0);
    const disposed = waitUntilReady({ kind: 'assets' }); state.renderer = null; emit('unload');
    expect((await disposed).status).toBe('stale'); expect(listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('validates bounds and malformed requests, and returns unavailable without a renderer', async () => {
    expect(() => waitUntilReady({ kind: 'assets' }, { timeoutMs: Infinity })).toThrow('timeout');
    expect(() => getReadiness({ kind: 'wrong' } as never)).toThrow('predicate');
    expect(getReadiness({ kind: 'assets' }, { scene: 99 }).status).toBe('stale');
    state.renderer = null;
    expect((await waitUntilReady({ kind: 'assets' })).status).toBe('unavailable');
  });
});
