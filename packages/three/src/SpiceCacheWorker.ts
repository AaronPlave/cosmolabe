/**
 * Main-thread client for the SPICE trajectory cache Web Worker.
 *
 * Wraps the raw Worker postMessage protocol with a Promise-based API.
 * Handles initialization, kernel loading, and async cache builds.
 */

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
   * @param workerUrl URL to the worker script. Typically:
   *   `new URL('./workers/spice-cache.worker.ts', import.meta.url)`
   *   Vite resolves this at build time and bundles the worker separately.
   */
  constructor(workerUrl: URL) {
    this.worker = new Worker(workerUrl, { type: 'module' });
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
   */
  async loadKernels(urls: string[]): Promise<void> {
    // Store the loading promise so buildCache() can await it
    this.kernelsLoadedPromise = this._loadKernelsSequential(urls);
    return this.kernelsLoadedPromise;
  }

  private async _loadKernelsSequential(urls: string[]): Promise<void> {
    await this.readyPromise;
    for (const url of urls) {
      if (this.disposed) return;
      const id = `kernel_${this.nextId++}`;
      await new Promise<void>((resolve, reject) => {
        this.pendingRequests.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        this.worker.postMessage({ type: 'loadKernel', id, url });
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
