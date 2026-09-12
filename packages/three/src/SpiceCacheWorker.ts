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

/** A cancellable, worker-backed geometry-finder provider for one search. */
export interface WorkerGeometrySearch {
  /** The provider to hand to `EventSearch`. */
  provider: GeometryFinderProvider;
  /**
   * Abandons the search: every call still pending or yet to be made rejects
   * with {@link GeometrySearchCancelled}.
   *
   * A CSPICE call already running in the worker is not interrupted — the worker
   * is single-threaded and CSPICE is synchronous, so there is no point at which
   * it could be. What stops is everything after it, which for a search of any
   * size is most of the work. The main thread is free either way; that is what
   * running the search over there bought.
   */
  cancel(): void;
  /** True once {@link cancel} has been called. */
  readonly cancelled: boolean;
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
   */
  async loadKernels(sources: KernelSource[]): Promise<void> {
    // Store the loading promise so buildCache() can await it
    this.kernelsLoadedPromise = this._loadKernelsSequential(sources);
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
  geometrySearch(): WorkerGeometrySearch {
    const search = `search_${this.nextId++}`;
    let cancelled = false;
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
      try {
        return await new Promise<unknown>((resolve, reject) => {
          this.pendingRequests.set(id, { resolve, reject });
          this.worker.postMessage({ type: 'geometry', id, search, fn, args });
        });
      } finally {
        ids.delete(id);
      }
    };

    const intervals = async (fn: string, args: unknown[]): Promise<EtInterval[]> =>
      (await call(fn, args)) as EtInterval[];

    return {
      get cancelled() { return cancelled; },

      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        // The worker is told as well as the caller: a call can already be in
        // the worker's queue, and the point of cancelling is that it does not
        // run.
        if (!this.disposed) this.worker.postMessage({ type: 'cancelGeometry', search });
        for (const id of ids) {
          this.pendingRequests.get(id)?.reject(new GeometrySearchCancelled());
          this.pendingRequests.delete(id);
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
  }
}
