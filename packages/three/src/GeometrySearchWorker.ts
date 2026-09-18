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
 * The second is cancellation. A CSPICE call already executing cannot be
 * interrupted from outside by any ordinary means: the worker is blocked inside
 * synchronous wasm and will not read its own message queue until the call
 * returns. Terminating the worker is the one thing that always stops it — and
 * that is only survivable if the worker is expendable. Terminating the cache
 * worker would throw away the trajectory caches and the kernel pool they depend
 * on; terminating a worker that exists solely to search throws away a search.
 *
 * So cancelling a running search terminates this worker, and the next search
 * transparently rebuilds it and re-furnishes — about a second for the narrowed
 * kernel set a search actually needs, against the tens of seconds a long search
 * can run for.
 *
 * `cspice-wasm` does offer a cooperative bail-out, polled by CSPICE from inside
 * the running call, which stops a search in ~25 ms and keeps the worker's
 * kernels furnished. It is deliberately not used here. It needs a
 * `SharedArrayBuffer` to reach a thread already inside CSPICE, so it needs a
 * cross-origin-isolated page — which GitHub Pages cannot arrange and an
 * embedding host may not grant. Carrying it would mean two cancellation paths,
 * a COOP/COEP requirement, and behaviour that differs by host, to save about a
 * second on the one flow where a user aborts a running search and immediately
 * starts another. It stays available to library callers who know their page is
 * isolated; Cosmolabe takes the single mechanism that works everywhere.
 *
 * The worker is created on the first search, not at load: it holds a second
 * CSPICE heap with its own copy of the catalog's SPKs, and a session that never
 * searches should not pay for it.
 */

import {
  GeometrySearchCancelled,
  SpiceCacheWorker,
  type GeometrySearchOptions,
  type GeometrySearchProgress,
  type KernelSource,
  type WorkerGeometrySearch,
} from './SpiceCacheWorker.js';
import type { EtInterval, EtSeconds, GeometryFinderProvider } from '@cosmolabe/core';

/**
 * What a search needs furnished, as its caller understands it.
 *
 * This worker holds a second copy of every kernel it is given, so a caller that
 * can narrow the set to what one search can reach saves that much memory for as
 * long as the worker lives. Which kernels those are is the caller's judgement,
 * not this class's — all it does is carry the scope through to `kernels` and
 * notice when the key changes.
 */
export interface GeometrySearchScope {
  /**
   * Identity of the kernel set. A search whose key differs from the furnished
   * worker's rebuilds it; one that matches reuses it, so editing a query within
   * a mission phase costs nothing.
   */
  readonly key: string;
}

/**
 * A search this worker is running, plus the caller's say in when it is over.
 *
 * The extra method is `finish`, and it exists because the worker's lifetime has
 * to be decided by someone who knows what a search *is*. From in here a search
 * is an unpredictable number of provider calls whose last one looks exactly
 * like the rest; only the caller driving them knows when there will be no more.
 */
