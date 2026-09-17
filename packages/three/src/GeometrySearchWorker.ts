/**
 * A SPICE worker that runs geometry-event searches and nothing else.
 *
 * Two problems make this its own worker rather than a corner of the trajectory
 * cache's.
 *
 * The first is starvation. CSPICE is synchronous and a worker has one thread, so
 * while a search runs, every cache build queued behind it waits. Sharing meant
 * that was bounded only by how long the search took.
 *
 * The second is cancellation without `SharedArrayBuffer`. Stopping a CSPICE call
 * that is already executing needs a bail-out flag in memory both threads can
 * see, and that needs a cross-origin-isolated page — which a static host like
 * GitHub Pages cannot arrange, and which an embedding host may not grant. The
 * fallback is to terminate the worker outright, which is the one thing that
 * always stops synchronous wasm. That is only survivable if the worker is
 * expendable: terminating the shared cache worker would throw away the
 * trajectory caches and the furnished kernel pool they depend on. Terminating a
 * worker that exists solely to search throws away a search.
 *
 * So cancellation takes whichever route is open, and the caller sees the same
 * guarantee either way — the executing call stops, and the next search does not
 * queue behind an abandoned one:
 *
 *   - cross-origin isolated: the search bails out at its next poll, ~25 ms, and
 *     the worker carries on with its kernels furnished.
 *   - otherwise: the worker is terminated, and the next search transparently
 *     rebuilds it and re-furnishes. Measured at ~260 ms for a 31 MB kernel set
 *     (41 ms to instantiate the wasm, 216 ms to furnish), against the tens of
 *     seconds a long search can run for.
 *
 * The worker is created on the first search, not at load: it holds a second
 * CSPICE heap with its own copy of the catalog's SPKs, and a session that never
 * searches should not pay for it.
 */

import {
  GeometrySearchCancelled,
  SpiceCacheWorker,
  sharedCancellationAvailable,
  type GeometrySearchOptions,
  type GeometrySearchProgress,
  type KernelSource,
  type WorkerGeometrySearch,
} from './SpiceCacheWorker.js';
import type { EtInterval, EtSeconds, GeometryFinderProvider } from '@cosmolabe/core';

export interface GeometrySearchWorkerOptions {
  /**
   * Makes a fresh worker. Called on the first search and again after a restart,
   * so it must be able to produce more than one.
   */
  createWorker: () => Worker;
  /**
   * The kernels to furnish, in furnish order — precedence has to match the main
   * thread's. Re-read on every start, so whatever backs them (a URL, a dropped
   * `File`) has to stay readable for as long as searching does.
   */
  kernels: () => KernelSource[] | Promise<KernelSource[]>;
  /**
   * Whether a running CSPICE call can be interrupted in place. Defaults to
   * probing `SharedArrayBuffer`; injectable so the terminate-and-restore path
   * can be exercised on a platform where the flag would have worked.
   */
  canInterrupt?: () => boolean;
}

/** One search at a time, over a worker that may be rebuilt underneath it. */
export class GeometrySearchWorker {
  private worker: SpiceCacheWorker | null = null;
  /** In-flight start, so concurrent first calls share one worker, not two. */
  private starting: Promise<SpiceCacheWorker> | null = null;
  private active: WorkerGeometrySearch | null = null;
  private disposed = false;
  /**
   * Bumped by every restart. A start that was already in flight when the worker
   * was taken down must throw its result away rather than install a worker
   * nobody asked for over the one that replaced it.
   */
  private generation = 0;
  private readonly canInterrupt: () => boolean;

  constructor(private readonly options: GeometrySearchWorkerOptions) {
    this.canInterrupt = options.canInterrupt ?? sharedCancellationAvailable;
  }

  /**
   * True when a cancelled search stops by bailing out rather than by taking the
   * worker down with it. False still cancels; it just costs a restart.
   */
  get interruptible(): boolean {
    return this.canInterrupt();
  }

  /** True once a worker exists. Nothing creates one until the first search. */
  get started(): boolean {
    return this.worker !== null;
  }

