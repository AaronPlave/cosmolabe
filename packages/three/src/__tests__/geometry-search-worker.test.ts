import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * The dedicated geometry worker, and the cancellation route it opens.
 *
 * Cancelling a running search terminates this worker, which is the one thing
 * that always stops synchronous wasm — a worker blocked inside CSPICE cannot
 * read its own message queue. That is survivable because the worker exists only
 * to search: the next search rebuilds it and re-furnishes transparently. What
 * has to hold is the guarantee: the executing call stops, and the next search
 * does not queue behind an abandoned one.
 *
 * The worker script is not exercised here — it imports the WASM binary through
 * a bundler-only `?url` specifier — so these pin the lifecycle the two halves
 * agree on, from the main thread's side.
 */

class FakeWorkerBase {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage(_message: unknown, _transfer?: unknown[]): void {}
  terminate(): void {}
}

beforeAll(() => {
  (globalThis as { Worker?: unknown }).Worker ??= FakeWorkerBase;
});

/** Records what it was sent, answers `init`, and remembers being terminated. */
class FakeWorker extends FakeWorkerBase {
  sent: Record<string, unknown>[] = [];
  terminated = false;

  override postMessage(message: unknown): void {
    this.sent.push(message as Record<string, unknown>);
    const msg = message as { type?: string; id?: string };
    if (msg.type === 'init') this.reply({ type: 'ready' });
    // Kernels resolve immediately; the tests are about the lifecycle around
    // them, not about furnishing.
    if (msg.type === 'loadKernel') this.reply({ type: 'kernelLoaded', id: msg.id });
  }

  override terminate(): void {
    this.terminated = true;
  }

  reply(message: Record<string, unknown>): void {
    this.onmessage?.({ data: message });
  }

