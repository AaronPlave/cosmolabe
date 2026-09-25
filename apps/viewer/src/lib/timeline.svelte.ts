/**
 * Timeline interaction state shared by every row that draws on the time axis.
 *
 * The axis itself is not here: the zoomed window is `vs.scrubMin`/`scrubMax`
 * and the committed time is `vs.et`, exactly as before, so the transport
 * track, event markers and profile rows cannot disagree about either. What
 * this adds is the *preview* half of "hover = preview, click = commit" — a
 * ghost playhead the timeline's one interaction surface sets and every row
 * reads, the event it is snapped to, if any, and the row being inspected.
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
  /**
   * The row under the pointer (`data-tl-row`), independent of the hovered
   * instant: the shared x is *when* is being inspected, this is *what*.
   * Changing rows never clears the time.
   */
  hoverRow: null as string | null,
  /**
   * A ghost instant set from outside the timeline — an event previewed in
   * the Event Finder's list or the scene — so the profiles read out at that
   * event while it is previewed. The pointer's own hover wins over it.
   */
  linkedEt: null as number | null,
  /** Profile rows shown at their expanded height, by item id. */
  expandedRows: {} as Record<string, boolean>,
  /**
   * Height of the analysis region the user dragged it to, in px; null for the
   * automatic, content-fitted one.
   */
  laneHeight: null as number | null,
  /**
   * Fit mode (double-click the region's edge): sized to its rows, capped only
   * by the hard scene-preserving maximum. Ignored while `laneHeight` is set.
   */
  laneFit: false,
});

/** The inspected (ghost) instant: the pointer's, else a linked preview's. */
export function ghostEt(): number | null {
  return timeline.hoverEt ?? timeline.linkedEt;
}

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
  /** Previewed — hovered on the timeline, in the Event Finder or the scene. */
  previewed: boolean;
  active: boolean;
  /** The event vocabulary: colour by kind and state, shape by temporality. */
  kind: string;
  state?: string;
  /** Who the event is between, for relationship-aware annotation. */
  participants: Readonly<Record<string, string | undefined>>;
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

/**
 * Height, px, of a stacked row's header line — label, readout, controls —
 * on a phone, where rows put it over a full-width plot instead of in a
 * gutter beside it. A hidden row is the header alone.
 */
export const TL_HEAD_PX = 18;

/**
 * A profile row's height, px. Exactly two modes, chosen by the row's own
 * expand toggle and nothing else — never by how many profiles exist: normal
 * (trace and value) and expanded (tall enough for a labelled scale). A
 * phone's row adds its header line; the plot heights match.
 */
export function profileRowHeight(expanded: boolean, wide: boolean): number {
  const plot = expanded ? 116 : 46;
  return wide ? plot : TL_HEAD_PX + plot - 12;
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
  timeline.hoverRow = null;
  timeline.linkedEt = null;
  timeline.expandedRows = {};
}

export interface TimelineGestureOptions {
  /** Event edges a hover may snap to, as fractions of the zoomed window. */
  snapTargets: readonly { fraction: number; id: string }[];
  /** Intervals a hover inside previews, as fractions of the zoomed window. */
  spans?: readonly { start: number; end: number; id: string }[];
}

export interface AxisBounds {
  left: number;
  width: number;
  top: number;
  bottom: number;
}

export interface TimelineSurfaceOptions {
  /**
   * Where the shared axis is live for a pointer, in client px: the transport
   * track's horizontal extent, from the top of the transport to the bottom
   * of the lane region. Null while there is nothing to measure.
   */
  bounds: (e: { clientX: number; clientY: number }) => AxisBounds | null;
  /** The events a hover on a row (its `data-tl-row`) snaps to and previews. */
  targets: (row: string | null) => TimelineGestureOptions;
}

/** Half-width, in px, of the invisible grab target around the playhead line. */
const PLAYHEAD_GRAB_PX = 7;
const PLAYHEAD_GRAB_TOUCH_PX = 12;

/** Travel, in px, before a press is read as a pan (or, for touch, a scroll). */
const MOUSE_SLOP = 3;
const TOUCH_SLOP = 6;

