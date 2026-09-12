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
import { defaultParams, eventDuration, eventStart, isIntervalEvent } from '@cosmolabe/core';

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

/** The one-line summary a result row leads with, after its time. */
export function eventSummary(event: GeometryEvent): string {
  const headline = event.metrics?.find((m) => m.key !== 'threshold' && m.key !== 'duration');
  if (headline) return `${headline.label} ${formatMetric(headline)}`;
  if (isIntervalEvent(event)) return `Duration ${formatSeconds(eventDuration(event))}`;
  return event.label;
}

/** Where an event sits on a full-range timeline, as a 0-1 fraction. */
export function eventFraction(event: GeometryEvent, range: EtInterval): number | null {
  const span = range.end - range.start;
  if (!(span > 0)) return null;
  const fraction = (eventStart(event) - range.start) / span;
  return fraction < 0 || fraction > 1 ? null : fraction;
}
