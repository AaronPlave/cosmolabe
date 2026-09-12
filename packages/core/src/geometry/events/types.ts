/**
 * Shared event/query model for geometry searches.
 *
 * Every geometry search in Cosmolabe — closest approach, range thresholds,
 * occultations, eclipses, FOV access, phase angle, latitude crossings — is
 * expressed as an {@link EventQuery} and answered with {@link GeometryEvent}s.
 * The model is deliberately kind-agnostic: nothing here knows what an eclipse
 * is. Concrete searches live in {@link EventKind} definitions (see
 * `registry.ts`), so a new event type never needs its own results list,
 * timeline overlay, or selection plumbing.
 */

/** Ephemeris time, seconds past the J2000 epoch. */
export type EtSeconds = number;

/** A closed ET interval. Structurally compatible with SPICE's `TimeWindow`. */
export interface EtInterval {
  start: EtSeconds;
  end: EtSeconds;
}

/**
 * The part a body plays in a query.
 *
 * Roles are shared vocabulary rather than per-kind invention: a range search
 * uses `observer`/`target`, an occultation uses `observer`/`front`/`back`, an
 * illumination search adds `illuminator`. A UI that can render a picker for
 * these roles can configure any event kind.
 */
/**
 * The canonical role order.
 *
 * This is the single source of truth for both {@link EventRole} and the order
 * anything role-ordered is emitted in — {@link eventBodies} above all, whose
 * output drives 3D highlighting. Deriving the order from a participant
 * object's own key order would make highlighting depend on how that object
 * happened to be built, so it is fixed here instead.
 */
export const EVENT_ROLES = [
  'observer',
  'target',
  'secondary',
  'front',
  'back',
  'center',
  'illuminator',
] as const;

export type EventRole = (typeof EVENT_ROLES)[number];

/** Body names (SPICE-resolvable) assigned to the roles a kind declares. */
export type EventParticipants = Partial<Record<EventRole, string>>;

/** One role an event kind consumes, as UI needs to present it. */
export interface EventRoleSpec {
  role: EventRole;
  /** Human label for the picker, e.g. "Occulting body". */
  label: string;
  /** When false the kind runs without it. Defaults to required. */
  required?: boolean;
  /** Body name used when the caller leaves the role unset. */
  default?: string;
}

/**
 * One kind-specific parameter, as UI needs to present it.
 *
 * Roles cover *which bodies*; this covers *everything else a kind needs* — a
 * threshold, a relation, a scope. Declaring parameters the same way roles are
 * declared is what lets one configuration form drive every kind: a UI that can
 * render a body picker per {@link EventRoleSpec} and one input per
 * {@link EventParamSpec} can configure a kind it has never heard of.
 *
 * The `key` is the property the kind reads out of `EventQuery.params`.
 */
export type EventParamSpec =
  | {
      kind: 'number';
      key: string;
      label: string;
      /** Display unit, e.g. `km`, `s`. */
      unit?: string;
      default?: number;
      min?: number;
      max?: number;
      /** Input granularity, not a search step. */
      increment?: number;
      /** When false the kind runs without it. Defaults to required. */
      required?: boolean;
      /** One-line explanation for a hint or tooltip. */
      help?: string;
    }
  | {
      kind: 'choice';
      key: string;
      label: string;
      options: readonly { value: string; label: string }[];
      default?: string;
      required?: boolean;
      help?: string;
    }
  | {
      kind: 'boolean';
      key: string;
      label: string;
      default?: boolean;
      help?: string;
    };

/**
 * A displayable quantity attached to an event — range at closest approach,
 * angular separation, duration of totality. Kept as data rather than
 * preformatted text so lists, detail panels, and 3D labels can each decide
 * how much precision to show.
 */
export interface EventMetric {
  key: string;
  label: string;
  value: number;
  /** Display unit, e.g. `km`, `deg`, `s`. */
  unit?: string;
  /** Suggested fraction digits for display. */
  precision?: number;
}

/** Whether a kind yields points in time, spans, or both. */
export type EventTemporality = 'instant' | 'interval';

interface GeometryEventBase {
  /** Unique within one search result. Not an identity across searches. */
  id: string;
  /** The query that produced this event. */
  queryId: string;
  /** The {@link EventKind} that produced this event. */
  kind: string;
  /** Bodies involved, by role — drives 3D highlighting and detail display. */
  bodies: EventParticipants;
  /** Short human label, e.g. "Europa closest approach". */
  label: string;
  metrics?: EventMetric[];
  /**
   * The role whose body selecting this event should select outright.
   *
   * Which body a user means by "this event" is a property of the kind, not of
   * the model: an occultation is about the occulted body, an access window is
   * about the observer. Kinds declare it once via `EventKind.primaryRole` and
   * the search service stamps it here; a kind whose answer varies per event
   * sets it directly. See `focusForEvent`.
   */
  primaryRole?: EventRole;
}