/**
 * Wheel input to timeline action: a mostly-horizontal wheel (a trackpad's
 * sideways swipe) or Shift+wheel pans, by that many pixels of the row; any
 * other wheel zooms.
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

/** The timeline row an element belongs to, by its `data-tl-row`. */
function rowOf(target: EventTarget | null): { id: string; el: Element } | null {
  const el = (target as Element | null)?.closest?.('[data-tl-row]') ?? null;
  const id = el?.getAttribute('data-tl-row');
  return el && id ? { id, el } : null;
}

/** Whether a press landed on an event mark (`data-tl-event-mark`). */
function onEventMark(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.('[data-tl-event-mark]');
}

/**
 * Whether a pointer is on timeline chrome rather than on the time axis.
 *
 * Inside the surface's bounds, everything is live axis — plots, lane marks,
 * the padding and gaps between rows — except what explicitly opts out: a
 * control (a button, link or input, save for an event mark, which is data
 * on the axis and a valid drag origin), or an element marked
 * `data-tl-no-axis` (row labels, the readout rail, a phone row's header
 * line, the transport track that handles its own presses). A plot inside an
 * opted-out element (`data-tl-plot`) opts back in: the nearer marker wins.
 *
 * Decided here rather than by a control stopping propagation: Svelte
 * delegates its handlers to the document root, so a `stopPropagation` there
 * runs after this surface's native listener has already seen the press.
 */
export function isTimelineControl(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el?.closest) return false;
  if (onEventMark(el)) return false;
  if (el.closest('button, a, input, select, textarea, [role="button"]')) return true;
  const zone = el.closest('[data-tl-no-axis], [data-tl-plot]');
  return !!zone && zone.hasAttribute('data-tl-no-axis');
}

/**
 * The timeline's one interaction plane, as a Svelte action on the dock.
 *
 * Every row — the transport track, each event lane, each profile — shares one
 * axis, so the pointer belongs to the axis rather than to a row: moving
 * vertically from the track through the lanes keeps the same hovered instant,
 * and the wheel zooms wherever over the axis it turns, not only over the row
 * it started on. Which row is under the pointer is tracked separately
 * (`timeline.hoverRow`) and only changes local emphasis and what a hover
 * snaps to.
 *
 * - hover sets the ghost playhead and previews the event under it (snapped to
 *   an edge within a few px, or the interval it is inside);
 * - the wheel zooms about the pointer; a sideways or Shift wheel pans;
 * - anywhere on the axis — a plot, or the gaps between rows; not chrome
 *   (`isTimelineControl`) — a click seeks, a drag pans the shared window,
 *   and a drag that starts on the playhead — a thin line with a wider
 *   invisible grab target — scrubs time;
 * - an event mark (`data-tl-event-mark`) is selectable data on that same
 *   axis, not a hole in it: a press on one waits for intent. Released within
 *   the slop, it is the mark's click, and selects; moved past it, it pans (or
 *   scrubs, from the playhead) like any press on the plot, and the click that
 *   would follow is swallowed so the drag does not also select.
 *
 * Presses on the transport track are the track's own (they scrub, as they
 * always have; the track opts out of the axis). The transport manipulates time, the analysis background
 * manipulates the view, and the playhead manipulates time everywhere.
 *
 * Touch reads direction before committing: the lanes sit in a region that
 * scrolls vertically, so horizontal travel pans (or scrubs, from the
 * playhead), vertical travel is left to the browser as a scroll (plots declare
 * `touch-action: pan-y`, and the browser cancels the pointer when it takes
 * over), and a tap seeks.
 */