  /** The worker, started and furnished. Shared by every caller that races here. */
  private start(): Promise<SpiceCacheWorker> {
    if (this.disposed) return Promise.reject(new Error('GeometrySearchWorker disposed'));
    if (this.starting) return this.starting;

    const generation = this.generation;
    const attempt = (async (): Promise<SpiceCacheWorker> => {
      const worker = new SpiceCacheWorker(this.options.createWorker());
      try {
        await worker.waitUntilReady();
        await worker.loadKernels(await this.options.kernels());
      } catch (err) {
        // A worker that failed to furnish would answer every search with
        // "insufficient ephemeris data". Drop it so the next search builds a new
        // one rather than inheriting a half-furnished kernel pool -- unless a
        // restart already replaced this start, in which case it owns nothing.
        worker.dispose();
        if (this.generation === generation) {
          this.starting = null;
          this.worker = null;
        }
        throw err;
      }
      if (this.disposed || this.generation !== generation) {
        worker.dispose();
        throw new Error('GeometrySearchWorker disposed');
      }
      this.worker = worker;
      return worker;
    })();

    this.starting = attempt;
    return attempt;
  }

  /**
   * Take the worker down and forget it. The next search builds a new one and
   * re-furnishes; nothing else has to know it happened.
   */
  private restart(): void {
    this.generation += 1;
    this.worker?.dispose();
    this.worker = null;
    this.starting = null;
  }

  /**
   * Begin a search. Supersedes whatever was running: one search at a time is not
   * a convenience here but a requirement, because terminating the worker to
   * cancel one search would take every other search on it down as well.
   */
  search(options?: GeometrySearchOptions): WorkerGeometrySearch {
    this.active?.cancel();

    let cancelled = false;
    let progress: GeometrySearchProgress | null = null;
    let inner: WorkerGeometrySearch | null = null;

    // The worker is built on the first call the search actually makes, so a
    // search that is superseded before it asks anything costs nothing.
    const delegate = async (): Promise<WorkerGeometrySearch> => {
      if (cancelled) throw new GeometrySearchCancelled();
      const worker = await this.start();
      if (cancelled) throw new GeometrySearchCancelled();
      return (inner ??= worker.geometrySearch({
        onProgress: (p) => {
          progress = p;
          options?.onProgress?.(p);
        },
      }));
    };

    const intervals = async (
      call: (p: GeometryFinderProvider) => EtInterval[] | Promise<EtInterval[]>,
    ): Promise<EtInterval[]> => call((await delegate()).provider);

    const handle: WorkerGeometrySearch = {
      get cancelled() { return cancelled; },
      get progress() { return progress; },
      get busy() { return inner?.busy ?? false; },
      // The guarantee, not the mechanism: a cancelled search stops the call the
      // worker is executing either way.
      interruptible: true,

      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        // Whether the worker is holding a call for *this* search, which is what
        // decides if taking it down is worth anything. A search that already
        // finished, or never started, costs nothing to cancel.
        const holdingTheWorker = inner?.busy ?? false;
        inner?.cancel();
        if (holdingTheWorker && !this.canInterrupt()) this.restart();
        if (this.active === handle) this.active = null;
      },

      provider: {
        gfdist: (target, abcorr, observer, relate, refval, adjust, step, cnfine) =>
          intervals((p) => p.gfdist(target, abcorr, observer, relate, refval, adjust, step, cnfine)),

        gfsep: (t1, s1, f1, t2, s2, f2, abcorr, observer, relate, refval, adjust, step, cnfine) =>
          intervals((p) =>
            p.gfsep(t1, s1, f1, t2, s2, f2, abcorr, observer, relate, refval, adjust, step, cnfine),
          ),

        gfoclt: (occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, cnfine) =>
          intervals((p) =>
            p.gfoclt(occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, cnfine),
          ),

        gfposc: (target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, cnfine) =>
          intervals((p) =>
            p.gfposc(target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, cnfine),
          ),

        range: async (target: string, abcorr: string, observer: string, et: EtSeconds) =>
          (await delegate()).provider.range!(target, abcorr, observer, et),
      },
    };

    this.active = handle;
    return handle;
  }

  /** Stop searching and release the worker, if one was ever built. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.cancel();
    this.active = null;
    this.restart();
  }
}
