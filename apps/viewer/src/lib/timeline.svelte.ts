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
  /**
   * `eventKey` of the event under the hover — snapped to or inside — for
   * cross-highlighting and the hover callout.
   */
  previewEventId: null as string | null,
  /**
   * Where the hover callout points, in client px: the hovered instant's x and
   * the top of the row it happened on.
   */
  anchor: null as { x: number; y: number } | null,
  /** Profile rows shown at their expanded height, by item id. */
  expandedRows: {} as Record<string, boolean>,
  /**
   * Height of the analysis region the user dragged it to, in px; null for the
   * default, content-sized one.
   */
  laneHeight: null as number | null,
});

/**
 * An event's identity on the timeline. Result ids are unique only within one
 * search, so the query is part of it.
 */
export function eventKey(event: { id: string; queryId: string }): string {
  return `${event.queryId}\u0000${event.id}`;
}

/** An event as a profile row draws it: fractions of the zoomed window. */
export interface ProfileEventTick {
  /** `eventKey` of the event. */
  id: string;
  fraction: number;
  endFraction: number;
  selected: boolean;
  active: boolean;
}

export function setTimelineHover(
  et: number | null,
  eventId: string | null = null,
  anchor: { x: number; y: number } | null = null,
) {
  timeline.hoverEt = et;
  timeline.previewEventId = et == null ? null : eventId;
  timeline.anchor = et == null ? null : anchor;
}

export function toggleRowExpanded(id: string) {
  timeline.expandedRows[id] = !timeline.expandedRows[id];
}

/**
 * The event a hover at `fraction` previews: one it is snapped to (an edge or
 * instant within a few px), else the shortest interval it is inside.
 */
export function hoverTarget(
  fraction: number,
  widthPx: number,
  opts: TimelineGestureOptions,
): { at: number; id: string | null } {
  const snap = snapFraction(fraction, opts.snapTargets, widthPx);
  if (snap) return { at: snap.fraction, id: snap.id };
  let inside: { id: string; width: number } | null = null;
  for (const s of opts.spans ?? []) {
    if (fraction < s.start || fraction > s.end) continue;
    const width = s.end - s.start;
    if (!inside || width < inside.width) inside = { id: s.id, width };
  }
  return { at: fraction, id: inside?.id ?? null };
}

/** Snap targets and hover spans for a set of drawn events. */
export function eventHoverTargets(ticks: readonly { id: string; fraction: number; endFraction: number }[]):
  Pick<TimelineGestureOptions, 'snapTargets' | 'spans'> {
  return {
    snapTargets: ticks.flatMap((t) => t.endFraction > t.fraction
      ? [{ fraction: t.fraction, id: t.id }, { fraction: t.endFraction, id: t.id }]
      : [{ fraction: t.fraction, id: t.id }]),
    spans: ticks.filter((t) => t.endFraction > t.fraction).map((t) => ({ start: t.fraction, end: t.endFraction, id: t.id })),
  };
}

/** Fraction of the zoomed window at `et` — may fall outside [0, 1]. */
export function timelineFraction(et: number): number {
  return windowFraction(et, vs.scrubMin, vs.scrubMax);
}

export function timelineEt(fraction: number): number {
  return vs.scrubMin + fraction * (vs.scrubMax - vs.scrubMin);
}

/**
 * Scene-owned; a new catalog must not inherit a stale ghost or expansion
 * state keyed by the old catalog's items. The region height is a preference
 * and stays.
 */
export function resetTimeline() {
  setTimelineHover(null);
  timeline.expandedRows = {};
}

export interface TimelineGestureOptions {
  /** Event edges a hover may snap to, as fractions of the zoomed window. */
  snapTargets: readonly { fraction: number; id: string }[];
  /** Intervals a hover inside previews, as fractions of the zoomed window. */
  spans?: readonly { start: number; end: number; id: string }[];
}

/** Half-width, in px, of the invisible grab target around the playhead line. */
const PLAYHEAD_GRAB_PX = 5;
const PLAYHEAD_GRAB_TOUCH_PX = 12;

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
 * - hover sets the ghost playhead and previews the event under it (snapped to
 *   an edge within a few px, or the interval it is inside);
 * - a click on the background (a press that does not travel) seeks there;
 * - a drag on the background pans the shared window;
 * - a drag that starts on the playhead — a thin line with a wider invisible
 *   grab target — scrubs time, as dragging the transport track does;
 * - the wheel zooms about the pointer; a sideways or Shift wheel pans.
 *
 * The transport manipulates time, the analysis background manipulates the
 * view, and the playhead manipulates time everywhere.
 *
 * Touch reads direction before committing: these rows sit in a region that
 * scrolls vertically, so horizontal travel pans (or scrubs, from the
 * playhead), vertical travel is left to the browser as a scroll (rows declare
 * `touch-action: pan-y`, and the browser cancels the pointer when it takes
 * over), and a tap seeks.
 *
 * A child that handles its own press (an event mark) stops propagation of
 * `pointerdown`, and this never sees it.
 */
