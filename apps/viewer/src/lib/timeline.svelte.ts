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
import { clampFraction, snapFraction, windowFraction } from './scrubber-math';

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
  return windowFraction(et, vs.scrubMin, vs.scrubMax);
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

/** Travel, in px, before a touch press is read as a scrub or a scroll. */
const TOUCH_SLOP = 6;

/**
 * The shared-axis gestures, as a Svelte action for any row drawn across the
 * zoomed window: hover sets the ghost playhead (snapping subtly to an event
 * edge), press or drag seeks without resetting zoom, and the wheel zooms the
 * shared window about the pointer. Event lanes and profile rows both use it,
 * so every row of the timeline answers the same gesture the same way.
 *
 * Mouse and pen commit on press. Touch cannot: these rows sit in a region
 * that scrolls vertically, so a touch press waits to see which way it moves.
 * Mostly horizontal travel scrubs; vertical travel is left to the browser as
 * a scroll (rows declare `touch-action: pan-y`, and the browser cancels the
 * pointer when it takes over); a press that barely moves is a tap and seeks.
 *
 * A child that handles its own press (an event mark) stops propagation of
 * `pointerdown`, and this never sees it.
 */
export function timelineGestures(node: HTMLElement, initial: TimelineGestureOptions) {
  let opts = initial;
  let dragging = false;
  /** A touch press not yet read as a scrub, a scroll, or a tap. */
  let pending: { id: number; x: number; y: number } | null = null;

  const fractionAt = (e: PointerEvent | WheelEvent) => {
    const rect = node.getBoundingClientRect();
    return clampFraction((e.clientX - rect.left) / rect.width);
  };

  const snappedAt = (e: PointerEvent) => {
    const f = fractionAt(e);
    const snap = snapFraction(f, opts.snapTargets, node.clientWidth);
    return { at: snap?.fraction ?? f, id: snap?.id ?? null };
  };

  const previewAt = (e: PointerEvent) => {
    const { at, id } = snappedAt(e);
    setTimelineHover(timelineEt(at), id);
  };

  const startScrub = (e: PointerEvent, at: number) => {
    node.setPointerCapture(e.pointerId);
    dragging = true;
    setTimelineHover(null);
    scrubTo(at);
  };

  const reset = () => {
    dragging = false;
    pending = null;
    setTimelineHover(null);
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (e.pointerType === 'touch') {
      pending = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    startScrub(e, snappedAt(e).at);
  };
  const move = (e: PointerEvent) => {
    if (dragging) {
      scrubTo(fractionAt(e));
      return;
    }
    if (pending && pending.id === e.pointerId) {
      const dx = Math.abs(e.clientX - pending.x);
      const dy = Math.abs(e.clientY - pending.y);
      if (Math.max(dx, dy) < TOUCH_SLOP) return;
      pending = null;
      // Vertical travel is the region's scroll; the browser will cancel us.
      if (dx > dy) startScrub(e, fractionAt(e));
      return;
    }
    if (e.pointerType !== 'touch') previewAt(e);
  };
  const up = (e: PointerEvent) => {
    if (pending && pending.id === e.pointerId) {
      // A tap: seek to it, snapped like a click.
      pending = null;
      scrubTo(snappedAt(e).at);
      return;
    }
    if (!dragging) return;
    dragging = false;
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    if (e.pointerType === 'touch') setTimelineHover(null);
    else previewAt(e);
  };
  const leave = (e: PointerEvent) => {
    if (!dragging && e.pointerType !== 'touch') setTimelineHover(null);
  };
  // Non-passive, so the page does not scroll while the timeline zooms.
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.deltaY === 0) return;
    zoomScrubber(e.deltaY < 0, timelineEt(fractionAt(e)));
  };

  const listeners: [string, EventListener, AddEventListenerOptions?][] = [
    ['pointerdown', down as EventListener],
    ['pointermove', move as EventListener],
    ['pointerup', up as EventListener],
    ['pointercancel', reset],
    // Only the row's own capture. A touch is implicitly captured by the child
    // it lands on, and taking capture for the row makes that child's loss
    // bubble up here — which is not the drag ending.
    ['lostpointercapture', (e) => { if (dragging && e.target === node) reset(); }],
    ['pointerleave', leave as EventListener],
    ['wheel', wheel as EventListener, { passive: false }],
  ];
  for (const [type, fn, o] of listeners) node.addEventListener(type, fn, o);
  return {
    update(next: TimelineGestureOptions) {
      opts = next;
    },
    destroy() {
      for (const [type, fn] of listeners) node.removeEventListener(type, fn);
      if (dragging || (timeline.hoverEt != null && node.matches(':hover'))) setTimelineHover(null);
    },
  };
}
