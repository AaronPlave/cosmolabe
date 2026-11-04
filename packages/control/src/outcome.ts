/**
 * Outcome predicates (#345): is the requested end state actually on screen,
 * judged from the viewer's own reads rather than from what a model said or
 * which calls returned ok.
 *
 * A goal is an AND of typed predicates — data, never code. Predicates come
 * from two places: every write operation's contract derives the state it must
 * leave (`select Mars` → `selected Mars`), and a request may add intent no
 * action implies ("Mars in view", "keep Psyche within 1 km"). The same
 * evaluator serves Ask's host check, receipts, the deterministic tests and the
 * paid benchmark.
 *
 * Most predicates are generic reads of shared viewer state. `state` compares
 * any registered read's value at a path, so a new operation states its result
 * without a new predicate. The domain-specific ones exist only where a plain
 * comparison cannot prove the result: camera composition (projection,
 * occlusion, apparent size), event presentation (closest by measured range,
 * clock inside the result, participants framed) and ground points (the
 * vehicle's actual sub-point).
 *
 * `met` needs every check to pass. `partial` means the requested state holds
 * but something only the renderer can confirm (drawing, data readiness,
 * legible size) has not been observed. Missing evidence is never success.
 */
import { classifyApproach, etFromCalendarString } from '@cosmolabe/core';
import type { ViewerControl } from './contracts.js';

/** The state an operation may change. A write declares the domains it touches. */
export const STATE_DOMAINS = ['camera', 'time', 'selection', 'events', 'surface', 'imagery', 'geographic', 'probe', 'measurements', 'bookmarks',
  'instruments', 'display', 'places', 'grid', 'capture', 'activities', 'analysis', 'scene'] as const;
export type StateDomain = typeof STATE_DOMAINS[number];

export const PREDICATE_KINDS = ['selected', 'tracked', 'inView', 'legible', 'range', 'epoch', 'paused', 'rate', 'activity', 'place',
  'eventQuery', 'eventRun', 'eventSelected', 'eventEpoch', 'eventFramed', 'eventDrawn', 'probeUnder', 'probeDrawn', 'featureSelected', 'featureUnder',
  'state', 'ready'] as const;
export type PredicateKind = typeof PREDICATE_KINDS[number];

/** One postcondition. Fields used depend on `p`; `parsePredicate` says which. */
export interface Predicate {
  readonly p: PredicateKind;
  readonly object?: string | null;
  readonly maxKm?: number;
  readonly minKm?: number;
  readonly et?: number;
  readonly utc?: string;
  readonly value?: boolean | number;
  readonly query?: string;
  readonly id?: string | null;
  readonly pick?: 'closest';
  /** eventSelected: the selected result must be an encounter by its stated criterion, not only a range minimum. */
  readonly encounter?: boolean;
  readonly framing?: 'pair' | 'target';
  readonly layer?: string;
  readonly feature?: string;
  /** state: a registered read, its arguments, a path into its value and the value expected there. */
  readonly read?: string;
  readonly args?: readonly unknown[];
  readonly path?: string;
  readonly equals?: unknown;
  /** state: `equals` need only be contained in the value (the fields given), for a host that fills defaults. */
  readonly subset?: boolean;
  /** state: numeric tolerance for a number `equals` (seconds, km). */
  readonly within?: number;
  /** ready: a readiness request kind. */
  readonly kind?: 'assets' | 'imagery' | 'cube-base' | 'terrain';
  readonly body?: string;
  /** probeUnder: the surface the sub-point is projected to (default rendered). */
  readonly policy?: 'reference' | 'rendered' | 'terrain';
}

export interface GoalCheck {
  /** What it is about; a later predicate on the same slot replaces it. */
  readonly slot: string;
  /** null: could not be observed (counts against `met`). */
  readonly ok: boolean | null;
  readonly detail: string;
  /** Renderer-only evidence (drawn, data ready, legible size): failing alone makes the goal `partial`. */
  readonly soft: boolean;
}

export type GoalStatus = 'met' | 'partial' | 'unmet' | 'inconclusive';
export interface GoalReport {
  readonly status: GoalStatus;
  readonly checks: readonly GoalCheck[];
}

