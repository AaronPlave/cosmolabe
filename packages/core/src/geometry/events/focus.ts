import {
  eventBodies,
  eventEnd,
  eventMidpoint,
  eventStart,
  isIntervalEvent,
  type EtInterval,
  type EtSeconds,
  type GeometryEvent,
} from './types.js';

/**
 * Timeline and 3D integration for event results.
 *
 * Selecting an event has to do two things everywhere: move simulation time to
 * the right instant, and make the bodies involved identifiable in the 3D view.
 * Those are expressed here as pure functions over the shared model, so the
 * viewer wires them to its own time and selection surfaces without core
 * knowing anything about the UI — and so every event kind gets the behavior
 * without reimplementing it.
 */

/** Which instant of an event to move simulation time to. */
export type EventFocusAnchor = 'start' | 'end' | 'middle';

/** What selecting an event asks the application to do. */
export interface EventFocus {
  /** Simulation time to move to. */
  et: EtSeconds;
  /** Bodies to identify in the 3D view. */
  bodies: string[];
  /** The body worth selecting outright, when the kind names one. */
  primary?: string;
  /** Full span, for intervals — lets the timeline frame the event, not just seek. */
  interval?: EtInterval;
}

/**
 * Fallback role preference, used only when neither the event nor its kind said
 * which body it is about.
 *
 * This is a guess, not a general truth: it happens to suit observer/target and
 * occultation geometry, but which body a user means by "this event" is a
 * property of the kind. Kinds should declare `primaryRole` rather than rely on
 * this ordering.
 */
const FALLBACK_PRIMARY_ROLES = ['target', 'back', 'front', 'secondary', 'observer'] as const;

/**
 * Derives the time and bodies an event selection should drive.
 *
 * The body to select is the one the event's `primaryRole` names — set by the
 * kind, which is what knows. Only an event that declares no role, and whose
 * kind declared none either, falls back to {@link FALLBACK_PRIMARY_ROLES}.
 */
export function focusForEvent(event: GeometryEvent, anchor: EventFocusAnchor = 'start'): EventFocus {
  const et =
    anchor === 'end' ? eventEnd(event) : anchor === 'middle' ? eventMidpoint(event) : eventStart(event);

  const declared = event.primaryRole ? event.bodies[event.primaryRole] : undefined;
  const primary =
    declared ?? FALLBACK_PRIMARY_ROLES.map((role) => event.bodies[role]).find((name) => !!name);

  return {
    et,
    bodies: eventBodies(event),
    ...(primary ? { primary } : {}),
    ...(isIntervalEvent(event) ? { interval: { start: event.start, end: event.end } } : {}),
  };
}

/**
 * The application surfaces an event selection drives. The viewer's existing
 * time and selection controls satisfy this; `highlightBodies` is optional so a
 * host without a highlight channel still gets time and selection sync.
 */
export interface EventFocusTarget {
  setTime(et: EtSeconds): void;
  selectBody?(name: string): void;
  highlightBodies?(names: string[]): void;
}

/** Applies a focus to a host application. */
export function applyEventFocus(focus: EventFocus, target: EventFocusTarget): void {
  target.setTime(focus.et);
  if (focus.primary) target.selectBody?.(focus.primary);
  target.highlightBodies?.(focus.bodies);
}

/**
 * The span a timeline should draw for an event.
 *
 * Instantaneous events have zero width and would otherwise be invisible, so
 * they are widened to `minWidth` seconds centered on the instant. Intervals
 * shorter than `minWidth` are widened the same way, keeping a brief
 * occultation clickable at a coarse zoom.
 */
export function eventTimelineSpan(event: GeometryEvent, minWidth: EtSeconds = 0): EtInterval {
  const start = eventStart(event);
  const end = eventEnd(event);
  if (end - start >= minWidth) return { start, end };

  const pad = (minWidth - (end - start)) / 2;
  return { start: start - pad, end: end + pad };
}

/** Whether an event overlaps a time range — the timeline's culling predicate. */
export function eventOverlaps(event: GeometryEvent, range: EtInterval): boolean {
  return eventStart(event) <= range.end && eventEnd(event) >= range.start;
}

/** The event covering or nearest to `et`, for "what is happening now?" readouts. */
export function eventNearest(events: readonly GeometryEvent[], et: EtSeconds): GeometryEvent | undefined {
  let best: GeometryEvent | undefined;
  let bestDistance = Infinity;

  for (const event of events) {
    const start = eventStart(event);
    const end = eventEnd(event);
    const distance = et < start ? start - et : et > end ? et - end : 0;
    if (distance < bestDistance) {
      best = event;
      bestDistance = distance;
    }
  }

  return best;
}
