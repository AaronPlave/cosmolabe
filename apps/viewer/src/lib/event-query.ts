/**
 * The event finder's pure half: form state, query construction, and result
 * formatting.
 *
 * Kept out of the Svelte component so the parts with real behavior — which
 * body a role ends up with, what a blank number field means, how a metric
 * reads — are testable without mounting anything, and so the panel stays
 * markup plus event handlers.
 *
 * Nothing here is kind-specific. A form is built from whatever roles and
 * params a kind declares, which is what lets the same panel configure the
 * occultation and FOV kinds that come later without gaining a branch per kind.
 */
import type {
  EtInterval,
  EventKind,
  EventMetric,
  EventParamSpec,
  EventParticipants,
  EventQuery,
  EventRole,
  EventSearchFault,
  GeometryEvent,
} from '@cosmolabe/core';
import {
  compareEvents,
  defaultParams,
  eventDuration,
  eventEnd,
  eventStart,
  isIntervalEvent,
} from '@cosmolabe/core';

/**
 * The panel's editable state for one search.
 *
 * Params are held as strings because that is what the inputs produce, and
 * because "" has to stay distinguishable from 0: a blank optional threshold
 * means "do not filter", not "filter at zero".
 */
export interface EventQueryForm {
  kind: string;
  bodies: EventParticipants;
  params: Record<string, string>;
  startEt: number;
  endEt: number;
  step: number;
}

/**
 * A form for `kind`, seeded with the kind's declared defaults and carrying
 * over whatever the previous form had assigned to roles this kind also uses —
 * switching from closest approach to a range search should not make the user
 * re-pick the same two bodies.
 */
export function formForKind(
  kind: EventKind<never>,
  window: EtInterval,
  previous?: EventQueryForm,
): EventQueryForm {
  const bodies: EventParticipants = {};
  for (const spec of kind.roles) {
    const carried = previous?.bodies[spec.role];
    const body = carried ?? spec.default;
    if (body) bodies[spec.role] = body;
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaultParams(kind))) {
    params[key] = String(value);
  }
  // A parameter both kinds declare (a distance threshold, say) keeps its value
  // across a kind switch for the same reason roles do.
  for (const spec of kind.params ?? []) {
    const carried = previous?.params[spec.key];
    if (carried !== undefined) params[spec.key] = carried;
  }

  return {
    kind: kind.kind,
    bodies,
    params,
    startEt: window.start,
    endEt: window.end,
    step: previous?.step ?? kind.defaultStep,
  };
}

/** Roles still unfilled — what a "configure this first" hint lists. */
export function missingRoles(kind: EventKind<never>, form: EventQueryForm): EventRole[] {
  return kind.roles
    .filter((spec) => spec.required !== false && !form.bodies[spec.role])
    .map((spec) => spec.role);
}

/**
 * Turns the form into a query.
 *
 * Blank number fields are omitted rather than sent as 0 or NaN: an optional
 * threshold left empty means the kind should not apply it, and a required one
 * left empty should fail the kind's own validation with its own message rather
 * than be silently replaced here.
 */
export function buildQuery(
  kind: EventKind<never>,
  form: EventQueryForm,
  id: string,
): EventQuery<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  for (const spec of kind.params ?? []) {
    const raw = form.params[spec.key];
    const value = parseParam(spec, raw);
    if (value !== undefined) params[spec.key] = value;
  }

  return {
    id,
    kind: kind.kind,
    bodies: { ...form.bodies },
    window: { start: form.startEt, end: form.endEt },
    step: form.step,
    params,
  };
}

function parseParam(spec: EventParamSpec, raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return undefined;
  switch (spec.kind) {
    case 'number': {
      const value = Number(raw);
      return Number.isNaN(value) ? undefined : value;
    }
    case 'boolean':
      return raw === 'true';
    case 'choice':
      return raw;
  }
}

/** The message a fault should be shown with, in the user's terms. */
export function faultMessage(fault: EventSearchFault): string {
  switch (fault.code) {
    case 'missing-body':
    case 'invalid-params':
      return fault.message;
    case 'invalid-window':
      return 'Set a search window that ends after it starts.';
    case 'invalid-step':
      return 'Set a search step of at least one second.';
    case 'unknown-kind':
      return 'That event type is not available.';
    case 'provider-error':
      return `SPICE could not complete the search: ${fault.message}`;
  }
}

/**
 * A metric as one line of text.
 *
 * Distances span metres to AU across the same result list, so km is scaled
 * rather than shown at fixed precision; everything else falls back to the
 * metric's own suggested precision, which is the kind's opinion, not ours.
 */
export function formatMetric(metric: EventMetric): string {
  if (metric.unit === 'km') return formatKm(metric.value);
  if (metric.unit === 's') return formatSeconds(metric.value);
  const digits = metric.precision ?? 2;
  return metric.unit ? `${metric.value.toFixed(digits)} ${metric.unit}` : metric.value.toFixed(digits);
}

