/**
 * Hover and selection emphasis transitions. One duration for every scene
 * highlight (trails, labels, event strokes, callouts) so they move together:
 * short enough to feel immediate, long enough not to pop.
 */
export const EMPHASIS_FADE_MS = 120;

/**
 * Step `current` linearly toward `target`, covering `span` per
 * {@link EMPHASIS_FADE_MS}. Large gaps (a hidden or throttled frame) snap.
 */
export function stepEmphasis(current: number, target: number, dtMs: number, span = 1): number {
  if (!(dtMs > 0) || dtMs >= EMPHASIS_FADE_MS) return target;
  const step = span * dtMs / EMPHASIS_FADE_MS;
  return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
}

/** Wall-clock frame delta for fades, independent of simulation time. */
export class EmphasisClock {
  private last = -1;

  /** Milliseconds since the previous call (0 on the first). */
  tick(now = performance.now()): number {
    const dt = this.last < 0 ? 0 : now - this.last;
    this.last = now;
    return dt;
  }
}
