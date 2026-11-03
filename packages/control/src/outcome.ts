/**
 * Outcome checks (#345): is the person's requested end state actually on
 * screen, judged from the viewer's own reads rather than from what a model
 * said or which calls returned ok.
 *
 * A goal is typed data — never code or a model-authored predicate. The same
 * checks serve three callers: Ask, which states the goal and checks it after
 * acting (and whose loop re-checks it itself before an answer stands); the
 * deterministic tests; and the paid benchmark, whose goals are written by the
 * test, not by the model.
 *
 * Each goal kind is a few small postconditions — visible, drawn, range,
 * epoch, paused, selected, style, readiness, position — so a new viewer
 * feature adds a check, not a framework.
 *
 * `met` needs every check to pass. `partial` means the requested state holds
 * but something only the renderer can confirm (drawing, data readiness,
 * legible size) has not been observed. Missing evidence is never success.
 */
import type { ScriptSurfaceAppearance, ViewerControl } from './contracts.js';

/** Constraint fields a later request may explicitly drop; anything else carries forward. */
export const RELEASABLE = ['include', 'maxAnchorRangeKm', 'paused', 'et', 'baseColor', 'palette', 'pick'] as const;
type Releasable = typeof RELEASABLE[number];

export type AskGoal = { readonly release?: readonly Releasable[] } & (
  /** Anchor near the camera with other objects in view (the multi-turn close-up case). */
  | { readonly kind: 'camera-composition'; readonly anchor: string; readonly include: readonly string[]; readonly maxAnchorRangeKm?: number; readonly paused?: boolean; readonly et?: number }
  /** A computed encounter shown: selected, paused at its epoch, participants framed. */
  | { readonly kind: 'event-presentation'; readonly query: string; readonly pick?: 'closest' | 'selected' }
  /** Terrain coloured as asked, and the data to draw it present. */
  | { readonly kind: 'surface-appearance'; readonly body: string; readonly baseColor?: ScriptSurfaceAppearance['baseColor']; readonly palette?: ScriptSurfaceAppearance['palette'] }
  /** A transient pin, or a saved selected point, under a vehicle on the right body. */
  | { readonly kind: 'ground-point'; readonly object: string; readonly mode: 'pin' | 'saved' });

export interface GoalCheck {
  readonly name: string;
  /** null: could not be observed (counts against `met`). */
  readonly ok: boolean | null;
  readonly detail: string;
}

export interface GoalReport {
  readonly kind: AskGoal['kind'];
  readonly status: 'met' | 'partial' | 'unmet' | 'inconclusive';
  readonly checks: readonly GoalCheck[];
}

const check = (name: string, ok: boolean | null, detail: string): GoalCheck => ({ name, ok, detail });
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Renderer-only checks: their failure alone makes a goal `partial`, not `unmet`. */
const SOFT = /^(drawn|data-ready|legible)/;

function report(kind: AskGoal['kind'], checks: GoalCheck[]): GoalReport {
  const hard = checks.filter(c => !SOFT.test(c.name)), soft = checks.filter(c => SOFT.test(c.name));
  const status = hard.some(c => c.ok === false) ? 'unmet' : hard.some(c => c.ok === null) ? 'inconclusive'
    : soft.every(c => c.ok === true) ? 'met' : 'partial';
  return { kind, status, checks };
}

const need = (cond: unknown, what: string) => { if (!cond) throw new Error(what); };

/** Validate a goal's shape; throws with the first problem. */
export function parseGoal(input: unknown): AskGoal {
  const g = input as Record<string, unknown>;
  need(g && typeof g === 'object', 'goal must be an object');
  const text = (k: string) => typeof g[k] === 'string' && (g[k] as string).length > 0;
  need(g.release === undefined || (Array.isArray(g.release) && g.release.every(r => (RELEASABLE as readonly unknown[]).includes(r))), `release lists constraint fields: ${RELEASABLE.join(', ')}`);
  switch (g.kind) {
    case 'camera-composition':
      need(text('anchor'), 'camera-composition needs anchor');
      need(Array.isArray(g.include) && g.include.length > 0 && g.include.length <= 4 && g.include.every(n => typeof n === 'string'), 'camera-composition needs include: 1-4 object names');
      need(g.maxAnchorRangeKm === undefined || (typeof g.maxAnchorRangeKm === 'number' && g.maxAnchorRangeKm > 0), 'maxAnchorRangeKm must be positive');
      break;
    case 'event-presentation': need(text('query'), 'event-presentation needs query'); break;
    case 'surface-appearance':
      need(text('body'), 'surface-appearance needs body');
      // Ready terrain alone is not "coloured as asked".
      need(g.baseColor !== undefined || g.palette !== undefined, 'surface-appearance needs baseColor or palette');
      break;
    case 'ground-point': need(text('object') && (g.mode === 'pin' || g.mode === 'saved'), 'ground-point needs object and mode pin|saved'); break;
    default: throw new Error('kind must be camera-composition, event-presentation, surface-appearance or ground-point');
  }
  return g as unknown as AskGoal;
}