/** Camera predicates: there is one camera, so they share an anchor. */
const VIEW = new Set<PredicateKind>(['tracked', 'inView', 'legible', 'range', 'eventFramed']);
const SOFT = new Set<PredicateKind>(['legible', 'eventDrawn', 'probeDrawn', 'ready']);
export const isViewPredicate = (p: Predicate) => VIEW.has(p.p);

export function slotOf(p: Predicate): string {
  switch (p.p) {
    case 'inView': return `view:${p.object}`;
    case 'legible': return `legible:${p.object}`;
    case 'range': return `range:${p.object}`;
    case 'epoch': case 'eventEpoch': return 'clock';
    case 'paused': return 'playing';
    case 'eventQuery': case 'eventRun': return `${p.p}:${p.query}`;
    case 'eventSelected': return 'event';
    case 'probeUnder': return 'probe';
    case 'featureSelected': return 'feature';
    case 'featureUnder': return `featureUnder:${p.object}`;
    case 'state': return `state:${p.read}${JSON.stringify(p.args ?? [])}${p.path ?? ''}`;
    case 'ready': return `ready:${p.kind}:${p.body ?? ''}:${p.layer ?? ''}`;
    default: return p.p;
  }
}

/** A short label for notes: "inView Mars", "epoch 2026-05-15T…". */
export function describePredicate(p: Predicate): string {
  const bits = [p.object, p.query, p.id, p.read, p.path, p.kind, p.body, p.layer, p.feature, p.utc, p.et, p.maxKm !== undefined ? `<= ${p.maxKm} km` : undefined,
    p.minKm !== undefined ? `>= ${p.minKm} km` : undefined, p.value, p.equals === undefined ? undefined : `= ${JSON.stringify(p.equals)}`, p.pick, p.encounter ? 'encounter' : undefined]
    .filter(v => v !== undefined && v !== null);
  return `${p.p}${bits.length ? ` ${bits.join(' ')}` : ''}`;
}

const need = (cond: unknown, what: string) => { if (!cond) throw new Error(what); };

/** Validate one predicate's shape; throws with the first problem. */
export function parsePredicate(input: unknown): Predicate {
  const g = input as Record<string, unknown>;
  need(g && typeof g === 'object' && !Array.isArray(g), 'each predicate must be an object');
  need((PREDICATE_KINDS as readonly unknown[]).includes(g.p), `p must be one of ${PREDICATE_KINDS.join(', ')}`);
  const text = (k: string) => typeof g[k] === 'string' && (g[k] as string).length > 0;
  const num = (k: string) => g[k] === undefined || (typeof g[k] === 'number' && Number.isFinite(g[k]));
  const p = g.p as PredicateKind;
  switch (p) {
    case 'selected': case 'tracked': need(g.object === null || text('object'), `${p} needs object (a name, or null for none)`); break;
    case 'inView': case 'legible': case 'featureUnder': case 'probeUnder': need(text('object'), `${p} needs object`); break;
    case 'range':
      need(text('object'), 'range needs object');
      need(num('maxKm') && num('minKm') && (g.maxKm !== undefined || g.minKm !== undefined), 'range needs maxKm and/or minKm in km');
      break;
    case 'epoch': need((typeof g.et === 'number' && Number.isFinite(g.et)) || text('utc'), 'epoch needs et (ET seconds) or utc (calendar text)'); break;
    case 'paused': need(typeof g.value === 'boolean', 'paused needs value true|false'); break;
    case 'rate': need(typeof g.value === 'number' && Number.isFinite(g.value), 'rate needs value'); break;
    case 'activity': case 'place': need(g.id === null || text('id'), `${p} needs id`); break;
    case 'eventQuery': case 'eventRun': case 'eventEpoch': case 'eventFramed': case 'eventDrawn': need(text('query'), `${p} needs query`); break;
    case 'eventSelected':
      need(text('query'), 'eventSelected needs query');
      need(g.pick === undefined || g.pick === 'closest', 'pick is closest');
      need(g.encounter === undefined || typeof g.encounter === 'boolean', 'encounter is boolean');
      break;
    case 'probeDrawn': break;
    case 'featureSelected': need(g.layer === undefined || text('layer'), 'featureSelected layer must be text'); break;
    case 'state':
      need(text('read'), 'state needs read (a registered read operation)');
      need(g.args === undefined || Array.isArray(g.args), 'state args must be an array');
      need(g.path === undefined || typeof g.path === 'string', 'state path must be text');
      need('equals' in g, 'state needs equals');
      break;
    case 'ready': need(['assets', 'imagery', 'cube-base', 'terrain'].includes(g.kind as string), 'ready needs kind assets|imagery|cube-base|terrain'); break;
  }
  if (g.framing !== undefined) need(g.framing === 'pair' || g.framing === 'target', 'framing is pair|target');
  if (g.policy !== undefined) need(['reference', 'rendered', 'terrain'].includes(g.policy as string), 'policy is reference|rendered|terrain');
  return g as unknown as Predicate;
}