/** Adaptive distance, matching the measure tool's vocabulary. */
export function formatKm(km: number): string {
  const abs = Math.abs(km);
  if (abs < 1) return `${(km * 1000).toFixed(1)} m`;
  if (abs < 1000) return `${km.toFixed(1)} km`;
  if (abs < 1e6) return `${(km / 1000).toFixed(1)}K km`;
  if (abs < 1.496e8) return `${(km / 1e6).toFixed(2)}M km`;
  return `${(km / 1.496e8).toFixed(3)} AU`;
}

/** Adaptive duration for event spans. */
export function formatSeconds(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 60) return `${seconds.toFixed(abs < 10 ? 1 : 0)} s`;
  if (abs < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (abs < 86_400) return `${(seconds / 3600).toFixed(1)} hr`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}

/**
 * The metric a result is *about* — what a row leads with and what sorting by
 * value sorts on.
 *
 * `threshold` is the query's own input, the same on every row, and `duration`
 * already has its own column; neither says anything about this result. What is
 * left is the range at a closest approach, or the extreme range inside a
 * distance window.
 */
export function headlineMetric(event: GeometryEvent): EventMetric | undefined {
  return event.metrics?.find((m) => m.key !== 'threshold' && m.key !== 'duration');
}

/** The one-line summary a result row leads with, after its time. */
export function eventSummary(event: GeometryEvent): string {
  const headline = headlineMetric(event);
  if (headline) return `${headline.label} ${formatMetric(headline)}`;
  if (isIntervalEvent(event)) return `Duration ${formatSeconds(eventDuration(event))}`;
  return event.label;
}

/** Which feature of an event a scene callout annotates. */
export interface EventCalloutOptions {
  /** An interval cap, rather than the event as a whole. */
  boundary?: 'start' | 'end';
  /** Selected callouts may carry one extra context line. */
  selected?: boolean;
  /** `YYYY-MM-DD HH:MM:SS UTC` for an ET; injected so this stays pure. */
  utc: (et: number) => string;
}

const STATE_TITLE: Record<string, string> = { full: 'Full', partial: 'Partial', annular: 'Annular' };

/**
 * The noun phrase a callout leads with — what happened, and to which body.
 * The observer is usually implied by the active search, so it is left to the
 * selected callout's context line.
 */
export function eventCalloutTitle(event: GeometryEvent): string {
  const { observer, target, back } = event.bodies;
  switch (event.kind) {
    case 'closest-approach':
      return target ? `Closest approach · ${target}` : 'Closest approach';
    case 'occultation': {
      const phenomenon = back?.toUpperCase() === 'SUN' ? 'eclipse' : 'occultation';
      const state = event.state ? STATE_TITLE[event.state] ?? event.state : '';
      const title = state ? `${state} ${phenomenon}` : phenomenon;
      return title.charAt(0).toUpperCase() + title.slice(1);
    }
    case 'distance-range': {
      // The kind's label is "<target> <relation> <distance> of <observer>";
      // lift the relation phrase out rather than re-deriving the threshold.
      const prefix = `${target} `;
      const suffix = ` of ${observer}`;
      if (target && observer && event.label.startsWith(prefix) && event.label.endsWith(suffix)) {
        const relation = event.label.slice(prefix.length, event.label.length - suffix.length);
        return `${relation.charAt(0).toUpperCase()}${relation.slice(1)} · ${target}`;
      }
      return event.label;
    }
    default:
      return event.label;
  }
}

/**
 * Callout copy as lines: a short title, then at most two structured detail
 * lines — an instrument annotation, not a sentence. Detail beyond this lives
 * in the Event Finder panel.
 *
 *   Closest approach · Europa          Full eclipse begins
 *   303.3K km · 2030-10-29 15:28 UTC   2031-05-27 12:57:36 UTC
 */
export function eventCalloutLines(event: GeometryEvent, options: EventCalloutOptions): string[] {
  const title = eventCalloutTitle(event);
  const { front, back } = event.bodies;
  // Instants read to the minute (the row has the second); interval
  // boundaries keep seconds because short spans are defined by them.
  const minute = (et: number) => options.utc(et).replace(/:\d\d UTC$/, ' UTC');

  if (options.boundary && isIntervalEvent(event)) {
    const et = options.boundary === 'start' ? eventStart(event) : eventEnd(event);
    return [`${title} ${options.boundary === 'start' ? 'begins' : 'ends'}`, options.utc(et)];
  }

  const headline = headlineMetric(event);
  // The marker already sits on the observer's trajectory, so naming the
  // observer again is noise; hover stays two lines, and selection adds a
  // third only when it says something the scene does not.
  if (!isIntervalEvent(event)) {
    return [title, headline ? `${formatMetric(headline)} · ${minute(eventStart(event))}` : minute(eventStart(event))];
  }

  const duration = `Duration ${formatSeconds(eventDuration(event))}`;
  const lines = [title, headline ? `${headline.label} ${formatMetric(headline)} · ${duration}` : duration];
  if (options.selected) {
    if (event.kind === 'occultation' && front && back) lines.push(`${front} occults ${back}`);
    else lines.push(utcSpan(eventStart(event), eventEnd(event), options.utc));
  }
  return lines;
}

