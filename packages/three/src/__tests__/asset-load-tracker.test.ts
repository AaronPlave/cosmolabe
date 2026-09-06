import { describe, it, expect } from 'vitest';
import { AssetLoadTracker, type AssetRequest } from '../AssetLoadTracker.js';

/**
 * The tracker is what stands between "the scene graph exists" and "the scene
 * looks like itself" (issue #19). The properties worth pinning are the ones a
 * loading UI depends on: it waits for assets that are still coming, it does not
 * wait forever on one that never arrives, and it says what is missing.
 */

const req = (over: Partial<AssetRequest> = {}): AssetRequest => ({
  kind: 'texture',
  owner: 'Saturn',
  role: 'baseMap',
  url: 'https://example.invalid/saturn.jpg',
  ...over,
});

/** A promise plus its settle handles, so a test controls when a load finishes. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('AssetLoadTracker', () => {
  it('does not settle while an asset is still loading', async () => {
    const tracker = new AssetLoadTracker();
    const load = deferred();
    tracker.track(req(), load.promise);

    let settled = false;
    const waiting = tracker.settle({ timeoutMs: 5000 }).then((s) => { settled = true; return s; });

    // Several turns of the event loop with the load still open: a gate that
    // resolves here is the bug this class exists to prevent.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);

    load.resolve();
    const summary = await waiting;
    expect(summary.loaded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.timedOut).toBe(false);
  });

  it('counts a failed load and reports why, without staying pending', async () => {
    const tracker = new AssetLoadTracker();
    tracker.track(req({ role: 'normalMap' }), Promise.reject(new Error('HTTP 404')));
    tracker.track(req({ role: 'baseMap' }), Promise.resolve());

    const summary = await tracker.settle({ timeoutMs: 5000 });
    expect(summary.total).toBe(2);
    expect(summary.loaded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.timedOut).toBe(false);
    expect(summary.failures).toEqual([
      expect.objectContaining({ owner: 'Saturn', role: 'normalMap', reason: 'HTTP 404' }),
    ]);
  });

  it('counts an asset that was never fetchable at all', async () => {
    const tracker = new AssetLoadTracker();
    tracker.fail(req({ kind: 'model', role: 'model', url: 'cassini.cmod' }), 'source did not resolve');

    const summary = await tracker.settle({ timeoutMs: 5000 });
    expect(summary.total).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures[0].reason).toBe('source did not resolve');
  });

  it('waits for assets registered part-way through a held job', async () => {
    // The .cmod case: the model's material textures are only knowable once the
    // mesh has parsed, so they join the set after the settle wait has begun.
    const tracker = new AssetLoadTracker();
    const model = deferred();
    const texture = deferred();
    tracker.hold(model.promise);

    let settled = false;
    const waiting = tracker.settle({ timeoutMs: 5000 }).then((s) => { settled = true; return s; });

    model.resolve();
    // Registered a full task after the model resolved — later than a naive
    // "await everything currently in flight" would look.
    await new Promise((r) => setTimeout(r, 0));
    tracker.track(req({ role: 'cmod:hull.png' }), texture.promise);

    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);

    texture.resolve();
    const summary = await waiting;
    expect(summary.total).toBe(1);
    expect(summary.loaded).toBe(1);
  });

  it('abandons a load that never settles at the deadline, and names it', async () => {
    const tracker = new AssetLoadTracker();
    tracker.track(req({ role: 'displacementMap', url: 'stalled.dds' }), new Promise(() => {}));
    tracker.track(req({ role: 'baseMap' }), Promise.resolve());

    const summary = await tracker.settle({ timeoutMs: 20 });
    expect(summary.timedOut).toBe(true);
    expect(summary.loaded).toBe(1);
    expect(summary.stillPending).toEqual([
      expect.objectContaining({ role: 'displacementMap', url: 'stalled.dds' }),
    ]);
  });

  it('holds readiness for a computed trajectory cache, and records one that fails', async () => {
    // A spacecraft's trail is hidden until its cache lands, so the build belongs
    // in the same gate as the textures even though nothing is being fetched.
    // (Renderer-level wiring for this needs SPICE kernels and a GL context; what
    // is pinned here is that the tracker treats a computed asset like any other.)
    const tracker = new AssetLoadTracker();
    const cassini = deferred();
    tracker.track(
      { kind: 'trajectory', owner: 'Cassini', role: 'trajectoryCache', url: 'spice:-82@ECLIPJ2000' },
      cassini.promise,
    );
    tracker.track(req(), Promise.resolve());

    let settled = false;
    const waiting = tracker.settle({ timeoutMs: 5000 }).then((s) => { settled = true; return s; });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);

    cassini.reject(new Error('worker returned an empty cache; the sync fallback found no states either'));
    const summary = await waiting;
    expect(summary.loaded).toBe(1);
    expect(summary.failures).toEqual([
      expect.objectContaining({ kind: 'trajectory', owner: 'Cassini' }),
    ]);
  });

  it('settles immediately when the catalog needs no assets', async () => {
    const tracker = new AssetLoadTracker();
    const summary = await tracker.settle({ timeoutMs: 5000 });
    expect(summary).toMatchObject({ total: 0, loaded: 0, failed: 0, timedOut: false });
  });

  it('returns the same summary to every caller, including after the fact', async () => {
    const tracker = new AssetLoadTracker();
    tracker.track(req(), Promise.resolve());

    const [a, b] = await Promise.all([
      tracker.settle({ timeoutMs: 5000 }),
      tracker.settle({ timeoutMs: 5000 }),
    ]);
    expect(a).toBe(b);
    expect(tracker.isSettled).toBe(true);

    // A dynamically streamed asset after the gate must not rewrite the summary
    // the viewer already acted on.
    tracker.track(req({ role: 'streamed' }), Promise.reject(new Error('later failure')));
    await new Promise((r) => setTimeout(r, 5));
    expect(await tracker.settle()).toBe(a);
    expect(a.failed).toBe(0);
  });

  it('reports progress as assets register and settle', async () => {
    const tracker = new AssetLoadTracker();
    const seen: string[] = [];
    tracker.onProgress((p) => seen.push(`${p.settled}/${p.total}`));

    const first = deferred();
    tracker.track(req({ role: 'baseMap' }), first.promise);
    tracker.track(req({ role: 'normalMap' }), Promise.resolve());
    first.resolve();

    await tracker.settle({ timeoutMs: 5000 });
    expect(seen[0]).toBe('0/1');
    expect(seen[1]).toBe('0/2');
    expect(seen[seen.length - 1]).toBe('2/2');
  });

  it('handles a rejected load with no other handler attached', async () => {
    // BodyMesh hands over promises it also awaits, but the ring-texture path
    // hands over one nobody else touches — that must not surface as an
    // unhandled rejection.
    const tracker = new AssetLoadTracker();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent | unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      tracker.track(req({ role: 'ringTexture' }), Promise.reject(new Error('boom')));
      const summary = await tracker.settle({ timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 5));
      expect(summary.failed).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
