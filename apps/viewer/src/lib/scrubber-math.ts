/** Keyboard step size as fraction of total range */
export const KEYBOARD_STEP = 0.001;

/** Clamp a fraction to [0, 1] */
export function clampFraction(f: number): number {
  return Math.max(0, Math.min(1, f));
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