/**
 * "2026-05-13 04:00 → 05-18 08:00 UTC": the end drops whatever it shares with
 * the start. Spans under ten minutes keep seconds.
 */
function utcSpan(start: number, end: number, utc: (et: number) => string): string {
  const seconds = end - start < 600;
  const trim = (text: string) => {
    const bare = text.replace(/ UTC$/, '');
    return seconds ? bare : bare.replace(/:\d\d$/, '');
  };
  const a = trim(utc(start));
  let b = trim(utc(end));
  const [aDate, bDate] = [a.slice(0, 10), b.slice(0, 10)];
  if (aDate === bDate) b = b.slice(11);
  else if (aDate.slice(0, 4) === bDate.slice(0, 4)) b = b.slice(5);
  return `${a} → ${b} UTC`;
}

/** How a results list is ordered. */
export type EventSortMode = 'time' | 'metric';

/**
 * Results in the requested order, without disturbing the search's own.
 *
 * `metric` sorts ascending by {@link headlineMetric} — nearest approach first,
 * which is the question "which was the closest?" — and falls back to
 * chronological for ties and for events carrying no metric at all, so a mixed
 * list stays deterministic rather than half-ordered. `EventSearch` returns
 * chronological order, so `time` is the identity.
 */
export function sortEvents(
  events: readonly GeometryEvent[],
  mode: EventSortMode,
): GeometryEvent[] {
  const sorted = [...events];
  if (mode === 'time') return sorted.sort(compareEvents);

  return sorted.sort((a, b) => {
    const va = headlineMetric(a)?.value;
    const vb = headlineMetric(b)?.value;
    if (va === undefined && vb === undefined) return compareEvents(a, b);
    // A result with no measurement cannot be ranked against one that has it;
    // it sorts last rather than as if it were zero.
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    return va - vb || compareEvents(a, b);
  });
}

/**
 * What to call the value-sorted order in the UI, taken from the results
 * themselves — "Range" for closest approaches, "Min range" for distance
 * windows — so the control never names a quantity this kind does not report.
 * Undefined when nothing in the list carries a headline metric.
 */
export function sortMetricLabel(events: readonly GeometryEvent[]): string | undefined {
  for (const event of events) {
    const metric = headlineMetric(event);
    if (metric) return metric.label.toLowerCase();
  }
  return undefined;
}

/** Where an event sits on a full-range timeline, as a 0-1 fraction. */
export function eventFraction(event: GeometryEvent, range: EtInterval): number | null {
  const span = range.end - range.start;
  if (!(span > 0)) return null;
  const fraction = (eventStart(event) - range.start) / span;
  return fraction < 0 || fraction > 1 ? null : fraction;
}

/** Visible start/end fractions for drawing an event on the shared timeline. */
export function eventTimelineFractions(
  event: GeometryEvent,
  range: EtInterval,
): { start: number; end: number } | null {
  const span = range.end - range.start;
  if (!(span > 0)) return null;
  const startEt = eventStart(event);
  const endEt = eventEnd(event);
  if (endEt < range.start || startEt > range.end) return null;
  return {
    start: Math.max(0, (startEt - range.start) / span),
    end: Math.min(1, (endEt - range.start) / span),
  };
}

/** Whether the live playhead is inside an event's inclusive time span. */
export function eventContainsTime(event: GeometryEvent, et: number): boolean {
  return Number.isFinite(et) && et >= eventStart(event) && et <= eventEnd(event);
}

/**
 * The event the playhead is currently traversing.
 *
 * An explicit selection wins only when it is one of the active intervals. If
 * several unselected intervals overlap, the shortest is the most specific
 * description of what is happening at that instant; chronological order and
 * id keep the result deterministic after that.
 */
export function activeEventAtTime(
  events: readonly GeometryEvent[],
  et: number,
  preferred?: Pick<GeometryEvent, 'id' | 'queryId'> | null,
): GeometryEvent | undefined {
  const active = events.filter((event) => eventContainsTime(event, et));
  // Result ids recur across searches: a selection is its id *and* query.
  const match = preferred && active.find((event) => event.id === preferred.id && event.queryId === preferred.queryId);
  if (match) return match;
  return active.sort((a, b) =>
    eventDuration(a) - eventDuration(b)
    || compareEvents(a, b)
    || a.id.localeCompare(b.id)
    || a.queryId.localeCompare(b.queryId)
  )[0];
}
