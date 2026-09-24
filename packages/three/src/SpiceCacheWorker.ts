/**
 * Main-thread client for the SPICE trajectory cache Web Worker.
 *
 * Wraps the raw Worker postMessage protocol with a Promise-based API.
 * Handles initialization, kernel loading, async cache builds, and geometry
 * searches — the last of these because the worker's SPICE instance already has
 * the catalog's kernels furnished, so a geometry-event search can run there
 * without loading anything of its own and without blocking the main thread.
 */

import type { EtInterval, EtSeconds, GeometryFinderProvider } from '@cosmolabe/core';
import { TrajectoryCache, type TrajectoryCacheConfig } from './TrajectoryCache.js';

/** Parameters for an async cache build request. */
export interface CacheBuildRequest {
  /** Body name (for logging) */
  bodyName: string;
  /** SPICE target name or NAIF ID string */
  target: string;
  /** SPICE center body name */
  center: string;
  /** SPICE reference frame */
  frame: string;
  /** NAIF ID for spkcov coverage query */
  naifId?: number;
  /** Search range start (ET seconds) */
  searchStart: number;
  /** Search range end (ET seconds) */
  searchEnd: number;
  /** Cache build config */
  config?: TrajectoryCacheConfig;
}

/**
 * A kernel to furnish in the worker: a URL to fetch, or the bytes of one the
 * host already has (a file the user dropped, which has no URL).
 */
export type KernelSource = string | { name: string; data: ArrayBuffer };

/**
 * Thrown into a caller whose search was cancelled or superseded.
 *
 * Distinguishable by name rather than by message, because the caller has to
 * tell "you stopped this" from "this failed": only the second is worth showing
 * as a fault.
 */
export class GeometrySearchCancelled extends Error {
  constructor(message = 'Geometry search cancelled') {
    super(message);
    this.name = 'GeometrySearchCancelled';
  }
}

/**
 * How far the geometry call currently running has got.
 *
 * `fraction` is of the confinement window that call was given, not of elapsed
 * time and not of the search as a whole: CSPICE reports the window it has swept,
 * which advances unevenly and is honest for a bar but misleading as an ETA.
 *
 * Within one call the fraction is monotonic: a relational search sweeps its
 * window once to find where the quantity is decreasing before it solves the
 * relation, and CSPICE restarts its reporter at each of those passes, but the
 * count is known up front and each pass is mapped into its own slice. `pass` is
 * the 1-based number of the one running, passed through unscaled.
 *
 * This is still one call's fraction: a search may be several calls (an
 * occultation search runs one per requested state), and it restarts at each.
 * `EventSearchProgress` in `@cosmolabe/core` is what turns these into the
 * search's own fraction, from the number of calls the kind plans.
 */
export interface GeometrySearchProgress {
  readonly fraction: number;
  readonly pass: number;
}

/** Options for one worker-backed search. */
export interface GeometrySearchOptions {
  /** Called whenever the running call reports progress. */
  onProgress?: (progress: GeometrySearchProgress) => void;
}

/** A cancellable, worker-backed geometry-finder provider for one search. */
export interface WorkerGeometrySearch {
  /** The provider to hand to `EventSearch`. */
  provider: GeometryFinderProvider;
  /**
   * Stops the search: every call still pending or yet to be made rejects with
   * {@link GeometrySearchCancelled}.
   *
   * Not the call the worker is already executing. A worker blocked inside
   * synchronous CSPICE will not read its own message queue until that call
   * returns, so nothing sent from here can reach it, and this leaves the worker
   * busy until it finishes on its own.
   *
   * That is why the viewer does not cancel here. {@link GeometrySearchWorker}
   * wraps this and terminates the worker, which is the one thing that always
   * stops synchronous wasm — survivable there because that worker exists only
   * to search, and not here, where the trajectory caches would go with it.
   */
  cancel(): void;
  /** True once {@link cancel} has been called. */
  readonly cancelled: boolean;
  /**
   * The running call's progress, or null before it has reported any.
   * See {@link GeometrySearchProgress} for what the fraction is a fraction of.
   */
  readonly progress: GeometrySearchProgress | null;
  /**
   * True while a call this search made is outstanding in the worker.
   *
   * What distinguishes "this search is holding the worker" from "this search is
   * done and only the handle is left". A caller that cancels by terminating the
   * worker needs the difference: superseding a search that already finished
   * should cost nothing.
   */
  readonly busy: boolean;
}

