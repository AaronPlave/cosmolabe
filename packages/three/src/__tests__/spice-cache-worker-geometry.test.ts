import { describe, it, expect, beforeAll } from 'vitest';

/**
 * The geometry half of the SPICE worker client (issue #66).
 *
 * What matters about running a geometry search in the worker is that it is the
 * *same* search: the arguments a kind builds have to reach CSPICE untouched, or
 * the off-thread path quietly answers a different question from the main-thread
 * one. The rest is cancellation, which is the reason a long search is now
 * survivable rather than merely non-freezing.
 *
 * The worker script itself is not exercised here — it imports the WASM binary
 * through a bundler-only `?url` specifier — so this pins the protocol the two
 * halves agree on, from the client's side.
 */

/** Node has no `Worker`, and the client's constructor branches on `instanceof`. */
class FakeWorkerBase {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage(_message: unknown, _transfer?: unknown[]): void {}
  terminate(): void {}
}

beforeAll(() => {
  (globalThis as { Worker?: unknown }).Worker ??= FakeWorkerBase;
});

/** A worker that records what it was sent and answers when the test says so. */
class FakeWorker extends FakeWorkerBase {
  sent: Record<string, unknown>[] = [];

  override postMessage(message: unknown): void {
    this.sent.push(message as Record<string, unknown>);
    // The real worker announces itself once its SPICE instance is up.
    if ((message as { type?: string }).type === 'init') this.reply({ type: 'ready' });
  }

  reply(message: Record<string, unknown>): void {
    this.onmessage?.({ data: message });
  }