/** What a goal is about: later goals with the same key inherit its constraints. */
export function goalKey(goal: AskGoal): string {
  switch (goal.kind) {
    case 'camera-composition': return `camera:${goal.anchor}`;
    case 'event-presentation': return `event:${goal.query}`;
    case 'surface-appearance': return `surface:${goal.body}`;
    case 'ground-point': return `ground:${goal.object}`;
  }
}

/**
 * The goal a request is held to: this request's goal plus every constraint an
 * earlier request on the same subject set, unless this one names it in
 * `release`. A model can add constraints; it cannot silently lose one.
 */
export function mergeGoal(previous: AskGoal | undefined, next: AskGoal): { goal: AskGoal; carried: string[] } {
  if (!previous || goalKey(previous) !== goalKey(next)) return { goal: next, carried: [] };
  const released = new Set<string>(next.release ?? []);
  const merged: Record<string, unknown> = { ...next };
  const carried: string[] = [];
  for (const [field, value] of Object.entries(previous)) {
    if (field === 'release' || released.has(field) || value === undefined) continue;
    const mine = merged[field];
    if (field === 'include' && Array.isArray(value)) {
      const union = [...new Set([...(mine as string[] ?? []), ...value as string[]])];
      if (union.length > (mine as string[] ?? []).length) carried.push(`include ${value.join(', ')}`);
      merged.include = union.slice(0, 4);
    } else if (field === 'maxAnchorRangeKm' && typeof value === 'number') {
      if (mine === undefined || (mine as number) > value) { merged[field] = value; carried.push(`maxAnchorRangeKm ${value}`); }
    } else if (mine === undefined) { merged[field] = value; carried.push(`${field} ${JSON.stringify(value)}`); }
  }
  delete merged.release;
  return { goal: merged as unknown as AskGoal, carried };
}

/** Smallest centre-to-edge size, in vertical NDC, that reads as an object rather than a dot. */
const LEGIBLE_NDC = 0.005;