// ── Holding a conversation's goal ──

/** The camera's subject in a set of predicates: what it tracks, or the event it presents. */
function anchorOf(preds: readonly Predicate[]): string | null {
  const tracked = preds.find(p => p.p === 'tracked' && typeof p.object === 'string');
  if (tracked) return tracked.object as string;
  const framed = preds.find(p => p.p === 'eventFramed');
  return framed ? `event:${framed.query}` : null;
}

/**
 * Add predicates to what a conversation holds. A predicate replaces the held
 * one on its slot. When the incoming ones move the camera to another subject
 * (another tracked object, or an event's framing), the earlier camera
 * predicates are retired: there is one camera. Everything else stays.
 */
export function adopt(held: readonly Predicate[], incoming: readonly Predicate[], protect: ReadonlySet<string> = new Set()): { held: Predicate[]; replaced: string[]; retired: string[] } {
  const next = new Map(held.map(p => [slotOf(p), p]));
  const replaced: string[] = [], retired: string[] = [];
  const before = anchorOf(held), after = anchorOf(incoming);
  if (after && after !== before) {
    // What the person asked about the new subject itself ("keep Psyche close") stays.
    // So does what this request itself asked for (`protect`): its own actions do not undo it.
    for (const [slot, p] of next) if (isViewPredicate(p) && p.object !== after && !protect.has(slot) && !incoming.some(q => slotOf(q) === slot)) { next.delete(slot); retired.push(describePredicate(p)); }
  }
  for (const p of incoming) {
    const old = next.get(slotOf(p));
    // The result an operation selects inherits what the person required of it (the closest, a real encounter).
    const merged = old && p.p === 'eventSelected' && old.p === 'eventSelected' && old.query === p.query ? { ...old, ...p } : p;
    if (old && JSON.stringify(old) !== JSON.stringify(merged) && merged === p) replaced.push(`${describePredicate(old)} → ${describePredicate(p)}`);
    next.set(slotOf(p), merged);
  }
  return { held: [...next.values()], replaced, retired };
}

/** Drop held predicates the person explicitly released, by slot or label. */
export function release(held: readonly Predicate[], names: readonly string[]): { held: Predicate[]; released: string[]; unknown: string[] } {
  const released: string[] = [], hit = new Set<string>();
  const kept = held.filter(p => {
    const name = names.find(n => n === slotOf(p) || n === describePredicate(p) || n === p.p);
    if (name) { released.push(describePredicate(p)); hit.add(name); }
    return !name;
  });
  return { held: kept, released, unknown: names.filter(n => !hit.has(n)) };
}

/** The camera's predicates go when the person takes the camera; the clock's when they move time. */
export const retireDomain = (held: readonly Predicate[], domain: 'camera' | 'time') =>
  held.filter(p => domain === 'camera' ? !isViewPredicate(p) : !['clock', 'playing', 'rate'].includes(slotOf(p)));

// ── Evaluation ──

const check = (p: Predicate, ok: boolean | null, detail: string): GoalCheck => ({ slot: slotOf(p), ok, detail, soft: SOFT.has(p.p) });
const round = (v: number) => Math.round(v * 1000) / 1000;
/** Smallest centre-to-edge size, in vertical NDC, that reads as an object rather than a dot. */
const LEGIBLE_NDC = 0.005;
/** Results come 100 to a page; a search can return hundreds (Cassini–Mimas: 484), and the selected one may be on any page. */
export const EVENT_PAGE = 100, EVENT_PAGES = 50;

