/**
 * Timeline interaction state shared by every row that draws on the time axis.
 *
 * The axis itself is not here: the zoomed window is `vs.scrubMin`/`scrubMax`
 * and the committed time is `vs.et`, exactly as before, so the transport
 * track, event markers and profile rows cannot disagree about either. What
 * this adds is the *preview* half of "hover = preview, click = commit" — a
 * ghost playhead any row can set and every row draws, and the event it is
 * snapped to, if any.
 */
import { vs } from './viewer-state.svelte';

export const timeline = $state({
  /** Hovered instant, or null. Never moves simulation time. */
  hoverEt: null as number | null,
  /** Event the hover is snapped to, for cross-highlighting. */
  previewEventId: null as string | null,
});

/** An event as a profile row draws it: fractions of the zoomed window. */
export interface ProfileEventTick {
  id: string;
  fraction: number;
  endFraction: number;
  selected: boolean;
  active: boolean;
}

export function setTimelineHover(et: number | null, eventId: string | null = null) {
  timeline.hoverEt = et;
  timeline.previewEventId = et == null ? null : eventId;
}

/** Fraction of the zoomed window at `et` — may fall outside [0, 1]. */
export function timelineFraction(et: number): number {
  const span = vs.scrubMax - vs.scrubMin;
  return span > 0 ? (et - vs.scrubMin) / span : 0.5;
}

export function timelineEt(fraction: number): number {
  return vs.scrubMin + fraction * (vs.scrubMax - vs.scrubMin);
}

/** Scene-owned; a new catalog must not inherit a stale ghost. */
export function resetTimeline() {
  setTimelineHover(null);
}