/** A point-in-time event: closest approach, node crossing, threshold crossing. */
export interface InstantEvent extends GeometryEventBase {
  temporality: 'instant';
  et: EtSeconds;
}

/** A span event: occultation, eclipse, in-range window, access window. */
export interface IntervalEvent extends GeometryEventBase {
  temporality: 'interval';
  start: EtSeconds;
  end: EtSeconds;
}

export type GeometryEvent = InstantEvent | IntervalEvent;

/**
 * A geometry search request. `params` carries whatever the kind needs beyond
 * the shared fields (a threshold, a relation, an occultation type); the kind
 * validates it.
 */
export interface EventQuery<P = Record<string, unknown>> {
  /** Caller-assigned; events carry it back so results can be grouped. */
  id: string;
  /** Registered {@link EventKind} name. */
  kind: string;
  bodies: EventParticipants;
  /** Confinement window for the search. */
  window: EtInterval;
  /**
   * GF search step in seconds. Falls back to the kind's default.
   *
   * This is a sampling interval, and it governs completeness rather than
   * validity: GF samples the confinement window at this spacing, so an event
   * that both begins and ends between two samples is missed. Keeping it below
   * the duration of the briefest event of interest is therefore how you avoid
   * missing events — but a longer step is a legitimate coarse search, not an
   * error, and `EventSearch` only rejects a non-finite or non-positive one.
   */
  step?: EtSeconds;
  /** SPICE aberration correction; falls back to the kind's default. */
  abcorr?: string;
  params?: P;
  /** Overrides the generated result label. */
  label?: string;
}

/** Why a search could not run, or could not finish. */
export type EventSearchFaultCode =
  | 'unknown-kind'
  | 'missing-body'
  | 'invalid-window'
  | 'invalid-step'
  | 'invalid-params'
  | 'provider-error';

/**
 * A structured reason a search produced nothing, distinct from a search that
 * legitimately found no events. UI should show these differently: a fault is
 * "we could not look", an empty result is "we looked and there was nothing".
 */
export interface EventSearchFault {
  code: EventSearchFaultCode;
  message: string;
  /** Set for `missing-body`, so a picker can point at the offending field. */
  role?: EventRole;
  /** Window actually searched, when a coverage gap explains the fault. */
  window?: EtInterval;
  cause?: unknown;
}

export type EventSearchResult =
  | { ok: true; queryId: string; events: GeometryEvent[] }
  | { ok: false; queryId: string; fault: EventSearchFault };

/** Narrows a {@link GeometryEvent} to its interval form. */
export function isIntervalEvent(event: GeometryEvent): event is IntervalEvent {
  return event.temporality === 'interval';
}

/** First (or only) instant of an event. */
export function eventStart(event: GeometryEvent): EtSeconds {
  return isIntervalEvent(event) ? event.start : event.et;
}

/** Last (or only) instant of an event. */
export function eventEnd(event: GeometryEvent): EtSeconds {
  return isIntervalEvent(event) ? event.end : event.et;
}

/** Span in seconds; zero for instantaneous events. */
export function eventDuration(event: GeometryEvent): number {
  return isIntervalEvent(event) ? event.end - event.start : 0;
}

/** Midpoint of an interval, or the instant itself. */
export function eventMidpoint(event: GeometryEvent): EtSeconds {
  return isIntervalEvent(event) ? (event.start + event.end) / 2 : event.et;
}

/**
 * Distinct body names involved in an event, in {@link EVENT_ROLES} order.
 *
 * The order is canonical rather than participant-object insertion order, so
 * two events with the same bodies highlight identically no matter how their
 * participant objects were constructed.
 */
export function eventBodies(event: GeometryEvent): string[] {
  const seen = new Set<string>();
  for (const role of EVENT_ROLES) {
    const name = event.bodies[role];
    if (name) seen.add(name);
  }
  return [...seen];
}

/** Chronological comparator for sorting mixed instant/interval results. */
export function compareEvents(a: GeometryEvent, b: GeometryEvent): number {
  return eventStart(a) - eventStart(b) || eventEnd(a) - eventEnd(b);
}