export function summarize(checks: readonly GoalCheck[]): GoalReport {
  const hard = checks.filter(c => !c.soft), soft = checks.filter(c => c.soft);
  const status: GoalStatus = hard.some(c => c.ok === false) ? 'unmet' : hard.some(c => c.ok === null) ? 'inconclusive'
    : soft.every(c => c.ok === true) ? 'met' : 'partial';
  return { status, checks };
}

/** `a.b[id=x].c`: object keys and `[key=value]` array selectors. */
export function valueAt(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let v = value;
  for (const part of path.match(/[^.[\]]+|\[[^\]]+\]/g) ?? []) {
    if (v === null || v === undefined) return undefined;
    const sel = /^\[([^=]+)=(.*)\]$/.exec(part);
    if (sel) v = Array.isArray(v) ? v.find(x => x && String((x as Record<string, unknown>)[sel[1]]) === sel[2]) : undefined;
    else v = (v as Record<string, unknown>)[part];
  }
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const contains = (actual: unknown, wanted: unknown): boolean => wanted !== null && typeof wanted === 'object' && !Array.isArray(wanted)
  ? actual !== null && typeof actual === 'object' && Object.entries(wanted).every(([k, v]) => contains((actual as Record<string, unknown>)[k], v))
  : same(actual, wanted);

export interface EvaluateOptions {
  /** ViewerControl methods a `state` predicate may call: registered reads only. */
  readonly reads?: ReadonlySet<string>;
}

/** One computed result by ID, on whichever page it sits. */
export function findEventResult(host: ViewerControl, query: string, id: string) {
  if (!host.listEventResults) return undefined;
  for (let offset = 0, page = 0; page < EVENT_PAGES; page++, offset += EVENT_PAGE) {
    let r: ReturnType<NonNullable<ViewerControl['listEventResults']>>;
    try { r = host.listEventResults(query, { offset, limit: EVENT_PAGE }); } catch { return undefined; }
    if (!r) return undefined;
    const found = r.items.find(e => e.id === id);
    if (found || offset + EVENT_PAGE >= r.total || !r.items.length) return found;
  }
  return undefined;
}

/** Whether a computed closest approach is an encounter, by the shared criterion; null when unclassifiable. */
export function encounterOf(host: ViewerControl, query: string, id: string) {
  const event = findEventResult(host, query, id);
  if (!event?.bodies.target) return null;
  let max: number | undefined;
  try { max = host.getEventQueryInfo?.(query).definition?.query.params?.maxRangeKm as number | undefined; } catch { max = undefined; }
  return classifyApproach([event.bodies.observer, event.bodies.target], event.metrics?.find(m => m.key === 'range')?.value, max);
}

/**
 * What a write would contradict before it runs: a result the person required
 * to be the closest, or a real encounter, judged on the result itself. Null
 * when nothing held speaks to it. This is how an intent stated before acting
 * stops a wrong action instead of reporting it afterwards.
 */
export function preconditionProblem(host: ViewerControl, expected: readonly Predicate[], held: readonly Predicate[]): string | null {
  for (const e of expected) {
    if (e.p !== 'eventSelected' || !e.id || !e.query) continue;
    const want = held.find(h => h.p === 'eventSelected' && h.query === e.query);
    if (!want) continue;
    if (want.encounter) {
      const c = encounterOf(host, e.query, e.id);
      if (c?.encounter === false) return `the person asked for an encounter, and result ${e.id} is not one: ${c.basis}`;
    }
    if (want.pick === 'closest' && host.getEventResultPage) {
      let best: string | undefined;
      try { best = host.getEventResultPage(e.query, { order: 'range-ascending', limit: 1 }).items[0]?.reference.id; } catch { best = undefined; }
      if (best && best !== e.id) return `the person asked for the closest result, which is ${best}, not ${e.id}`;
    }
  }
  return null;
}