export class SpiceCacheWorker {
  private worker: Worker;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private readyPromise: Promise<void>;
  private disposed = false;

  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  /** Progress sinks for in-flight geometry calls, keyed by request id. */
  private geometryProgress = new Map<string, (progress: GeometrySearchProgress) => void>();
  private nextId = 0;
  // Resolves when loadKernels() completes. buildCache() awaits this to avoid
  // racing with kernel loading (both await readyPromise, but buildCache must
  // also wait for all kernels to be loaded in the worker).
  private kernelsLoadedPromise: Promise<void> = Promise.resolve();

  /**
   * Accepts either a URL pointing at the worker script or an already-
   * instantiated Worker. The instance form is required for Vite's `?worker`
   * import to bundle the worker as a separate chunk in production.
   */
  constructor(workerOrUrl: URL | Worker) {
    this.worker = workerOrUrl instanceof Worker
      ? workerOrUrl
      : new Worker(workerOrUrl, { type: 'module' });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      const err = new Error(`Worker error: ${event.message}`);
      console.error('[SpiceCacheWorker]', err);
      // Reject ready promise if still pending
      this.readyReject(err);
      // Reject all pending requests
      for (const [, { reject }] of this.pendingRequests) reject(err);
      this.pendingRequests.clear();
    };

    // Kick off initialization
    this.worker.postMessage({ type: 'init' });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ready':
        this.readyResolve();
        break;

      case 'kernelLoaded': {
        const pending = this.pendingRequests.get(msg.id as string);
        if (pending) {
          pending.resolve(undefined);
          this.pendingRequests.delete(msg.id as string);
        }
        break;
      }

      case 'cacheBuilt': {
        const pending = this.pendingRequests.get(msg.id as string);
        if (pending) {
          const cache = TrajectoryCache.fromArrays(
            msg.times as Float64Array,
            msg.positions as Float64Array,
            msg.count as number,
          );
          pending.resolve(cache);
          this.pendingRequests.delete(msg.id as string);
        }
        break;
      }

      case 'geometryProgress': {
        // Interim: the call is still running, so the pending entry stays put.
        this.geometryProgress.get(msg.id as string)?.({
          fraction: msg.fraction as number,
          pass: msg.pass as number,
        });
        break;
      }

      case 'geometryResult': {
        const pending = this.pendingRequests.get(msg.id as string);
        if (pending) {
          pending.resolve(msg.value);
          this.pendingRequests.delete(msg.id as string);
        }
        break;
      }

      case 'geometryCancelled': {
        const pending = this.pendingRequests.get(msg.id as string);
        if (pending) {
          pending.reject(new GeometrySearchCancelled());
          this.pendingRequests.delete(msg.id as string);
        }
        break;
      }