export function timelineGestures(node: HTMLElement, initial: TimelineGestureOptions) {
  let opts = initial;
  /** A press not yet read as a click, a drag, or (touch) a scroll. */
  let pending: { id: number; x: number; y: number; touch: boolean; onPlayhead: boolean } | null = null;
  /** The pointer driving a drag, what it drives, and where it was last. */
  let drag: { id: number; x: number; mode: 'pan' | 'scrub' } | null = null;

  const fractionAt = (e: PointerEvent | WheelEvent) => {
    const rect = node.getBoundingClientRect();
    return clampFraction((e.clientX - rect.left) / rect.width);
  };

  const nearPlayhead = (e: PointerEvent) => {
    const rect = node.getBoundingClientRect();
    const px = (timelineFraction(vs.et) * rect.width) + rect.left;
    const reach = e.pointerType === 'touch' ? PLAYHEAD_GRAB_TOUCH_PX : PLAYHEAD_GRAB_PX;
    return Math.abs(e.clientX - px) <= reach;
  };

  const previewAt = (e: PointerEvent) => {
    const rect = node.getBoundingClientRect();
    const { at, id } = hoverTarget(fractionAt(e), rect.width, opts);
    setTimelineHover(timelineEt(at), id, { x: rect.left + at * rect.width, y: rect.top });
    node.style.cursor = nearPlayhead(e) ? 'ew-resize' : '';
  };

  const endDrag = () => {
    drag = null;
    node.style.cursor = '';
  };

  const reset = () => {
    pending = null;
    endDrag();
    setTimelineHover(null);
  };

  const beginDrag = (e: PointerEvent, mode: 'pan' | 'scrub', fromX: number) => {
    if (!node.hasPointerCapture(e.pointerId)) node.setPointerCapture(e.pointerId);
    node.style.cursor = mode === 'pan' ? 'grabbing' : 'ew-resize';
    setTimelineHover(null);
    drag = { id: e.pointerId, x: fromX, mode };
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const touch = e.pointerType === 'touch';
    const onPlayhead = nearPlayhead(e);
    if (onPlayhead && !touch) {
      // Grabbing the playhead scrubs at once, like the transport track.
      beginDrag(e, 'scrub', e.clientX);
      return;
    }
    pending = { id: e.pointerId, x: e.clientX, y: e.clientY, touch, onPlayhead };
    // Mouse and pen: capture now, so a release outside the row still ends the
    // press here. Touch is implicitly captured already, and must stay free to
    // become a scroll.
    if (!touch) node.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (drag && drag.id === e.pointerId) {
      if (drag.mode === 'scrub') {
        scrubTo(fractionAt(e));
      } else {
        // Content follows the pointer: dragging right shows earlier time.
        panTimelineByPixels(drag.x - e.clientX, node.clientWidth);
      }
      drag.x = e.clientX;
      return;
    }
    if (pending && pending.id === e.pointerId) {
      const dx = Math.abs(e.clientX - pending.x);
      const dy = Math.abs(e.clientY - pending.y);
      if (Math.max(dx, dy) < (pending.touch ? TOUCH_SLOP : MOUSE_SLOP)) return;
      const start = pending;
      pending = null;
      // A touch moving vertically is the region's scroll; the browser will
      // cancel us. Anything else drags.
      if (start.touch && dy >= dx) return;
      beginDrag(e, start.onPlayhead ? 'scrub' : 'pan', start.x);
      move(e);
      return;
    }
    if (e.pointerType !== 'touch' && !drag) previewAt(e);
  };
  const up = (e: PointerEvent) => {
    if (pending && pending.id === e.pointerId) {
      // A click or tap: seek to it, snapped to an event edge when close.
      pending = null;
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      scrubTo(hoverTarget(fractionAt(e), node.clientWidth, opts).at);
      if (e.pointerType !== 'touch') previewAt(e);
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    endDrag();
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    if (e.pointerType !== 'touch') previewAt(e);
  };
  const leave = (e: PointerEvent) => {
    if (!drag && e.pointerType !== 'touch') {
      setTimelineHover(null);
      node.style.cursor = '';
    }
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
    // bubble up here — which is not the drag ending.
    ['lostpointercapture', (e) => { if (drag && e.target === node) reset(); }],
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
      if (drag || (timeline.hoverEt != null && node.matches(':hover'))) setTimelineHover(null);
    },
  };
}
