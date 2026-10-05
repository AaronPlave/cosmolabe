/** Keyboard step size as fraction of total range */
export const KEYBOARD_STEP = 0.001;

/** Clamp a fraction to [0, 1] */
export function clampFraction(f: number): number {
  return Math.max(0, Math.min(1, f));
}

/**
 * Where `et` sits in the window `[min, max]`, as a fraction that is *not*
 * clamped: below 0 or above 1 means out of view. Every row on the timeline
 * uses this, so none of them draws the playhead at an edge it is not at.
 */
export function windowFraction(et: number, min: number, max: number): number {
  const span = max - min;
  return span > 0 ? (et - min) / span : 0.5;
}

/** Whether a fraction from `windowFraction` is on screen. */
export function inWindow(fraction: number | null | undefined): fraction is number {
  return fraction != null && fraction >= 0 && fraction <= 1;
}

/**
 * The timeline window to show after the playhead jumps to `et` (an event
 * selected, a typed time, a script's `setTime`), keeping the user's zoom.
 *
 * Already in view: the window stays put. Off-screen but inside the base
 * range: the window slides, span unchanged, to centre `et` as nearly as the
 * base allows. Outside the base range, or with no usable base: null, and the
 * caller rebuilds the range around the new time.
 */
export function windowFollowing(
  et: number,
  window: { min: number; max: number },
  base: { min: number; max: number },
): { min: number; max: number } | null {
  if (!Number.isFinite(et) || !(base.max > base.min) || et < base.min || et > base.max) return null;
  const span = window.max - window.min;
  if (!(span > 0) || span > base.max - base.min) return null;
  if (et >= window.min && et <= window.max) return { min: window.min, max: window.max };
  const min = Math.max(base.min, Math.min(et - span / 2, base.max - span));
  return { min, max: min + span };
}

/** Human-readable label for a duration in seconds (e.g. "~2.5h", "~30s") */
export function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 120) return `~${Math.round(abs)}s`;
  if (abs < 7200) return `~${Math.round(abs / 60)}m`;
  if (abs < 172800) return `~${(abs / 3600).toFixed(1)}h`;
  if (abs < 5184000) return `~${Math.round(abs / 86400)}d`;
  if (abs < 63113904) return `~${(abs / 2592000).toFixed(1)}mo`;
  return `~${(abs / 31556952).toFixed(1)}yr`;
}

/**
 * Subtle event snapping for a hover on the timeline: the nearest candidate
 * fraction within `tolerancePx` of `fraction`, or null. Deliberately small —
 * it should catch a pointer that is aiming at an event, not drag one that is
 * merely passing.
 */
export function snapFraction(
  fraction: number,
  candidates: readonly { fraction: number; id: string }[],
  widthPx: number,
  tolerancePx = 5,
): { fraction: number; id: string } | null {
  if (!(widthPx > 0)) return null;
  let best: { fraction: number; id: string } | null = null;
  let bestPx = tolerancePx;
  for (const c of candidates) {
    const px = Math.abs(c.fraction - fraction) * widthPx;
    if (px <= bestPx) {
      bestPx = px;
      best = c;
    }
  }
  return best;
}