export interface GeometrySearch extends WorkerGeometrySearch {
  /**
   * The caller is done with this search, successfully or not.
   *
   * Idempotent, and safe to call from a `finally`. It releases the caller's
   * claim on the worker; it does not cancel anything still running, which is
   * what `cancel` is for.
   */
  finish(): void;
}

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
   *
   * Given the scope of the search that triggered the start, when one was
   * supplied. The list it returns must be the one the scope's key names, or a
   * worker will be reused for a search it is not furnished for.
   */
  kernels: (scope?: GeometrySearchScope) => KernelSource[] | Promise<KernelSource[]>;
  /**
   * How long the worker may sit idle before it is released, in milliseconds.
   * Zero or absent keeps it alive for the session.
   *
   * It is expensive to keep and cheap to rebuild, which is the whole argument
   * for releasing it. Measured on the Cassini catalog: 235 MB held — a CSPICE
   * instance's fixed 160 MB heap plus its kernels — against a rebuild that
   * re-furnishes only the handful of kernels the next search can reach. A
   * feature used in bursts should not hold a quarter of a gigabyte between
   * them.
   *
   * This is the same teardown a cancellation performs, so it is not a new
   * failure mode: the next search rebuilds transparently, and a dropped kernel
   * that has since been moved fails the same way it already would.
   */
  idleTimeoutMs?: number;
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
  /**
   * The scope key the live worker is furnished for, so a search needing a
   * different kernel set rebuilds rather than running against the wrong pool.
   * Null when no scope was given, which means the caller's full set.
   */
  private furnishedFor: string | null = null;
  /** Pending release of an idle worker; cleared whenever one is wanted again. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: GeometrySearchWorkerOptions) {}

  /** True once a worker exists. Nothing creates one until the first search. */
  get started(): boolean {
    return this.worker !== null;
  }

  /** The worker, started and furnished. Shared by every caller that races here. */
  private start(scope?: GeometrySearchScope): Promise<SpiceCacheWorker> {
    if (this.disposed) return Promise.reject(new Error('GeometrySearchWorker disposed'));
    if (this.starting) return this.starting;

    const generation = this.generation;
    const attempt = (async (): Promise<SpiceCacheWorker> => {
      const worker = new SpiceCacheWorker(this.options.createWorker());
      try {
        await worker.waitUntilReady();
        await worker.loadKernels(await this.options.kernels(scope));
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
      this.furnishedFor = scope?.key ?? null;
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
    this.furnishedFor = null;
    this.clearIdleRelease();
  }

  private clearIdleRelease(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Start the clock on releasing an idle worker.
   *
   * Armed when a call settles rather than when a search "finishes", because
   * nothing tells us a search has finished: a search is however many calls its
   * kind chooses to make, and the last one looks like all the others. Waiting
   * out the timeout from the most recent call is what turns that into an
   * answerable question -- and it is also what makes a burst of searches cost
   * one worker rather than one each, since every call pushes the release back.
   *
   * What keeps it from firing mid-search is that every call clears it on entry
   * and re-arms only once it settles, so a live timer means no call is in
   * flight. Anything that arms it from somewhere else has to preserve that:
   * releasing under a running call would terminate CSPICE and lose the answer.
   */
  private scheduleIdleRelease(): void {
    const timeout = this.options.idleTimeoutMs ?? 0;
    this.clearIdleRelease();
    if (timeout <= 0 || this.disposed || !this.worker) return;

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.restart();
    }, timeout);
    // Node keeps the process alive for a pending timer; a release is never
    // worth delaying an exit for. Browsers have no such notion.
    this.idleTimer?.unref?.();
  }

  /**
   * Begin a search. Supersedes whatever was running: one search at a time is not
   * a convenience here but a requirement, because terminating the worker to
   * cancel one search would take every other search on it down as well.
   */
  search(options?: GeometrySearchOptions & { scope?: GeometrySearchScope }): GeometrySearch {
    this.active?.cancel();

    // A worker furnished for a different kernel set would answer this search
    // from the wrong pool -- with "insufficient ephemeris data" if it is missing
    // a file, and with a needlessly large heap if it is holding files this
    // search cannot reach. Either way it has to be rebuilt, and doing it here
    // rather than inside `start` keeps the in-flight-start sharing below honest.
    this.clearIdleRelease();
    const scope = options?.scope;
    if ((this.worker || this.starting) && (scope?.key ?? null) !== this.furnishedFor) {
      this.restart();
    }

    let cancelled = false;
    let progress: GeometrySearchProgress | null = null;
    let inner: WorkerGeometrySearch | null = null;
    /**
     * The worker generation `inner` belongs to.
     *
     * A handle outlives the worker it started on -- an idle release or a
     * cancellation that had to terminate replaces it underneath. The inner
     * search is bound to the worker that created it, so reusing one across a
     * restart would route the call into a disposed worker and hang. Rebinding
     * on the next call is what lets the handle carry on regardless.
     */
    let innerGeneration = -1;
    /** Whether `inner` is the one this handle's live worker knows about. */
    const innerIsCurrent = (): boolean => inner !== null && innerGeneration === this.generation;

    // The worker is built on the first call the search actually makes, so a
    // search that is superseded before it asks anything costs nothing.
    const delegate = async (): Promise<WorkerGeometrySearch> => {
      if (cancelled) throw new GeometrySearchCancelled();
      const worker = await this.start(scope);
      if (cancelled) throw new GeometrySearchCancelled();
      if (!innerIsCurrent()) {
        inner = worker.geometrySearch({
          onProgress: (p) => {
            progress = p;
            options?.onProgress?.(p);
          },
        });
        innerGeneration = this.generation;
      }
      return inner!;
    };

    /** Provider calls this handle has in flight. The worker is its while > 0. */
    let outstanding = 0;
    let finished = false;

    /**
     * Claim the worker for one provider call, and release the claim after.
     *
     * The count, rather than a flag, is what makes the release safe: `finish`
     * can be called while a call is still outstanding -- from a `finally` that
     * runs before the last call settles, or simply by a caller that got it
     * wrong -- and arming the timer there would let it fire into a running
     * CSPICE call and terminate the worker mid-search. Nothing arms while this
     * is above zero.
     *
     * Re-arming on settle is a backstop, not the signal; `finish` is. What it
     * does is bound the cost when a caller never says it is done.
     */
    const held = async <T>(run: () => Promise<T>): Promise<T> => {
      outstanding += 1;
      this.clearIdleRelease();
      try {
        return await run();
      } finally {
        outstanding -= 1;
        if (outstanding === 0) this.scheduleIdleRelease();
      }
    };

    const intervals = async (
      call: (p: GeometryFinderProvider) => EtInterval[] | Promise<EtInterval[]>,
    ): Promise<EtInterval[]> => held(async () => call((await delegate()).provider));

    const handle: GeometrySearch = {
      get cancelled() { return cancelled; },
      get progress() { return progress; },
      // A handle whose worker has been replaced holds nothing, whatever the
      // search bound to the old one still says about itself.
      get busy() { return innerIsCurrent() ? inner!.busy : false; },
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        // Whether the worker is holding a call for *this* search, which is what
        // decides if taking it down is worth anything. A search that already
        // finished, or never started, costs nothing to cancel.
        // Whether the worker is executing a call for *this* search, which is
        // what decides whether taking it down buys anything. A search that
        // already finished, or never started, costs nothing to cancel.
        const holdingTheWorker = innerIsCurrent() && inner!.busy;
        if (innerIsCurrent()) inner!.cancel();
        if (holdingTheWorker) this.restart();
        if (this.active === handle) this.active = null;
        // A cancelled search leaves the worker idle as surely as a finished
        // one, and a user who gives up on a search is if anything less likely
        // to start another. Not while a call is still outstanding, though: the
        // rejections above free the caller, not the worker.
        if (outstanding === 0) this.scheduleIdleRelease();
      },

      finish: () => {
        // Said by the caller when its whole search is done, which is the only
        // place that knows: a search is however many calls its kind chooses to
        // make, and from here the last one is indistinguishable from the rest.
        // Idempotent, so a `finally` that runs twice cannot keep pushing the
        // release back.
        if (finished) return;
        finished = true;
        if (this.active === handle) this.active = null;
        if (outstanding === 0) this.scheduleIdleRelease();
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

        range: (target: string, abcorr: string, observer: string, et: EtSeconds) =>
          held(async () => (await delegate()).provider.range!(target, abcorr, observer, et)),
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