      case 'error': {
        const id = (msg.id as string) ?? '';
        if (id === 'init') {
          this.readyReject(new Error(msg.message as string));
        }
        const pending = this.pendingRequests.get(id);
        if (pending) {
          pending.reject(new Error(msg.message as string));
          this.pendingRequests.delete(id);
        }
        break;
      }
    }
  }

  /** Wait for the worker's SPICE instance to initialize. */
  async waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Load kernels into the worker's SPICE instance.
   * Kernels are fetched from the given URLs (browser HTTP cache makes this fast).
   * Loaded sequentially to preserve kernel load order.
   *
   * A source may instead carry the bytes directly, for a kernel that has no URL
   * to fetch — one the user dropped into the viewer. Order is the caller's:
   * furnish order decides kernel precedence, so the list is loaded as given.
   *
   * Calling this again *appends*, after everything an earlier call is still
   * loading. That is what a kernel dropped onto a scene already up needs: the
   * host furnishes it into its own SPICE and hands it here, and the two sets
   * stay the same kernels in the same order (#68) without rebuilding a worker
   * that is holding the scene's trajectory caches. Chained rather than merely
   * reassigned, because `buildCache` waits on the latest promise, and a bare
   * reassignment would let it run while the earlier load was still going.
   */
  async loadKernels(sources: KernelSource[]): Promise<void> {
    const loaded = this.kernelsLoadedPromise;
    // Store the loading promise so buildCache() can await it
    this.kernelsLoadedPromise = (async () => {
      // Its rejection belongs to whoever asked for that load, not to this one;
      // what matters here is only that its furnishes finished first.
      await loaded.catch(() => {});
      await this._loadKernelsSequential(sources);
    })();
    return this.kernelsLoadedPromise;
  }

  private async _loadKernelsSequential(sources: KernelSource[]): Promise<void> {
    await this.readyPromise;
    for (const source of sources) {
      if (this.disposed) return;
      const id = `kernel_${this.nextId++}`;
      await new Promise<void>((resolve, reject) => {
        this.pendingRequests.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        this.worker.postMessage(
          typeof source === 'string'
            ? { type: 'loadKernel', id, url: source }
            : { type: 'loadKernel', id, name: source.name, data: source.data },
        );
      });
    }
  }

  /** Build a trajectory cache asynchronously in the worker. */
  async buildCache(request: CacheBuildRequest): Promise<TrajectoryCache> {
    // Wait for ALL kernels to load, not just worker init — prevents racing
    // with loadKernels() which shares the same readyPromise await point.
    await this.kernelsLoadedPromise;
    if (this.disposed) throw new Error('Worker disposed');
    const id = `cache_${this.nextId++}`;
    return new Promise<TrajectoryCache>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.worker.postMessage({
        type: 'buildCache',
        id,
        params: {
          target: request.target,
          center: request.center,
          frame: request.frame,
          naifId: request.naifId,
          searchStart: request.searchStart,
          searchEnd: request.searchEnd,
          config: request.config,
        },
      });
    });
  }

  /**
   * A geometry-finder provider that runs its searches in this worker.
   *
   * This is what keeps the viewer interactive during a search: CSPICE's GF
   * routines are synchronous and a fine step over a long window is genuinely
   * expensive, so the only way the event loop stays free is for the call to
   * happen somewhere else. The kernels are already furnished here for the
   * trajectory caches, so a search pays for no loading of its own.
   *
   * One handle per search. The arguments are passed through untouched and run
   * against the same heritage adapter the main thread would have used, so the
   * results are the main-thread path's results, not an approximation of them.
   */
  geometrySearch(options?: GeometrySearchOptions): WorkerGeometrySearch {
    const search = `search_${this.nextId++}`;
    let cancelled = false;
    let progress: GeometrySearchProgress | null = null;
    const ids = new Set<string>();

    const call = async (fn: string, args: unknown[]): Promise<unknown> => {
      if (cancelled) throw new GeometrySearchCancelled();
      // Kernels, not just worker init: a search before the furnish finishes
      // would fail on every body in the catalog.
      await this.kernelsLoadedPromise;
      if (cancelled) throw new GeometrySearchCancelled();
      if (this.disposed) throw new Error('Worker disposed');

      const id = `geom_${this.nextId++}`;
      ids.add(id);
      // `range` is a single position lookup: nothing to report. Without a
      // progress callback there is nothing to ask for either, and the search
      // stays on CSPICE's simplified wrappers, exactly where it was before any
      // of this.
      const reported = fn !== 'range' && !!options?.onProgress;
      if (reported) {
        this.geometryProgress.set(id, (p) => {
          progress = p;
          options?.onProgress?.(p);
        });
      }
      try {
        return await new Promise<unknown>((resolve, reject) => {
          this.pendingRequests.set(id, { resolve, reject });
          this.worker.postMessage({
            type: 'geometry', id, search, fn, args,
            report: reported ? { progress: true } : undefined,
          });
        });
      } finally {
        ids.delete(id);
        this.geometryProgress.delete(id);
      }
    };

    const intervals = async (fn: string, args: unknown[]): Promise<EtInterval[]> =>
      (await call(fn, args)) as EtInterval[];

    return {
      get cancelled() { return cancelled; },
      get progress() { return progress; },
      get busy() { return ids.size > 0; },

      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        // The worker is told as well as the caller: a call can already be in
        // the worker's queue, and the point of cancelling is that it does not
        // run. This message is what stops those — it cannot reach the running
        // call, because the worker will not read its queue until that returns.
        if (!this.disposed) this.worker.postMessage({ type: 'cancelGeometry', search });
        for (const id of ids) {
          this.pendingRequests.get(id)?.reject(new GeometrySearchCancelled());
          this.pendingRequests.delete(id);
          this.geometryProgress.delete(id);
        }
        ids.clear();
      },

      provider: {
        gfdist: (target, abcorr, observer, relate, refval, adjust, step, cnfine) =>
          intervals('gfdist', [target, abcorr, observer, relate, refval, adjust, step, cnfine]),

        gfsep: (t1, s1, f1, t2, s2, f2, abcorr, observer, relate, refval, adjust, step, cnfine) =>
          intervals('gfsep', [t1, s1, f1, t2, s2, f2, abcorr, observer, relate, refval, adjust, step, cnfine]),

        gfoclt: (occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, cnfine) =>
          intervals('gfoclt', [occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, cnfine]),

        gfposc: (target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, cnfine) =>
          intervals('gfposc', [target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, cnfine]),

        range: async (target: string, abcorr: string, observer: string, et: EtSeconds) =>
          (await call('range', [target, abcorr, observer, et])) as number,
      },
    };
  }

  /** Terminate the worker and reject all pending requests. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error('Worker disposed'));
    }
    this.pendingRequests.clear();
    this.geometryProgress.clear();
  }
}