  /** The most recent message of a type, for asserting on what was dispatched. */
  last(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

// Imported after the `Worker` shim exists, since the module is evaluated on
// import and the constructor's `instanceof Worker` would otherwise throw.
const { SpiceCacheWorker, GeometrySearchCancelled } = await import('../SpiceCacheWorker.js');

function client() {
  const fake = new FakeWorker();
  return { fake, worker: new SpiceCacheWorker(fake as unknown as Worker) };
}

/**
 * Dispatches a call the test never answers, because the assertion is on what was
 * sent rather than on what comes back. The rejection when the search is torn
 * down is expected, so it is swallowed rather than left unhandled.
 */
const dispatch = (call: unknown): void => {
  void Promise.resolve(call).catch(() => {});
};

/** Lets the client's awaits (ready, kernels) settle before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SpiceCacheWorker geometry searches', () => {
  it('passes GF arguments through untouched and returns the intervals', async () => {
    const { fake, worker } = client();
    const search = worker.geometrySearch();

    const cnfine = [{ start: 100, end: 200 }];
    const pending = search.provider.gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, cnfine);
    await settle();

    const sent = fake.last('geometry')!;
    expect(sent.fn).toBe('gfdist');
    // Argument order is the `gf*_c` order the provider interface mirrors: a
    // reordering here would be a silently different search.
    expect(sent.args).toEqual(['MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, cnfine]);

    fake.reply({ type: 'geometryResult', id: sent.id, value: [{ start: 150, end: 150 }] });
    await expect(pending).resolves.toEqual([{ start: 150, end: 150 }]);
  });

  it('measures range through the worker as a number', async () => {
    const { fake, worker } = client();
    const search = worker.geometrySearch();

    const pending = search.provider.range!('MOON', 'NONE', 'EARTH', 42);
    await settle();

    const sent = fake.last('geometry')!;
    expect(sent.fn).toBe('range');
    expect(sent.args).toEqual(['MOON', 'NONE', 'EARTH', 42]);

    fake.reply({ type: 'geometryResult', id: sent.id, value: 384_400 });
    await expect(pending).resolves.toBe(384_400);
  });

  it('rejects the call in flight when the search is cancelled', async () => {
    const { fake, worker } = client();
    const search = worker.geometrySearch();

    const pending = search.provider.gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, [
      { start: 0, end: 1 },
    ]);
    await settle();

    search.cancel();

    await expect(pending).rejects.toBeInstanceOf(GeometrySearchCancelled);
    expect(search.cancelled).toBe(true);
    // The worker is told too: a call can already be queued there, and the point
    // of cancelling is that it does not run.
    expect(fake.last('cancelGeometry')).toMatchObject({
      search: (fake.last('geometry') as { search: string }).search,
    });
  });

  it('makes no further calls once cancelled', async () => {
    const { fake, worker } = client();
    const search = worker.geometrySearch();

    search.cancel();
    const pending = search.provider.gfsep(
      'MOON', 'POINT', 'J2000', 'SUN', 'POINT', 'J2000',
      'NONE', 'EARTH', '<', 0.1, 0, 3600, [{ start: 0, end: 1 }],
    );

    await expect(pending).rejects.toBeInstanceOf(GeometrySearchCancelled);
    await settle();
    // Not merely discarded on arrival — never dispatched. This is what makes a
    // superseded search stop doing work.
    expect(fake.sent.filter((m) => m.type === 'geometry')).toHaveLength(0);
  });

  it('cancels one search without disturbing another', async () => {
    const { fake, worker } = client();
    const abandoned = worker.geometrySearch();
    const kept = worker.geometrySearch();

    const dropped = abandoned.provider.gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, [
      { start: 0, end: 1 },
    ]);
    await settle();
    const droppedId = fake.last('geometry')!.id;

    const wanted = kept.provider.gfdist('MARS', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, [
      { start: 0, end: 1 },
    ]);
    await settle();
    const wantedId = fake.last('geometry')!.id;

    abandoned.cancel();
    await expect(dropped).rejects.toBeInstanceOf(GeometrySearchCancelled);
    expect(droppedId).not.toBe(wantedId);

    fake.reply({ type: 'geometryResult', id: wantedId, value: [{ start: 7, end: 7 }] });
    await expect(wanted).resolves.toEqual([{ start: 7, end: 7 }]);
    expect(kept.cancelled).toBe(false);
  });

  it('surfaces a worker-side cancellation as a cancellation, not a fault', async () => {
    const { fake, worker } = client();
    const search = worker.geometrySearch();

    const pending = search.provider.gfoclt(
      'ANY', 'MOON', 'ELLIPSOID', 'IAU_MOON', 'SUN', 'ELLIPSOID', 'IAU_SUN',
      'NONE', 'EARTH', 300, [{ start: 0, end: 1 }],
    );
    await settle();

    // The worker drops a call whose search was cancelled while it sat in the
    // queue; the caller must be able to tell that from a search that failed.
    fake.reply({ type: 'geometryCancelled', id: fake.last('geometry')!.id });
    await expect(pending).rejects.toBeInstanceOf(GeometrySearchCancelled);
  });

  it('routes progress reports to the caller while the call is still running', async () => {
    const { fake, worker } = client();
    const seen: { fraction: number; pass: number }[] = [];
    const search = worker.geometrySearch({ onProgress: (p) => seen.push(p) });

    const pending = search.provider.gfdist('MOON', 'NONE', 'EARTH', '<', 4e5, 0, 3600, [
      { start: 0, end: 1 },
    ]);
    await settle();
    const sent = fake.last('geometry')!;
    expect(sent.report).toMatchObject({ progress: true });

    // Progress shares the call's id and does not settle it: the search is still
    // running, and more reports (then a result) follow under the same id.
    fake.reply({ type: 'geometryProgress', id: sent.id, fraction: 0.25, pass: 1 });
    fake.reply({ type: 'geometryProgress', id: sent.id, fraction: 0.5, pass: 2 });
    expect(seen).toEqual([{ fraction: 0.25, pass: 1 }, { fraction: 0.5, pass: 2 }]);
    expect(search.progress).toEqual({ fraction: 0.5, pass: 2 });

    fake.reply({ type: 'geometryResult', id: sent.id, value: [] });
    await expect(pending).resolves.toEqual([]);
  });

  it('asks for no progress when the caller wants none', async () => {
    const { fake, worker } = client();
    const search = worker.geometrySearch();

    dispatch(search.provider.gfdist('MOON', 'NONE', 'EARTH', '<', 4e5, 0, 3600, [{ start: 0, end: 1 }]));
    await settle();

    // No report at all, not a report asking for nothing: the worker reads that
    // as "use the simplified CSPICE wrappers", which is where a search with
    // nothing to report belongs. Every progress report is a postMessage from
    // inside a running CSPICE call, and a caller with nothing to show should
    // not be paying for them.
    expect(fake.last('geometry')!.report).toBeUndefined();
  });

  it('sends no report on range, which has no progress and nothing to interrupt', async () => {
    const { fake, worker } = client();
    const search = worker.geometrySearch({ onProgress: () => {} });

    dispatch(search.provider.range!('MOON', 'NONE', 'EARTH', 42));
    await settle();

    expect(fake.last('geometry')!.report).toBeUndefined();
  });

  it('reports a SPICE error from the worker as an error', async () => {
    const { fake, worker } = client();
    const search = worker.geometrySearch();

    const pending = search.provider.gfposc(
      'MOON', 'J2000', 'NONE', 'EARTH', 'LATITUDINAL', 'LATITUDE', '>', 0, 0, 3600,
      [{ start: 0, end: 1 }],
    );
    await settle();

    fake.reply({
      type: 'error', id: fake.last('geometry')!.id, message: 'Insufficient ephemeris data',
    });
    await expect(pending).rejects.toThrow('Insufficient ephemeris data');
  });

  it('furnishes dropped kernels as bytes, in the order given', async () => {
    const { fake, worker } = client();
    const data = new ArrayBuffer(8);
    const loading = worker.loadKernels(['naif0012.tls', { name: 'mission.bsp', data }]);
    await settle();

    // A kernel the user dropped has no URL for the worker to fetch, and a
    // worker missing it would answer a different question from the main thread.
    const first = fake.last('loadKernel')!;
    expect(first).toMatchObject({ url: 'naif0012.tls' });
    fake.reply({ type: 'kernelLoaded', id: first.id });
    await settle();

    const second = fake.last('loadKernel')!;
    expect(second).toMatchObject({ name: 'mission.bsp', data });
    fake.reply({ type: 'kernelLoaded', id: second.id });
    await expect(loading).resolves.toBeUndefined();
  });

  it('rejects outstanding searches when the worker is disposed', async () => {
    const { fake, worker } = client();
    const search = worker.geometrySearch();

    const pending = search.provider.gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, [
      { start: 0, end: 1 },
    ]);
    await settle();
    expect(fake.last('geometry')).toBeDefined();

    // A scene replacement disposes the worker under any search still running.
    // The caller has to hear about it rather than waiting on an answer that is
    // never coming.
    worker.dispose();
    await expect(pending).rejects.toThrow('Worker disposed');

    await expect(
      search.provider.gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, [{ start: 0, end: 1 }]),
    ).rejects.toThrow('Worker disposed');
  });

  it('waits for the kernels before searching', async () => {
    const { fake, worker } = client();
    const loading = worker.loadKernels(['naif0012.tls']);
    const search = worker.geometrySearch();

    const pending = search.provider.gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, [
      { start: 0, end: 1 },
    ]);
    await settle();

    // A search dispatched before the furnish finished would fail on every body
    // in the catalog.
    expect(fake.last('geometry')).toBeUndefined();

    const kernel = fake.last('loadKernel')!;
    fake.reply({ type: 'kernelLoaded', id: kernel.id });
    await loading;
    await settle();

    const sent = fake.last('geometry')!;
    expect(sent.fn).toBe('gfdist');
    fake.reply({ type: 'geometryResult', id: sent.id, value: [] });
    await expect(pending).resolves.toEqual([]);
  });

  /**
   * A kernel dropped onto a scene that is already up.
   *
   * The host furnishes it into its own SPICE and hands it here; the worker must
   * end up with the same kernels in the same order (#68), without being rebuilt
   * -- it is holding the scene's trajectory caches.
   */
  describe('kernels added after the scene loaded', () => {
    /** Answers each `loadKernel` as it arrives, as the real worker does. */
    const autoLoad = (fake: FakeWorker) => {
      const seen = new Set<unknown>();
      return async () => {
        for (let i = 0; i < 10; i++) {
          await settle();
          for (const message of fake.sent) {
            if (message.type !== 'loadKernel' || seen.has(message.id)) continue;
            seen.add(message.id);
            fake.reply({ type: 'kernelLoaded', id: message.id });
          }
        }
      };
    };

    const loadedNames = (fake: FakeWorker) =>
      fake.sent.filter((m) => m.type === 'loadKernel').map((m) => m.url ?? m.name);

    it('appends to what the scene furnished, in order', async () => {
      const { fake, worker } = client();
      const drain = autoLoad(fake);

      const scene = worker.loadKernels(['naif0012.tls', 'pck00011.tpc', 'de440s.bsp']);
      await drain();
      await scene;

      const dropped = worker.loadKernels([{ name: 'mine.bsp', data: new ArrayBuffer(8) }]);
      await drain();
      await dropped;

      expect(loadedNames(fake)).toEqual([
        'naif0012.tls', 'pck00011.tpc', 'de440s.bsp', 'mine.bsp',
      ]);
    });

    it('does not let a search run between the two loads', async () => {
      // The append is chained onto the load in flight, so a cache build or
      // search dispatched meanwhile waits for both -- not just the later one.
      const { fake, worker } = client();
      const scene = worker.loadKernels(['naif0012.tls', 'de440s.bsp']);
      const dropped = worker.loadKernels([{ name: 'mine.bsp', data: new ArrayBuffer(8) }]);

      const search = worker.geometrySearch();
      const pending = search.provider.gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 0, 3600, [
        { start: 0, end: 1 },
      ]);
      await settle();

      // Only the first kernel has been dispatched; nothing may search yet.
      expect(fake.last('geometry')).toBeUndefined();

      await autoLoad(fake)();
      await scene;
      await dropped;
      await settle();

      expect(loadedNames(fake)).toEqual(['naif0012.tls', 'de440s.bsp', 'mine.bsp']);
      const sent = fake.last('geometry')!;
      expect(sent.fn).toBe('gfdist');
      fake.reply({ type: 'geometryResult', id: sent.id, value: [] });
      await expect(pending).resolves.toEqual([]);
    });
  });
});
