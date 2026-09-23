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
import { vs, scrubTo, zoomScrubber, panScrubberBy } from './viewer-state.svelte';
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

/** Travel, in px, before a press is read as a pan (or, for touch, a scroll). */
const MOUSE_SLOP = 3;
const TOUCH_SLOP = 6;

/**
 * Wheel input to timeline action: a mostly-horizontal wheel (a trackpad's
 * sideways swipe) or Shift+wheel pans, by that many pixels of the row; any
 * other wheel zooms. Shared with the transport track so every row agrees.
 */
export function wheelIntent(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'shiftKey'>):
  { pan: number } | { zoomIn: boolean } | null {
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return { pan: e.deltaX };
  if (e.deltaY === 0) return null;
  if (e.shiftKey) return { pan: e.deltaY };
  return { zoomIn: e.deltaY < 0 };
}

/** Pans the shared window by `px` of a row `widthPx` wide (positive = later). */
export function panTimelineByPixels(px: number, widthPx: number) {
  if (!(widthPx > 0)) return;
  panScrubberBy((px / widthPx) * (vs.scrubMax - vs.scrubMin));
}

/**
 * The analysis rows' gestures, as a Svelte action for any row drawn across
 * the zoomed window. Event lanes and profile rows both use it, so every row
 * below the transport answers the same gesture the same way:
 *
 * - hover sets the ghost playhead, snapping subtly to an event edge;
 * - a click (a press that does not travel) seeks there, keeping the zoom;
 * - a drag pans the shared window — the rows are for navigating the time
 *   axis, while dragging the transport track remains the way to scrub;
 * - the wheel zooms about the pointer; a sideways or Shift wheel pans.
 *
 * Touch reads direction before committing: these rows sit in a region that
 * scrolls vertically, so horizontal travel pans, vertical travel is left to
 * the browser as a scroll (rows declare `touch-action: pan-y`, and the
 * browser cancels the pointer when it takes over), and a tap seeks.
 *
 * A child that handles its own press (an event mark) stops propagation of
 * `pointerdown`, and this never sees it.
 */
export function timelineGestures(node: HTMLElement, initial: TimelineGestureOptions) {
  let opts = initial;
  /** A press not yet read as a click, a pan, or (touch) a scroll. */
  let pending: { id: number; x: number; y: number; touch: boolean } | null = null;
  /** The pointer driving a pan, and where it was last. */
  let panning: { id: number; x: number } | null = null;

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

  const endPan = () => {
    panning = null;
    node.style.cursor = '';
  };

  const reset = () => {
    pending = null;
    endPan();
    setTimelineHover(null);
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const touch = e.pointerType === 'touch';
    pending = { id: e.pointerId, x: e.clientX, y: e.clientY, touch };
    // Mouse and pen: capture now, so a release outside the row still ends the
    // press here. Touch is implicitly captured already, and must stay free to
    // become a scroll.
    if (!touch) node.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (panning && panning.id === e.pointerId) {
      // Content follows the pointer: dragging right shows earlier time.
      panTimelineByPixels(panning.x - e.clientX, node.clientWidth);
      panning.x = e.clientX;
      return;
    }
    if (pending && pending.id === e.pointerId) {
      const dx = Math.abs(e.clientX - pending.x);
      const dy = Math.abs(e.clientY - pending.y);
      if (Math.max(dx, dy) < (pending.touch ? TOUCH_SLOP : MOUSE_SLOP)) return;
      const start = pending;
      pending = null;
      // A touch moving vertically is the region's scroll; the browser will
      // cancel us. Anything else pans.
      if (start.touch && dy >= dx) return;
      if (!node.hasPointerCapture(e.pointerId)) node.setPointerCapture(e.pointerId);
      node.style.cursor = 'grabbing';
      setTimelineHover(null);
      panning = { id: e.pointerId, x: start.x };
      move(e);
      return;
    }
    if (e.pointerType !== 'touch' && !panning) previewAt(e);
  };
  const up = (e: PointerEvent) => {
    if (pending && pending.id === e.pointerId) {
      // A click or tap: seek to it, snapped to an event edge when close.
      pending = null;
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      scrubTo(snappedAt(e).at);
      if (e.pointerType !== 'touch') previewAt(e);
      return;
    }
    if (!panning || panning.id !== e.pointerId) return;
    endPan();
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    if (e.pointerType !== 'touch') previewAt(e);
  };
  const leave = (e: PointerEvent) => {
    if (!panning && e.pointerType !== 'touch') setTimelineHover(null);
  };
  // Non-passive, so the page does not scroll while the timeline zooms or pans.
  const wheel = (e: WheelEvent) => {
    const intent = wheelIntent(e);
    if (!intent) return;
    e.preventDefault();
    if ('pan' in intent) panTimelineByPixels(intent.pan, node.clientWidth);
    else zoomScrubber(intent.zoomIn, timelineEt(fractionAt(e)));
  };

  const listeners: [string, EventListener, AddEventListenerOptions?][] = [
    ['pointerdown', down as EventListener],
    ['pointermove', move as EventListener],
    ['pointerup', up as EventListener],
    ['pointercancel', reset],
    // Only the row's own capture. A touch is implicitly captured by the child
    // it lands on, and taking capture for the row makes that child's loss
    // bubble up here — which is not the pan ending.
    ['lostpointercapture', (e) => { if (panning && e.target === node) reset(); }],
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
      if (panning || (timeline.hoverEt != null && node.matches(':hover'))) setTimelineHover(null);
    },
  };
}
