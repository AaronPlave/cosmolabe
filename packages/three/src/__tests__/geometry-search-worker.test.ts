import { describe, it, expect, beforeAll } from 'vitest';

/**
 * The dedicated geometry worker, and the cancellation route it opens.
 *
 * Interrupting a CSPICE call in place needs a SharedArrayBuffer, so it needs a
 * cross-origin-isolated page — which GitHub Pages cannot arrange and an
 * embedding host may not grant. Where it is unavailable, cancelling instead
 * terminates this worker, which is the one thing that always stops synchronous
 * wasm. What has to hold either way is the guarantee: the executing call stops,
 * and the next search does not queue behind an abandoned one.
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
const { GeometrySearchCancelled } = await import('../SpiceCacheWorker.js');

/** Lets the client's awaits (ready, kernels, worker start) settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function harness(canInterrupt: boolean) {
  const built: FakeWorker[] = [];
  const geometry = new GeometrySearchWorker({
    createWorker: () => {
      const w = new FakeWorker();
      built.push(w);
      return w as unknown as Worker;
    },
    kernels: () => ['naif0012.tls', 'de440s.bsp'],
    canInterrupt: () => canInterrupt,
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
    const { built, geometry } = harness(true);
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
    const { built, geometry } = harness(true);
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
    const { geometry } = harness(true);
    const first = geometry.search();
    dispatch(aSearch(first.provider));
    await settle();

    geometry.search();
    expect(first.cancelled).toBe(true);
  });

  describe('when a running call can be interrupted in place', () => {
    it('cancels without taking the worker down', async () => {
      const { built, geometry } = harness(true);
      const search = geometry.search();
      const pending = aSearch(search.provider) as Promise<unknown>;
      await settle();

      search.cancel();
      await expect(pending).rejects.toBeInstanceOf(GeometrySearchCancelled);
      // The kernels stay furnished: the search bailed out, the worker did not.
      expect(built[0]!.terminated).toBe(false);
      expect(built).toHaveLength(1);
    });

    it('keeps the same worker for the next search', async () => {
      const { built, geometry } = harness(true);
      const first = geometry.search();
      dispatch(aSearch(first.provider));
      await settle();
      first.cancel();

      dispatch(aSearch(geometry.search().provider));
      await settle();
      expect(built).toHaveLength(1);
    });
  });

  describe('when it cannot', () => {
    it('terminates the worker so the executing call stops', async () => {
      const { built, geometry } = harness(false);
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
      const { built, geometry } = harness(false);
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

    it('still reports the search as interruptible, because it is', async () => {
      const { geometry } = harness(false);
      expect(geometry.interruptible).toBe(false);
      // The handle describes the guarantee the caller gets, not the mechanism
      // used to deliver it.
      expect(geometry.search().interruptible).toBe(true);
    });

    it('does not restart for a search that holds nothing', async () => {
      const { built, geometry } = harness(false);
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
      const { built, geometry } = harness(false);
      geometry.search().cancel();
      await settle();
      expect(built).toHaveLength(0);
    });
  });

  it('rejects calls made after dispose', async () => {
    const { built, geometry } = harness(true);
    dispatch(aSearch(geometry.search().provider));
    await settle();

    geometry.dispose();
    expect(built[0]!.terminated).toBe(true);
    await expect(aSearch(geometry.search().provider) as Promise<unknown>).rejects.toThrow();
  });
});