  last(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

const { GeometrySearchWorker } = await import('../GeometrySearchWorker.js');
type GeometrySearchWorkerInstance = InstanceType<typeof GeometrySearchWorker>;
const { GeometrySearchCancelled } = await import('../SpiceCacheWorker.js');

/** Lets the client's awaits (ready, kernels, worker start) settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function harness(idleTimeoutMs?: number) {
  const built: FakeWorker[] = [];
  const geometry = new GeometrySearchWorker({
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    createWorker: () => {
      const w = new FakeWorker();
      built.push(w);
      return w as unknown as Worker;
    },
    // Narrowed per scope, as the viewer's provider is: the scope's key names
    // the set, so a start for a different key must furnish a different list.
    kernels: (scope) =>
      scope ? ['naif0012.tls', `${scope.key}.bsp`] : ['naif0012.tls', 'de440s.bsp'],
  });
  return { built, geometry };
}

/** A call the test never answers; the teardown rejection is expected. */
const dispatch = (call: unknown): void => {
  void Promise.resolve(call).catch(() => {});
};

const aSearch = (p: { gfdist: (...a: never[]) => unknown }): unknown =>
  (p.gfdist as (...a: unknown[]) => unknown)('MOON', 'NONE', 'EARTH', '<', 4e5, 0, 3600, [
    { start: 0, end: 1 },
  ]);

describe('GeometrySearchWorker', () => {
  it('builds no worker until a search actually calls', async () => {
    const { built, geometry } = harness();
    expect(built).toHaveLength(0);

    // Even taking a handle costs nothing: it is the first call that starts the
    // worker, so a session that never searches never pays for a second CSPICE
    // heap and a second copy of the catalog's SPKs.
    const search = geometry.search();
    await settle();
    expect(built).toHaveLength(0);
    expect(geometry.started).toBe(false);

    dispatch(aSearch(search.provider));
    await settle();
    expect(built).toHaveLength(1);
    expect(geometry.started).toBe(true);
  });

  it('furnishes the kernels before dispatching a search', async () => {
    const { built, geometry } = harness();
    dispatch(aSearch(geometry.search().provider));
    await settle();

    const worker = built[0]!;
    const kernels = worker.sent.filter((m) => m.type === 'loadKernel');
    expect(kernels.map((m) => m.url)).toEqual(['naif0012.tls', 'de440s.bsp']);
    // Order matters: furnish order is kernel precedence, and a search on a
    // differently-ordered pool quietly answers a different question.
    expect(worker.sent.indexOf(kernels[1]!)).toBeLessThan(
      worker.sent.indexOf(worker.last('geometry')!),
    );
  });

  it('supersedes the running search, because terminating would kill both', async () => {
    const { geometry } = harness();
    const first = geometry.search();
    dispatch(aSearch(first.provider));
    await settle();

    geometry.search();
    expect(first.cancelled).toBe(true);
  });

  describe('cancelling a running search', () => {
    it('terminates the worker so the executing call stops', async () => {
      const { built, geometry } = harness();
      const search = geometry.search();
      const pending = aSearch(search.provider) as Promise<unknown>;
      await settle();
      expect(built[0]!.terminated).toBe(false);

      search.cancel();
      await expect(pending).rejects.toBeInstanceOf(GeometrySearchCancelled);
      // The only thing that stops synchronous wasm. Without this the call runs
      // to completion and the next search waits on it.
      expect(built[0]!.terminated).toBe(true);
    });

    it('rebuilds and re-furnishes for the next search', async () => {
      const { built, geometry } = harness();
      const first = geometry.search();
      dispatch(aSearch(first.provider));
      await settle();
      first.cancel();

      const second = geometry.search();
      dispatch(aSearch(second.provider));
      await settle();

      expect(built).toHaveLength(2);
      expect(built[1]!.terminated).toBe(false);
      // Transparently: the caller asked for a search, not for a worker.
      expect(built[1]!.sent.filter((m) => m.type === 'loadKernel').map((m) => m.url))
        .toEqual(['naif0012.tls', 'de440s.bsp']);
      expect(built[1]!.last('geometry')).toBeDefined();
    });

    it('does not restart for a search that holds nothing', async () => {
      const { built, geometry } = harness();
      const search = geometry.search();
      dispatch(aSearch(search.provider));
      await settle();

      // Answer it, so the search owns no call in the worker.
      const worker = built[0]!;
      worker.reply({ type: 'geometryResult', id: worker.last('geometry')!.id, value: [] });
      await settle();
      expect(search.busy).toBe(false);

      search.cancel();
      // Superseding a finished search is what the viewer does on every re-run.
      // Paying a worker restart for it would make editing the form expensive.
      expect(worker.terminated).toBe(false);
    });

    it('does not restart a worker that was never started', async () => {
      const { built, geometry } = harness();
      geometry.search().cancel();
      await settle();
      expect(built).toHaveLength(0);
    });
  });

  describe('when a search needs a different kernel set', () => {
    it('rebuilds the worker, because the furnished pool is the wrong one', async () => {
      // The reason the scope exists: this worker holds its own copy of every
      // kernel it is given, so it is furnished for one search's window rather
      // than for the whole catalog. A worker furnished for another window is
      // missing files this search needs and holding files it cannot reach.
      const { built, geometry } = harness();
      dispatch(aSearch(geometry.search({ scope: { key: 'phase1' } }).provider));
      await settle();
      expect(built).toHaveLength(1);

      dispatch(aSearch(geometry.search({ scope: { key: 'phase2' } }).provider));
      await settle();

      expect(built).toHaveLength(2);
      expect(built[1]!.sent.filter((m) => m.type === 'loadKernel').map((m) => m.url))
        .toEqual(['naif0012.tls', 'phase2.bsp']);
    });

    it('keeps the worker when the set is unchanged', async () => {
      // Two windows inside one mission phase need the same files, and editing a
      // query and re-running is the common case. Rebuilding there would make it
      // cost a re-furnish every time.
      //
      // The first search is answered before the second starts, because a second
      // search that supersedes a *running* one cancels it, and cancelling a
      // running search terminates the worker whatever its scope. That is the
      // cost of the single cancellation mechanism, priced separately below; it
      // would mask what this test is about.
      const { built, geometry } = harness();
      const first = geometry.search({ scope: { key: 'phase1' } });
      dispatch(aSearch(first.provider));
      await settle();
      const worker = built[0]!;
      worker.reply({ type: 'geometryResult', id: worker.last('geometry')!.id, value: [] });
      await settle();
      first.finish();

      dispatch(aSearch(geometry.search({ scope: { key: 'phase1' } }).provider));
      await settle();

      expect(built).toHaveLength(1);
    });

    it('rebuilds when a scoped search supersedes a running one', async () => {
      // The flip side, stated so the cost is not a surprise: superseding a
      // search the worker is executing terminates it, so the next search pays a
      // rebuild even when it needs exactly the same kernels.
      const { built, geometry } = harness();
      dispatch(aSearch(geometry.search({ scope: { key: 'phase1' } }).provider));
      await settle();

      dispatch(aSearch(geometry.search({ scope: { key: 'phase1' } }).provider));
      await settle();

      expect(built).toHaveLength(2);
      expect(built[0]!.terminated).toBe(true);
    });

    it('rebuilds when a scoped search follows an unscoped one', async () => {
      // No scope means the caller's full set, which is a different pool again.
      // Treating absent as "matches anything" would run a narrowed search
      // against the whole catalog, or worse, the reverse.
      const { built, geometry } = harness();
      dispatch(aSearch(geometry.search().provider));
      await settle();

      dispatch(aSearch(geometry.search({ scope: { key: 'phase1' } }).provider));
      await settle();
      expect(built).toHaveLength(2);

      dispatch(aSearch(geometry.search().provider));
      await settle();
      expect(built).toHaveLength(3);
      expect(built[2]!.sent.filter((m) => m.type === 'loadKernel').map((m) => m.url))
        .toEqual(['naif0012.tls', 'de440s.bsp']);
    });

    it('builds nothing extra when the first search is scoped', async () => {
      // The rebuild check runs on every search, including the first. With no
      // worker yet there is nothing to rebuild, and restarting here would be a
      // wasted generation bump.
      const { built, geometry } = harness();
      dispatch(aSearch(geometry.search({ scope: { key: 'phase1' } }).provider));
      await settle();
      expect(built).toHaveLength(1);
    });
  });

  describe('releasing an idle worker', () => {
    // Fake timers from the first line of each test: the release is armed when a
    // call settles, so a timer installed afterwards would never see it. That
    // makes the harness's real-setTimeout settle() unusable here, hence the
    // async advance below, which flushes microtasks and zero-delay timers alike.
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const tick = async (): Promise<void> => {
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
    };

    /** Answer the worker's outstanding geometry call, so nothing is in flight. */
    const answer = (worker: FakeWorker): void => {
      worker.reply({ type: 'geometryResult', id: worker.last('geometry')!.id, value: [] });
    };

    /** One complete search: dispatched, started, and answered. */
    const runSearch = async (geometry: GeometrySearchWorkerInstance, worker: () => FakeWorker | undefined) => {
      dispatch(aSearch(geometry.search().provider));
      await tick();
      const w = worker();
      if (w) { answer(w); await tick(); }
    };

    it('takes the worker down once searching stops', async () => {
      // 235 MB on the Cassini catalog -- a CSPICE heap plus its kernels -- held
      // for a feature used in bursts. Releasing it is the same teardown a
      // cancellation already performs when it terminates a running search.
      const { built, geometry } = harness(60_000);
      await runSearch(geometry, () => built[0]);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(built[0]!.terminated).toBe(true);
      expect(geometry.started).toBe(false);
    });

    it('keeps it while a call is still in flight', async () => {
      // A search is however many calls its kind makes, and the last looks like
      // the rest. Releasing between two of them would terminate CSPICE
      // mid-search and lose the answer.
      const { built, geometry } = harness(60_000);
      dispatch(aSearch(geometry.search().provider));
      await tick();

      await vi.advanceTimersByTimeAsync(600_000);
      expect(built[0]!.terminated).toBe(false);
    });

    it('rebuilds transparently for the next search', async () => {
      const { built, geometry } = harness(60_000);
      await runSearch(geometry, () => built[0]);
      await vi.advanceTimersByTimeAsync(60_000);

      await runSearch(geometry, () => built[1]);
      expect(built).toHaveLength(2);
      // Re-furnished, and the search actually reached it: a released worker
      // that came back empty would answer every search with no ephemeris.
      expect(built[1]!.sent.filter((m) => m.type === 'loadKernel')).toHaveLength(2);
      expect(built[1]!.last('geometry')).toBeDefined();
    });

    it('pushes the release back on each new call', async () => {
      // Otherwise a burst of searches would each pay a rebuild, which is the
      // opposite of what the timeout is for.
      const { built, geometry } = harness(60_000);
      await runSearch(geometry, () => built[0]);
      await vi.advanceTimersByTimeAsync(59_000);

      await runSearch(geometry, () => built[0]);
      await vi.advanceTimersByTimeAsync(59_000);

      expect(built[0]!.terminated).toBe(false);
      expect(built).toHaveLength(1);
    });

    it('rebinds a surviving handle to the new worker', async () => {
      // The handle outlives the worker it started on. Its inner search belongs
      // to the disposed one, so reusing it would post into a terminated worker
      // and hang -- a call that never settles, with no error to show for it.
      const { built, geometry } = harness(60_000);
      const search = geometry.search();
      dispatch(aSearch(search.provider));
      await tick();
      answer(built[0]!);
      await tick();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(built[0]!.terminated).toBe(true);
      // A handle holding a disposed worker's search is holding nothing.
      expect(search.busy).toBe(false);

      // The same handle, used again: it must reach the new worker.
      dispatch(aSearch(search.provider));
      await tick();
      expect(built).toHaveLength(2);
      expect(built[1]!.last('geometry')).toBeDefined();
    });

    it('waits for the caller to say the search is over', async () => {
      // `finish` is the signal, not the gap between calls: a caller that has
      // not finished still owns the worker.
      const { built, geometry } = harness(60_000);
      const search = geometry.search();
      dispatch(aSearch(search.provider));
      await tick();
      answer(built[0]!);
      await tick();

      search.finish();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(built[0]!.terminated).toBe(true);
    });

    it('will not release while a provider call is still outstanding', async () => {
      // `finish` can arrive while a call is still in flight -- from a `finally`
      // that runs before the last call settles, or from a caller that simply
      // got it wrong. Arming there would fire into a running CSPICE call and
      // terminate the worker mid-search, losing the answer.
      const { built, geometry } = harness(60_000);
      const search = geometry.search();
      dispatch(aSearch(search.provider));
      await tick();

      search.finish();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(built[0]!.terminated).toBe(false);

      // And once the call does settle, the release goes ahead as normal.
      answer(built[0]!);
      await tick();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(built[0]!.terminated).toBe(true);
    });

    it('waits for every outstanding call, not just the last to settle', async () => {
      // The provider's methods are ordinary async functions and nothing stops a
      // caller firing two without awaiting the first. Releasing when any one of
      // them settles would terminate the worker under the others.
      const { built, geometry } = harness(60_000);
      const search = geometry.search();
      dispatch(aSearch(search.provider));
      dispatch(aSearch(search.provider));
      await tick();

      const worker = built[0]!;
      const geometryCalls = worker.sent.filter((m) => m.type === 'geometry');
      expect(geometryCalls).toHaveLength(2);

      // Answer one. The other is still running, so nothing may be released.
      worker.reply({ type: 'geometryResult', id: geometryCalls[0]!.id, value: [] });
      await tick();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(worker.terminated).toBe(false);

      worker.reply({ type: 'geometryResult', id: geometryCalls[1]!.id, value: [] });
      await tick();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(worker.terminated).toBe(true);
    });

    it('does not push the release back when finish is called twice', async () => {
      // A `finally` can run more than once across a retry, and a caller may
      // simply be defensive. Re-arming each time would let a worker outlive its
      // timeout indefinitely at no cost to the caller.
      const { built, geometry } = harness(60_000);
      const search = geometry.search();
      dispatch(aSearch(search.provider));
      await tick();
      answer(built[0]!);
      await tick();

      search.finish();
      await vi.advanceTimersByTimeAsync(30_000);
      search.finish();
      // 60s after the *first* finish, not the second.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(built[0]!.terminated).toBe(true);
    });

    it('keeps the worker for the session when no timeout is set', async () => {
      const { built, geometry } = harness();
      await runSearch(geometry, () => built[0]);

      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(built[0]!.terminated).toBe(false);
    });
  });

  it('rejects calls made after dispose', async () => {
    const { built, geometry } = harness();
    dispatch(aSearch(geometry.search().provider));
    await settle();

    geometry.dispose();
    expect(built[0]!.terminated).toBe(true);
    await expect(aSearch(geometry.search().provider) as Promise<unknown>).rejects.toThrow();
  });
});
