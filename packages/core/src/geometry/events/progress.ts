/**
 * Whole-search progress, assembled from the progress of each geometry call.
 *
 * A search is one or more GF calls, and whatever reports progress for them —
 * CSPICE's reporter, relayed from a worker — reports each call on its own, from
 * 0 to 1. Shown directly, that fills the bar once per call. This maps call *n*
 * of *N* into its own slice, `[(n-1)/N, n/N]`, so the fraction a caller sees
 * describes the search rather than the step.
 *
 * `N` is the kind's `EventKind.plannedCalls`, known before the search
 * starts, and the slices are equal. That is an assumption about cost, not a
 * measurement of it: a search whose second call is much slower than its first
 * still advances unevenly — just never backwards.
 *
 * The two ends are split between two owners. `EventSearch` says how many
 * calls to expect, when each one begins and when the search is over; whoever
 * holds the provider's own progress feeds it in through {@link report}.
 *
 * Guarantees, whatever order those arrive in: the fraction never decreases,
 * never exceeds 1, and 1 is reported at most once. A kind that makes more calls
 * than it declared holds at the top of its last slice rather than restarting;
 * one that makes fewer jumps to 1 when the search completes.
 */
export class EventSearchProgress {
  private planned = 1;
  /** 0-based index of the call running now; -1 before the first. */
  private call = -1;
  private last = -Infinity;
  private sealed = false;

  constructor(private readonly onProgress: (fraction: number) => void) {}

  /** The fraction last reported, or null before anything has been. */
  get fraction(): number | null {
    return Number.isFinite(this.last) ? this.last : null;
  }

  /**
   * Sets how many geometry calls the search will make. Called by the search
   * service before the first call; anything that is not a positive number
   * counts as one.
   */
  plan(calls: number): void {
    this.planned = Number.isFinite(calls) && calls >= 1 ? Math.floor(calls) : 1;
  }

  /** A geometry call is starting; reports after this belong to it. */
  beginCall(): void {
    this.call += 1;
  }

  /** The running call's own fraction, 0 to 1. */
  report(fraction: number): void {
    if (this.sealed || !Number.isFinite(fraction)) return;
    const slice = Math.min(Math.max(this.call, 0), this.planned - 1);
    const within = Math.min(Math.max(fraction, 0), 1);
    this.emit((slice + within) / this.planned);
  }

  /**
   * The search found its answer: report 1 if that has not happened already, and
   * ignore anything reported after. What runs next — an explanation for an
   * empty result — is not part of the search the bar describes.
   */
  complete(): void {
    if (this.sealed) return;
    this.emit(1);
    this.sealed = true;
  }

  /** The search stopped without finishing: ignore anything reported after. */
  seal(): void {
    this.sealed = true;
  }

  private emit(fraction: number): void {
    const next = Math.min(fraction, 1);
    if (next <= this.last) return;
    this.last = next;
    this.onProgress(next);
  }
}
