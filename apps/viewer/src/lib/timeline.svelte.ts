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
import { vs, scrubTo, zoomScrubber } from './viewer-state.svelte';
import { clampFraction, snapFraction } from './scrubber-math';

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

export interface TimelineGestureOptions {
  /** Event edges a hover may snap to, as fractions of the zoomed window. */
  snapTargets: readonly { fraction: number; id: string }[];
}

/**
 * The shared-axis gestures, as a Svelte action for any row drawn across the
 * zoomed window: hover sets the ghost playhead (snapping subtly to an event
 * edge), press or drag seeks without resetting zoom, and the wheel zooms the
 * shared window about the pointer. Event lanes and profile rows both use it,
 * so every row of the timeline answers the same gesture the same way.
 *
 * A child that handles its own press (an event mark) stops propagation of
 * `pointerdown`, and this never sees it.
 */
export function timelineGestures(node: HTMLElement, initial: TimelineGestureOptions) {
  let opts = initial;
  let dragging = false;

  const fractionAt = (e: PointerEvent | WheelEvent) => {
    const rect = node.getBoundingClientRect();
    return clampFraction((e.clientX - rect.left) / rect.width);
  };

  const previewAt = (e: PointerEvent) => {
    const f = fractionAt(e);
    const snap = snapFraction(f, opts.snapTargets, node.clientWidth);
    const at = snap?.fraction ?? f;
    setTimelineHover(timelineEt(at), snap?.id ?? null);
    return at;
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    node.setPointerCapture(e.pointerId);
    dragging = true;
    const at = previewAt(e);
    setTimelineHover(null);
    scrubTo(at);
  };
  const move = (e: PointerEvent) => {
    if (dragging) scrubTo(fractionAt(e));
    else previewAt(e);
  };
  const up = (e: PointerEvent) => {
    if (!dragging) return;
    node.releasePointerCapture(e.pointerId);
    dragging = false;
    previewAt(e);
  };
  const leave = () => {
    if (!dragging) setTimelineHover(null);
  };
  // Non-passive, so the page does not scroll while the timeline zooms.
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.deltaY === 0) return;
    zoomScrubber(e.deltaY < 0, timelineEt(fractionAt(e)));
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('wheel', wheel, { passive: false });
  return {
    update(next: TimelineGestureOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('wheel', wheel);
      if (timeline.hoverEt != null && node.matches(':hover')) setTimelineHover(null);
    },
  };
}
