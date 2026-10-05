import { builtinEventKinds, defaultParams, eventStart, eventEnd, type ConfiguredEventQuery, type EventQuery, type GeometryEvent } from '@cosmolabe/core';
import { ViewStateError } from '@cosmolabe/control';

/** Compact definitions and a result locator, never a serialized result list. */
export interface SharedEventQuery {
  query: EventQuery;
  label: string;
  enabled: boolean;
  visible: boolean;
  windowMode: ConfiguredEventQuery['windowMode'];
  searched: boolean;
  draft?: true;
}
export interface SharedEventSelection {
  query: number;
  temporality: GeometryEvent['temporality'];
  start: number;
  end: number;
  state?: string;
}
export interface EventLinkState {
  version: 1;
  queries: SharedEventQuery[];
  current: number | null;
  selected?: SharedEventSelection;
}

/** Opening a link reruns its searches automatically, so cap that work: GF cost
 * scales with window / step. The cap is per query and across the whole link. */
const MAX_STEPS_PER_QUERY = 5e6;
const MAX_STEPS_TOTAL = 2e7;

const kinds = builtinEventKinds();
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ViewStateError(`Event context: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'malformed definition.');
  return value as Record<string, unknown>;
}
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const et = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 7.5e9;
const index = (v: unknown, count: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < count;

/** Validate against the same registry/parameter declarations as Event Finder.
 * Incomplete drafts are portable but are never executed automatically. */
export function validateEventLinkState(value: unknown): EventLinkState {
  const s = object(value);
  check(s.version === 1, 'unsupported version.');
  check(Array.isArray(s.queries) && s.queries.length <= 16, 'share at most 16 searches.');
  let totalSteps = 0;
  const queries: SharedEventQuery[] = s.queries.map((raw) => {
    const entry = object(raw), q = object(entry.query), w = object(q.window);
    const kind = typeof q.kind === 'string' ? kinds.get(q.kind) : undefined;
    check(kind, `event type "${String(q.kind)}" is unavailable.`);
    check(text(q.id) && text(entry.label), 'invalid query identity or label.');
    check(typeof entry.enabled === 'boolean' && typeof entry.visible === 'boolean' && typeof entry.searched === 'boolean', 'invalid query flags.');
    check(entry.windowMode === 'explicit' || entry.windowMode === 'automatic', 'missing window interpretation.');
    check(entry.draft === undefined || entry.draft === true, 'invalid draft flag.');
    check(!entry.draft || !entry.searched, 'a draft cannot contain searched results.');
    check(et(w.start) && et(w.end) && w.end > w.start, 'invalid search window.');
    check(typeof q.step === 'number' && Number.isFinite(q.step) && q.step > 0, 'invalid search step.');
    if (entry.searched && entry.enabled) {
      const steps = (w.end - w.start) / q.step;
      totalSteps += steps;
      check(steps <= MAX_STEPS_PER_QUERY && totalSteps <= MAX_STEPS_TOTAL,
        `"${entry.label}" is too large to rerun from a link; use a coarser step or shorter window.`);
    }
    check(typeof q.abcorr === 'string' && ['NONE', 'LT', 'LT+S', 'CN', 'CN+S', 'XLT', 'XLT+S', 'XCN', 'XCN+S'].includes(q.abcorr), 'invalid aberration correction.');
    const rawBodies = object(q.bodies), bodies: EventQuery['bodies'] = {};
    for (const spec of kind.roles) {
      const body = rawBodies[spec.role];
      if (body !== undefined) { check(text(body), `invalid ${spec.role} body.`); bodies[spec.role] = body; }
      if (entry.searched && spec.required !== false) check(body !== undefined || spec.default, `missing ${spec.role} body.`);
    }
    const rawParams = q.params === undefined ? {} : object(q.params), params: Record<string, unknown> = {};
    for (const spec of kind.params ?? []) {
      const param = rawParams[spec.key];
      if (param === undefined) continue;
      if (spec.kind === 'number') check(typeof param === 'number' && Number.isFinite(param) &&
        (spec.min === undefined || param >= spec.min) && (spec.max === undefined || param <= spec.max), `invalid ${spec.key}.`);
      else if (spec.kind === 'boolean') check(typeof param === 'boolean', `invalid ${spec.key}.`);
      else check(spec.options.some(o => o.value === param), `invalid ${spec.key}.`);
      params[spec.key] = param;
    }
    const query: EventQuery = { id: q.id, kind: kind.kind, bodies, window: { start: w.start, end: w.end }, step: q.step, abcorr: q.abcorr, params };
    if (q.label !== undefined) { check(text(q.label), 'invalid result label.'); query.label = q.label; }
    if (entry.searched) {
      const fault = kind.validate?.({ ...query, params: { ...defaultParams(kind), ...params } } as unknown as EventQuery<never>);
      check(!fault, fault?.message ?? 'invalid query.');
    }
    return { query, label: entry.label, enabled: entry.enabled, visible: entry.visible,
      windowMode: entry.windowMode, searched: entry.searched, ...(entry.draft ? { draft: true as const } : {}) };
  });
  check(s.current === null || index(s.current, queries.length), 'invalid current search.');
  check(queries.filter(q => q.draft).length <= 1 && queries.every((q, i) => !q.draft || i === s.current), 'draft must be the current search.');
  check(new Set(queries.map(q => q.query.id)).size === queries.length, 'duplicate query identity.');
  let selected: SharedEventSelection | undefined;
  if (s.selected !== undefined) {
    const ref = object(s.selected);
    check(index(ref.query, queries.length), 'selected event has no query.');
    const source = queries[ref.query];
    check(source.enabled && source.searched && !source.draft, 'selected event needs an enabled, completed search.');
    check((ref.temporality === 'instant' || ref.temporality === 'interval') && et(ref.start) && et(ref.end) && ref.end >= ref.start,
      'invalid selected event span.');
    check(ref.temporality !== 'instant' || ref.start === ref.end, 'invalid instant event.');
    check(ref.start >= source.query.window.start && ref.end <= source.query.window.end, 'selected event is outside its query window.');
    check(ref.state === undefined || text(ref.state), 'invalid event state.');
    selected = { query: ref.query, temporality: ref.temporality, start: ref.start, end: ref.end,
      ...(ref.state === undefined ? {} : { state: ref.state }) };
  }
  return { version: 1, queries, current: s.current as number | null, ...(selected ? { selected } : {}) };
}

/** Positional result IDs may change with kernels. Require a unique time/span
 * and classified-state match instead of selecting whichever row reuses an ID. */
export function matchSharedEvent(events: readonly GeometryEvent[], ref: SharedEventSelection): GeometryEvent {
  const matches = events.filter(e => e.temporality === ref.temporality && e.state === ref.state &&
    Math.abs(eventStart(e) - ref.start) <= 0.001 && Math.abs(eventEnd(e) - ref.end) <= 0.001);
  check(matches.length === 1, 'the selected event was not uniquely reproduced with the available kernels.');
  return matches[0];
}