/** Evaluate an AND of predicates against the viewer. Never throws: an unreadable fact is `null`. */
export function evaluate(host: ViewerControl, predicates: readonly Predicate[], opts: EvaluateOptions = {}): GoalReport {
  const h = host as unknown as Record<string, (...a: unknown[]) => unknown>;
  const try_ = <T>(read: () => T): T | undefined => { try { return read(); } catch { return undefined; } };
  // One composition read for every camera predicate.
  const viewObjects = [...new Set(predicates.filter(p => ['inView', 'legible', 'range'].includes(p.p)).map(p => p.object as string))];
  const view = viewObjects.length && host.getViewComposition ? try_(() => host.getViewComposition!(viewObjects)) : undefined;
  const composed = (name: string) => view?.objects.find(o => o.object === name);
  const tanHalf = view ? Math.tan(view.fovDeg * Math.PI / 360) : 1;
  const viz = predicates.some(p => p.p.startsWith('event')) && host.getEventVisualization ? try_(() => host.getEventVisualization!()) : undefined;
  const eventOf = (query: string, id: string) => findEventResult(host, query, id);
  const selectedOf = (query: string) => viz?.selected?.query === query ? viz.selected : null;
  const projection = (object: string, policy: Predicate['policy'] = 'rendered') => try_(() => host.projectGroundPoint?.(object, policy));

  const checks = predicates.map((p): GoalCheck => {
    switch (p.p) {
      case 'selected': { const now = try_(() => host.getSelected()); return check(p, now === undefined ? null : now === p.object, `selected ${now ?? 'nothing'}`); }
      case 'tracked': { const now = try_(() => host.getTracked()); return check(p, now === undefined ? null : now === p.object, `tracking ${now ?? 'nothing'}`); }
      case 'inView': case 'legible': case 'range': {
        if (!host.getViewComposition) return check(p, null, 'this viewer cannot observe composition');
        const o = composed(p.object as string);
        if (!o || !o.available) return check(p, o ? false : null, `${p.object} not in scene`);
        if (p.p === 'inView') {
          const shown = o.inView && o.drawEnabled && o.occlusion?.kind !== 'full';
          return check(p, shown, !o.drawEnabled ? `${p.object} is hidden` : !o.inView ? `${p.object} out of frame`
            : o.occlusion ? `${p.object} in frame, ${o.occlusion.kind === 'full' ? 'hidden' : 'partly hidden'} behind ${o.occlusion.by}` : `${p.object} in frame`);
        }
        if (p.p === 'legible') {
          const size = o.angularRadiusDeg === null ? null : Math.tan(o.angularRadiusDeg * Math.PI / 180) / tanHalf;
          return check(p, size === null ? null : size >= LEGIBLE_NDC, size === null ? `${p.object} size unknown` : size >= LEGIBLE_NDC ? `${p.object} drawn at a visible size` : `${p.object} is only a few pixels across`);
        }
        const r = o.rangeKm;
        const ok = r === null ? null : (p.maxKm === undefined || r <= p.maxKm) && (p.minKm === undefined || r >= p.minKm);
        return check(p, ok, `${p.object} at ${r === null ? 'unknown' : round(r)} km${p.maxKm !== undefined ? ` (limit ${p.maxKm})` : ''}${p.minKm !== undefined ? ` (at least ${p.minKm})` : ''}`);
      }
      case 'epoch': {
        const target = p.et ?? try_(() => etFromCalendarString(p.utc!));
        const now = try_(() => host.getTime()), playing = try_(() => host.isPlaying());
        if (target === undefined || !Number.isFinite(target)) return check(p, null, `cannot read the time ${JSON.stringify(p.utc)}`);
        if (now === undefined) return check(p, null, 'clock unreadable');
        // A running clock has moved on from any moment set; only a paused one holds it.
        if (playing) return check(p, Math.abs(now - target) < 1 ? true : null, 'the clock is running, so no moment is held');
        return check(p, Math.abs(now - target) < 1e-3 || (p.utc !== undefined && Math.abs(now - target) < 0.5), `ET ${round(now)}`);
      }
      case 'paused': { const playing = try_(() => host.isPlaying()); return check(p, playing === undefined ? null : playing === !p.value, playing ? 'playing' : 'paused'); }
      case 'rate': { const r = try_(() => host.getRate()); return check(p, r === undefined ? null : r === p.value, `rate ${r}`); }
      case 'activity': {
        if (!host.getSelectedActivity) return check(p, null, 'activity selection unobservable');
        const a = try_(() => host.getSelectedActivity!()); return check(p, (a?.id ?? null) === p.id, `activity ${a?.id ?? 'none'} selected`);
      }
      case 'place': {
        if (!host.getSelectedPlace) return check(p, null, 'place selection unobservable');
        const a = try_(() => host.getSelectedPlace!()); return check(p, (a?.ref ?? null) === p.id, `place ${a?.name ?? 'none'} selected`);
      }
      case 'eventQuery': {
        const info = host.getEventQueryInfo ? try_(() => host.getEventQueryInfo!(p.query!)) : undefined;
        return check(p, info === undefined ? null : info.definition !== null, info?.definition ? `search ${p.query} saved (${info.status})` : `no search ${p.query}`);
      }
      case 'eventRun': {
        // This query's own results, not whichever search ran last: running another search does not undo this one.
        const page = host.getEventResultPage ? try_(() => host.getEventResultPage!(p.query!, { limit: 1 })) : undefined;
        if (!page) return check(p, null, 'event search unobservable');
        const ok = ['ready', 'no-results'].includes(page.status);
        return check(p, ok, ok ? `search ${p.query} complete, ${page.total} results` : `search ${p.query} ${page.status}`);
      }
      case 'eventSelected': {
        if (!viz) return check(p, null, 'this viewer cannot observe events');
        const sel = selectedOf(p.query!);
        if (!sel) return check(p, false, 'no result of this search is selected');
        if (p.id && sel.id !== p.id) return check(p, false, `result ${sel.id} selected, not ${p.id}`);
        const notes: string[] = [`result ${sel.id} selected`];
        let ok: boolean | null = true;
        if (p.pick === 'closest') {
          const best = host.getEventResultPage ? try_(() => host.getEventResultPage!(p.query!, { order: 'range-ascending', limit: 1 }).items[0]) : undefined;
          if (!best) ok = null, notes.push('no ranked result');
          else if (best.reference.id !== sel.id) ok = false, notes.push(`closest is ${best.reference.id}`);
        }
        if (p.encounter) {
          const c = encounterOf(host, p.query!, sel.id);
          if (!c || c.encounter === null) { if (ok) ok = null; notes.push(c ? c.basis : 'encounter unclassifiable'); }
          else if (!c.encounter) { ok = false; notes.push(c.basis); }
        }
        return check(p, ok, notes.join('; '));
      }
      case 'eventEpoch': {
        const sel = selectedOf(p.query!);
        const event = sel ? eventOf(p.query!, sel.id) : undefined;
        const et = viz?.et;
        const inside = event && et !== undefined ? event.temporality === 'instant' ? Math.abs(et - event.et) <= 1 : et >= event.start - 1 && et <= event.end + 1 : null;
        return check(p, inside, inside === null ? 'event epoch unavailable' : inside ? 'clock at the event' : 'clock away from the event');
      }
      case 'eventFramed': {
        const sel = selectedOf(p.query!);
        const event = sel ? eventOf(p.query!, sel.id) : undefined;
        // Framing must be of this result's own participants, not of whatever the view held before.
        const all = event ? [...new Set([event.bodies.observer, event.bodies.target].filter((b): b is string => !!b))] : [];
        const expected = p.framing === 'target' && event?.bodies.target ? [event.bodies.target] : all;
        const people = viz?.presentation?.participants ?? [];
        const framed = expected.length && people.length ? expected.every(b => people.some(x => x.object === b && x.inView && x.drawEnabled)) : null;
        return check(p, framed, !people.length ? 'no participant projection' : expected.map(b => `${b} ${people.some(x => x.object === b && x.inView) ? 'in' : 'out of'} view`).join(', '));
      }
      case 'eventDrawn': {
        const sel = selectedOf(p.query!), drawn = viz?.renderer?.selected;
        return check(p, !!viz && viz.status === 'observed' && !!sel && drawn?.query === sel.query && drawn.id === sel.id, `event drawing ${viz?.status ?? 'unobservable'}${drawn && sel && drawn.id !== sel.id ? ' (for another result)' : ''}`);
      }
      case 'probeUnder': {
        const proj = projection(p.object as string, p.policy);
        const body = proj?.status === 'available' ? proj.body : null;
        if (!body) return check(p, null, `no ground projection for ${p.object}: ${proj?.reason ?? 'unsupported'}`);
        const pin = host.getProbePoint ? try_(() => host.getProbePoint!()) ?? null : null;
        if (!pin) return check(p, false, 'no pin');
        if (pin.point.bodyName !== body) return check(p, false, `pin on ${pin.point.bodyName}, ${p.object} is over ${body}`);
        if (!proj!.point || pin.placedEt === null || Math.abs(pin.placedEt - proj!.et) >= 1) return check(p, null, `pin on ${body}; placed at another epoch, position not compared`);
        const gap = Math.hypot(...pin.point.bodyFixedPositionKm.map((v, i) => v - proj!.point!.bodyFixedPositionKm[i]));
        return check(p, gap < 0.05, `pin on ${body}, ${round(gap)} km from ${p.object}'s sub-point`);
      }
      case 'probeDrawn': { const pin = host.getProbePoint ? try_(() => host.getProbePoint!()) : undefined; return check(p, pin?.drawn ?? false, pin?.drawn ? 'pin drawn' : 'pin drawing not observed'); }
      case 'featureSelected': {
        if (!host.getSelectedGeographicFeature) return check(p, null, 'feature selection unobservable');
        const sel = try_(() => host.getSelectedGeographicFeature!()) ?? null;
        const ok = !!sel && (!p.layer || sel.layer === p.layer) && (!p.feature || sel.feature === p.feature);
        return check(p, ok, sel ? `feature ${sel.feature} on ${sel.layer} selected` : 'no saved feature selected');
      }
      case 'featureUnder': {
        // The selected saved point must be where the vehicle is, on its body, in the layer's own convention.
        const proj = projection(p.object as string);
        const body = proj?.status === 'available' ? proj.body : null;
        const sel = host.getSelectedGeographicFeature ? try_(() => host.getSelectedGeographicFeature!()) ?? null : null;
        if (!sel) return check(p, false, 'no saved feature selected');
        const layer = host.listGeographicLayers ? try_(() => host.listGeographicLayers!().find(l => l.id === sel.layer)) : undefined;
        if (layer && body && layer.body !== body) return check(p, false, `saved point on ${layer.body}, ${p.object} is over ${body}`);
        const feature = host.listGeographicFeatures ? try_(() => host.listGeographicFeatures!(sel.layer, { limit: 100 })?.features.find(f => f.id === sel.feature)) : undefined;
        if (feature && feature.type !== 'Point') return check(p, false, `saved feature is a ${feature.type}, not a point`);
        const target = proj?.annotation?.position;
        if (!feature?.point || !target || !layer) return check(p, null, !feature ? 'saved feature unreadable' : 'coordinates unavailable');
        const lat = feature.point[1] * Math.PI / 180;
        const off = Math.hypot(feature.point[1] - target[1], ((feature.point[0] - target[0] + 540) % 360 - 180) * Math.cos(lat));
        // A point in a hidden layer is not on screen: not success.
        return check(p, off < 1e-3 && layer.visible, `saved point ${round(off)}° from ${p.object}'s sub-point${layer.visible ? '' : '; its layer is hidden'}`);
      }
      case 'state': {
        if (!opts.reads?.has(p.read!) || typeof h[p.read!] !== 'function') return check(p, null, `${p.read} is not a registered read on this viewer`);
        let read: { value: unknown } | undefined;
        try { read = { value: h[p.read!].apply(host, [...(p.args ?? [])]) }; } catch { read = undefined; }
        // A path that leads nowhere reads as null (absent), so "removed" is `equals: null`.
        const value = read ? valueAt(read.value, p.path) ?? null : undefined;
        const near = typeof p.within === 'number' && typeof value === 'number' && typeof p.equals === 'number' ? Math.abs(value - p.equals) <= p.within : null;
        return check(p, value === undefined ? null : near ?? (p.subset ? contains(value, p.equals) : same(value, p.equals)), `${p.read}${p.path ? ` ${p.path}` : ''} is ${value === undefined ? 'unreadable' : value === null ? 'absent' : JSON.stringify(value)?.slice(0, 120)}`);
      }
      case 'ready': {
        if (!host.getReadiness) return check(p, null, 'readiness unobservable');
        const r = try_(() => host.getReadiness!({ kind: p.kind!, ...(p.body ? { body: p.body } : {}), ...(p.layer ? { layer: p.layer } : {}) } as Parameters<NonNullable<ViewerControl['getReadiness']>>[0]));
        return check(p, r ? r.status === 'ready' : null, `${p.kind}${p.body ? ` on ${p.body}` : ''} ${r?.status ?? 'unobservable'}`);
      }
    }
  });
  return summarize(checks);
}