export function timelineSurface(node: HTMLElement, initial: TimelineSurfaceOptions) {
  let opts = initial;
  /** A press not yet read as a click, a drag, or (touch) a scroll. */
  let pending: {
    id: number; x: number; y: number; touch: boolean; onPlayhead: boolean; mark: boolean;
    row: string | null; bounds: AxisBounds;
  } | null = null;
  /** A drag just ended that began on a mark: the click after it is not a select. */
  let swallowClick = false;
  /** The pointer driving a drag, what it drives, and where it was last. */
  // The axis a drag started on is the one it keeps, wherever it wanders.
  let drag: { id: number; x: number; mode: 'pan' | 'scrub'; bounds: AxisBounds } | null = null;

  /**
   * Cursor state as a data attribute, which the stylesheet applies to the
   * dock and its plots alike — an inline cursor on the dock would lose to
   * the plots' own crosshair.
   */
  const setCursor = (state: 'playhead' | 'scrub' | 'pan' | null) => {
    if (state) node.dataset.tlCursor = state;
    else delete node.dataset.tlCursor;
  };

  /** The pointer's fraction of the axis, or null outside the live area. */
  const fractionAt = (e: PointerEvent | WheelEvent, clamp = false, b = opts.bounds(e)) => {
    if (!b || !(b.width > 0)) return null;
    const f = (e.clientX - b.left) / b.width;
    if (clamp) return clampFraction(f);
    if (f < 0 || f > 1 || e.clientY < b.top || e.clientY > b.bottom) return null;
    return f;
  };

  const nearPlayhead = (e: PointerEvent) => {
    const b = opts.bounds(e);
    if (!b) return false;
    const px = timelineFraction(vs.et) * b.width + b.left;
    const reach = e.pointerType === 'touch' ? PLAYHEAD_GRAB_TOUCH_PX : PLAYHEAD_GRAB_PX;
    return Math.abs(e.clientX - px) <= reach;
  };

  const previewAt = (e: PointerEvent) => {
    const row = rowOf(e.target);
    if (timeline.hoverRow !== (row?.id ?? null)) timeline.hoverRow = row?.id ?? null;
    const b = opts.bounds(e);
    const f = fractionAt(e, false, b);
    if (f == null || !b) {
      if (timeline.hoverEt != null) setTimelineHover(null);
      setCursor(null);
      return;
    }
    const { at, id } = hoverTarget(f, b.width, opts.targets(row?.id ?? null));
    const top = row ? row.el.getBoundingClientRect().top : b.top;
    setTimelineHover(timelineEt(at), id, { x: b.left + at * b.width, y: top });
    setCursor(!isTimelineControl(e.target) && nearPlayhead(e) ? 'playhead' : null);
  };

  const endDrag = () => {
    drag = null;
    setCursor(null);
  };

  const reset = () => {
    pending = null;
    swallowClick = false;
    endDrag();
    setTimelineHover(null);
  };

  const beginDrag = (e: PointerEvent, mode: 'pan' | 'scrub', fromX: number, bounds: AxisBounds, mark = false) => {
    swallowClick = mark;
    if (!node.hasPointerCapture(e.pointerId)) node.setPointerCapture(e.pointerId);
    setCursor(mode);
    setTimelineHover(null);
    drag = { id: e.pointerId, x: fromX, mode, bounds };
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0 || isTimelineControl(e.target)) return;
    const bounds = opts.bounds(e);
    if (!bounds || fractionAt(e, false, bounds) == null) return;
    const touch = e.pointerType === 'touch';
    const onPlayhead = nearPlayhead(e);
    const mark = onEventMark(e.target);
    if (onPlayhead && !touch && !mark) {
      // Grabbing the playhead scrubs at once, like the transport track.
      beginDrag(e, 'scrub', e.clientX, bounds);
      return;
    }
    pending = { id: e.pointerId, x: e.clientX, y: e.clientY, touch, onPlayhead, mark, row: rowOf(e.target)?.id ?? null, bounds };
    // Mouse and pen: capture now, so a release outside the plot still ends
    // the press here. Not on a mark, whose click must still land on it if
    // this turns out to be one; a drag captures when it starts. Touch is
    // implicitly captured already, and must stay free to become a scroll.
    if (!touch && !mark) node.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (drag && drag.id === e.pointerId) {
      if (drag.mode === 'scrub') {
        const f = fractionAt(e, true, drag.bounds);
        if (f != null) scrubTo(f);
      } else {
        // Content follows the pointer: dragging right shows earlier time.
        panTimelineByPixels(drag.x - e.clientX, drag.bounds.width);
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
      beginDrag(e, start.onPlayhead ? 'scrub' : 'pan', start.x, start.bounds, start.mark);
      move(e);
      return;
    }
    if (e.pointerType === 'touch') return;
    // A press held elsewhere — the transport track scrubbing, a resize — is
    // not a hover.
    if (e.buttons) {
      if (timeline.hoverEt != null) setTimelineHover(null);
      return;
    }
    previewAt(e);
  };
  const up = (e: PointerEvent) => {
    if (pending && pending.id === e.pointerId) {
      const start = pending;
      pending = null;
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      // A click on a mark is the mark's: it selects.
      if (start.mark) return;
      // A click or tap on the background: seek to it, snapped to an event
      // edge when close.
      const f = fractionAt(e, true, start.bounds);
      if (f != null) scrubTo(hoverTarget(f, start.bounds.width, opts.targets(start.row)).at);
      if (e.pointerType !== 'touch') previewAt(e);
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    endDrag();
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    if (e.pointerType !== 'touch') previewAt(e);
    // The click, if one follows this release, comes in the same task.
    if (swallowClick) setTimeout(() => { swallowClick = false; }, 0);
  };
  // Capture phase, ahead of the mark's own (delegated) click handler.
  const click = (e: Event) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };
  const leave = (e: PointerEvent) => {
    if (drag || e.pointerType === 'touch') return;
    setTimelineHover(null);
    timeline.hoverRow = null;
    setCursor(null);
  };
  // Non-passive, so the page does not scroll while the timeline zooms or pans.
  const wheel = (e: WheelEvent) => {
    const b = opts.bounds(e);
    const f = fractionAt(e, false, b);
    if (f == null || !b) return;
    const intent = wheelIntent(e);
    if (!intent) return;
    e.preventDefault();
    if ('pan' in intent) panTimelineByPixels(intent.pan, b.width);
    else zoomScrubber(intent.zoomIn, timelineEt(f));
  };

  const listeners: [string, EventListener, AddEventListenerOptions?][] = [
    ['pointerdown', down as EventListener],
    ['pointermove', move as EventListener],
    ['pointerup', up as EventListener],
    ['pointercancel', ((e: PointerEvent) => { if (pending?.id === e.pointerId || drag?.id === e.pointerId) reset(); }) as EventListener],
    // Only the surface's own capture. A touch is implicitly captured by the
    // element it lands on, and taking capture for the surface makes that
    // element's loss bubble up here — which is not the drag ending.
    ['lostpointercapture', (e) => { if (drag && e.target === node) reset(); }],
    ['pointerleave', leave as EventListener],
    ['wheel', wheel as EventListener, { passive: false }],
    ['click', click, { capture: true }],
  ];
  for (const [type, fn, o] of listeners) node.addEventListener(type, fn, o);
  return {
    update(next: TimelineSurfaceOptions) {
      opts = next;
    },
    destroy() {
      for (const [type, fn, o] of listeners) node.removeEventListener(type, fn, o);
      setTimelineHover(null);
      timeline.hoverRow = null;
    },
  };
}

/** Advance of one character of the 12 px mono clock, px, and its padding. */
const CLOCK_CHAR_PX = 7.3;
const CLOCK_PAD_PX = 16;

/**
 * The current-time readout for a width of `roomPx`, as one or two lines.
 *
 * The date is the one part never given up — on a multi-year mission it is
 * the context everything else hangs on — so the ladder drops the time zone,
 * then the seconds, and only then breaks the date and time onto two lines:
 * `2030-07-29 18:31:21 UTC` → `2030-07-29 18:31:21` → `2030-07-29 18:31` →
 * `2030-07-29` / `18:31`. Text that is not a UTC timestamp is left whole.
 */
export function clockLines(timeText: string, roomPx: number): string[] {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2}) UTC$/.exec(timeText);
  if (!m) return [timeText];
  const [, date, hm, sec] = m;
  for (const text of [`${date} ${hm}${sec} UTC`, `${date} ${hm}${sec}`, `${date} ${hm}`]) {
    if (text.length * CLOCK_CHAR_PX + CLOCK_PAD_PX <= roomPx) return [text];
  }
  return [date, hm];
}