export function checkGoal(host: ViewerControl, goal: AskGoal): GoalReport {
  switch (goal.kind) {
    case 'camera-composition': {
      if (!host.getViewComposition) return report(goal.kind, [check('composition', null, 'this viewer cannot observe composition')]);
      const view = host.getViewComposition([goal.anchor, ...goal.include]);
      const [anchor, ...rest] = view.objects;
      const tanHalf = Math.tan(view.fovDeg * Math.PI / 360);
      const checks = [check('visible:' + goal.anchor, anchor.available && anchor.inView && anchor.drawEnabled, anchor.available ? `${goal.anchor} ${anchor.inView ? 'in' : 'out of'} view` : `${goal.anchor} not in scene`)];
      for (const o of rest) {
        const shown = o.available && o.inView && o.drawEnabled && o.occlusion?.kind !== 'full';
        checks.push(check(`visible:${o.object}`, shown, !o.available ? `${o.object} not in scene` : !o.drawEnabled ? `${o.object} is hidden` : !o.inView ? `${o.object} out of frame`
          : o.occlusion ? `${o.object} in frame, ${o.occlusion.kind === 'full' ? 'hidden' : 'partly hidden'} behind ${o.occlusion.by}` : `${o.object} in frame`));
        if (shown) {
          const size = o.angularRadiusDeg === null ? null : Math.tan(o.angularRadiusDeg * Math.PI / 180) / tanHalf;
          checks.push(check(`legible:${o.object}`, size === null ? null : size >= LEGIBLE_NDC, size === null ? `${o.object} size unknown` : size >= LEGIBLE_NDC ? `${o.object} drawn at a visible size` : `${o.object} is only a few pixels across`));
        }
      }
      if (goal.maxAnchorRangeKm !== undefined) checks.push(check('range', anchor.rangeKm !== null && anchor.rangeKm <= goal.maxAnchorRangeKm, `${goal.anchor} at ${anchor.rangeKm === null ? 'unknown' : round(anchor.rangeKm)} km (limit ${goal.maxAnchorRangeKm})`));
      if (goal.paused !== undefined) checks.push(check('paused', view.playing === !goal.paused, view.playing ? 'playing' : 'paused'));
      if (goal.et !== undefined) checks.push(check('epoch', Math.abs(view.et - goal.et) < 1e-3, `ET ${round(view.et)}`));
      return report(goal.kind, checks);
    }
    case 'event-presentation': {
      if (!host.getEventVisualization || !host.listEventResults) return report(goal.kind, [check('event', null, 'this viewer cannot observe events')]);
      const v = host.getEventVisualization();
      const sel = v.selected?.query === goal.query ? v.selected : null;
      const checks = [check('selected', !!sel, sel ? `result ${sel.id} selected` : 'no result of this search is selected')];
      if (goal.pick === 'closest') {
        const best = host.getEventResultPage?.(goal.query, { order: 'range-ascending', limit: 1 }).items[0];
        checks.push(check('closest', best ? !!sel && best.reference.id === sel.id : null, best ? `closest is ${best.reference.id}` : 'no ranked result'));
      }
      const event = sel ? host.listEventResults(goal.query, { limit: 100 }).items.find(e => e.id === sel.id) : undefined;
      const inside = event ? event.temporality === 'instant' ? Math.abs(v.et - event.et) <= 1 : v.et >= event.start - 1 && v.et <= event.end + 1 : null;
      checks.push(check('epoch', inside, inside === null ? 'event epoch unavailable' : inside ? 'clock at the event' : 'clock away from the event'));
      checks.push(check('paused', !v.playing, v.playing ? 'playing' : 'paused'));
      // Framing must be of this result's own participants, not of whatever the view held before.
      const expected = event ? [...new Set([event.bodies.observer, event.bodies.target].filter((b): b is string => !!b))] : [];
      const people = v.presentation?.participants ?? [];
      const framed = expected.length && people.length ? expected.every(b => people.some(p => p.object === b && p.inView && p.drawEnabled)) : null;
      checks.push(check('framed', framed, !people.length ? 'no participant projection' : expected.map(b => `${b} ${people.some(p => p.object === b && p.inView) ? 'in' : 'out of'} view`).join(', ')));
      const drawnSel = v.renderer?.selected;
      checks.push(check('drawn', v.status === 'observed' && !!sel && drawnSel?.query === sel.query && drawnSel.id === sel.id, `event drawing ${v.status}${drawnSel && sel && drawnSel.id !== sel.id ? ' (for another result)' : ''}`));
      return report(goal.kind, checks);
    }
    case 'surface-appearance': {
      const a = host.getSurfaceAppearance?.(goal.body);
      if (!a?.settings) return report(goal.kind, [check('appearance', a ? false : null, a?.unavailable ?? 'appearance unavailable')]);
      const s = a.settings;
      const checks: GoalCheck[] = [];
      if (goal.baseColor) checks.push(check('style:baseColor', s.baseColor === goal.baseColor, `base colour ${s.baseColor}`));
      if (goal.palette) checks.push(check('style:palette', s.palette === goal.palette, `palette ${s.palette}`));
      if (!checks.length) checks.push(check('style', false, 'no appearance requested'));
      const ready = host.getReadiness?.({ kind: 'terrain', body: goal.body });
      checks.push(check('data-ready', ready ? ready.status === 'ready' : null, `terrain ${ready?.status ?? 'unobservable'}`));
      return report(goal.kind, checks);
    }
    case 'ground-point': {
      const projection = host.projectGroundPoint?.(goal.object, 'rendered');
      const body = projection?.status === 'available' ? projection.body : null;
      const checks = [check('projection', body !== null, body ? `${goal.object} is over ${body}` : `no ground projection: ${projection?.reason ?? 'unsupported'}`)];
      if (goal.mode === 'pin') {
        const pin = host.getProbePoint?.() ?? null;
        checks.push(check('body', pin ? pin.point.bodyName === body : false, pin ? `pin on ${pin.point.bodyName}` : 'no pin'));
        if (pin && projection?.point && pin.placedEt !== null && Math.abs(pin.placedEt - projection.et) < 1) {
          const gap = Math.hypot(...pin.point.bodyFixedPositionKm.map((v, i) => v - projection.point!.bodyFixedPositionKm[i]));
          checks.push(check('position', gap < 0.05, `pin ${round(gap)} km from the sub-point`));
        } else checks.push(check('position', null, 'pin was placed at another epoch; position not compared'));
        checks.push(check('drawn', pin?.drawn ?? false, pin?.drawn ? 'pin drawn' : 'pin drawing not observed'));
      } else {
        const sel = host.getSelectedGeographicFeature?.() ?? null;
        const layer = sel ? host.listGeographicLayers?.().find(l => l.id === sel.layer) : undefined;
        checks.push(check('selected', !!sel, sel ? `feature ${sel.feature} selected` : 'no saved feature selected'));
        checks.push(check('body', layer ? layer.body === body : null, layer ? `layer on ${layer.body}` : 'layer unknown'));
        // The saved point must actually be where the vehicle is, in the layer's own convention.
        const feature = sel ? host.listGeographicFeatures?.(sel.layer, { limit: 100 })?.features.find(f => f.id === sel.feature) : undefined;
        const target = projection?.annotation?.position;
        if (feature?.point && target) {
          const lat = feature.point[1] * Math.PI / 180;
          const off = Math.hypot(feature.point[1] - target[1], ((feature.point[0] - target[0] + 540) % 360 - 180) * Math.cos(lat));
          checks.push(check('position', off < 1e-3, `saved point ${round(off)}° from the sub-point`));
        } else checks.push(check('position', feature?.type === undefined ? null : feature.type === 'Point' ? null : false,
          !feature ? 'saved feature unreadable' : feature.type !== 'Point' ? `saved feature is a ${feature.type}, not a point` : 'coordinates unavailable'));
        checks.push(check('drawn', layer?.visible ?? false, layer?.visible ? 'layer visible' : 'layer hidden or unknown'));
      }
      return report(goal.kind, checks);
    }
  }
}
