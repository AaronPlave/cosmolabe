/**
 * Tracks the asynchronous asset loads a freshly built scene starts, so a
 * caller can wait for the *initial* set — the models and textures the catalog
 * names up front — before telling the user the scene is ready.
 *
 * Why this exists: model meshes, globe/base maps, normal + displacement maps,
 * level-0 tiles, ring textures and `.cmod` material textures are all
 * fire-and-forget from `buildScene()`. The viewer used to announce a loaded
 * scene the instant the scene graph existed, which meant placeholder spheres
 * and untextured bodies on screen after the loading UI had gone (issue #19),
 * and a visual-regression harness that papered over it with a fixed settle
 * delay.
 *
 * Two registration kinds, because "how many assets are there" and "is anything
 * still in flight" are different questions:
 *
 * - `track()` — a countable asset. Its outcome (loaded / failed) lands in the
 *   summary, and its failure reason with it.
 * - `hold()` — an uncounted job that merely keeps the tracker busy. The
 *   per-body load calls are held: they discover their own countable assets
 *   part-way through (a `.cmod`'s material textures are only known once the
 *   mesh has parsed), so the drain below must not conclude while one is open.
 *
 * Failures never leave readiness pending: a rejected load is recorded and the
 * set drains around it, and `settle()` takes a deadline so a request that never
 * resolves at all (a server that accepts the socket and then goes quiet) still
 * yields a summary rather than a scene that is loading forever.
 */

/** What kind of asset a tracked load is fetching. */
export type AssetKind = 'model' | 'texture' | 'tiles';

/** Identifies one tracked asset for progress display and failure reporting. */
export interface AssetRequest {
  kind: AssetKind;
  /** Body (or ring) the asset belongs to. */
  owner: string;
  /** What the asset is for — `baseMap`, `normalMap`, `cmod:diffuse`, … */
  role: string;
  /** URL or blob URL being fetched. */
  url: string;
}

export interface AssetFailure extends AssetRequest {
  /** Message from the rejection, or the reason a load was never attempted. */
  reason: string;
}

export interface AssetProgress {
  /** Countable assets registered so far. Grows while loading — a `.cmod`'s
   *  textures join the count only once its mesh has parsed. */
  total: number;
  /** Assets that have finished, successfully or not. */
  settled: number;
  loaded: number;
  failed: number;
}

export interface InitialAssetsSummary extends AssetProgress {
  failures: AssetFailure[];
  /** Assets still in flight when the deadline expired. Empty unless `timedOut`. */
  stillPending: AssetRequest[];
  /** True when the deadline expired before the set drained. */
  timedOut: boolean;
  /** Wall-clock ms from the first registration to the summary. */
  durationMs: number;
}

/** Default deadline for the initial asset set. Generous: some planetary base
 *  maps are tens of MB over a cold connection. Past it, the scene is shown
 *  with whatever arrived rather than waiting on a load that may never land. */
export const DEFAULT_INITIAL_ASSET_TIMEOUT_MS = 60_000;

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export class AssetLoadTracker {
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly pendingRequests = new Map<Promise<unknown>, AssetRequest>();
  private readonly failures: AssetFailure[] = [];
  private readonly progressHandlers = new Set<(p: AssetProgress) => void>();
  private total = 0;
  private loaded = 0;
  private failed = 0;
  private startedAt: number | null = null;
  private settling: Promise<InitialAssetsSummary> | null = null;
  private settledSummary: InitialAssetsSummary | null = null;

  /** Snapshot of the counts, safe to hand to UI. */
  get progress(): AssetProgress {
    return {
      total: this.total,
      settled: this.loaded + this.failed,
      loaded: this.loaded,
      failed: this.failed,
    };
  }

  /** Countable assets still loading (includes held jobs). */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** True once `settle()` has produced a summary — later loads are streaming,
   *  not part of the initial gate. */
  get isSettled(): boolean {
    return this.settledSummary !== null;
  }

  /** Subscribe to count changes. Returns an unsubscribe function. */
  onProgress(handler: (p: AssetProgress) => void): () => void {
    this.progressHandlers.add(handler);
    return () => this.progressHandlers.delete(handler);
  }

  /**
   * Register a countable asset load. The promise's rejection is handled here,
   * so callers may keep their own `catch` (or none at all) without producing an
   * unhandled rejection.
   */
  track(request: AssetRequest, load: Promise<unknown>): void {
    this.begin(load, request);
    load.then(
      () => {
        this.loaded++;
        this.end(load);
      },
      (err: unknown) => {
        this.failed++;
        this.failures.push({ ...request, reason: messageOf(err) });
        this.end(load);
      },
    );
  }

  /**
   * Register an uncounted job that must finish before the set can be called
   * drained — the per-body load calls, which register their own countable
   * assets as they go.
   */
  hold(job: Promise<unknown>): void {
    this.begin(job, null);
    job.then(
      () => this.end(job),
      () => this.end(job),
    );
  }

  /**
   * Record an asset that failed without ever being fetched — an unresolvable
   * `source` path, an unsupported format. Counted like any other failure so the
   * summary reflects what the scene is missing.
   */
  fail(request: AssetRequest, reason: string): void {
    this.startedAt ??= now();
    this.total++;
    this.failed++;
    this.failures.push({ ...request, reason });
    this.notify();
  }

  /**
   * Resolve once every registered load has settled, or the deadline expires.
   * Idempotent: every caller gets the one summary — the first call's deadline is
   * the one that applies — so the initial gate is decided exactly once, and an
   * asset that streams in afterwards cannot rewrite what the viewer already
   * acted on.
   */
  settle(options: { timeoutMs?: number } = {}): Promise<InitialAssetsSummary> {
    if (this.settledSummary) return Promise.resolve(this.settledSummary);
    this.settling ??= this.drain(options);
    return this.settling;
  }

  private async drain(options: { timeoutMs?: number }): Promise<InitialAssetsSummary> {
    const started = this.startedAt ?? now();
    const deadline = started + (options.timeoutMs ?? DEFAULT_INITIAL_ASSET_TIMEOUT_MS);
    let timedOut = false;

    while (this.inFlight.size > 0) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const drained = await raceWithTimeout(
        Promise.allSettled([...this.inFlight]),
        remaining,
      );
      if (!drained) {
        timedOut = true;
        break;
      }
      // A load that just finished may register its follow-on assets a microtask
      // or two later (the `.cmod` case above). Yield a full task before looking
      // again, so the set isn't declared drained one turn too early.
      await yieldTask();
    }

    this.settledSummary = {
      ...this.progress,
      failures: [...this.failures],
      stillPending: timedOut ? [...this.pendingRequests.values()] : [],
      timedOut,
      durationMs: now() - started,
    };
    return this.settledSummary;
  }

  private begin(job: Promise<unknown>, request: AssetRequest | null): void {
    this.startedAt ??= now();
    this.inFlight.add(job);
    if (request) {
      this.total++;
      this.pendingRequests.set(job, request);
      this.notify();
    }
  }

  private end(job: Promise<unknown>): void {
    this.inFlight.delete(job);
    if (this.pendingRequests.delete(job)) this.notify();
  }

  private notify(): void {
    const p = this.progress;
    for (const h of this.progressHandlers) {
      try {
        h(p);
      } catch (e) {
        console.error('[Cosmolabe] Asset progress handler error:', e);
      }
    }
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/** Resolve true if `p` settles within `ms`, false if the deadline wins. The
 *  timer is always cleared, so a won race leaves nothing pending behind. */
function raceWithTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

function yieldTask(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
