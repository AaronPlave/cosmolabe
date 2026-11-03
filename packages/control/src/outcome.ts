/**
 * Outcome checks (#345): is the person's requested end state actually on
 * screen, judged from the viewer's own reads rather than from what a model
 * said or which calls returned ok.
 *
 * A goal is typed data — never code or a model-authored predicate. The same
 * checks serve three callers: Ask, which states the goal and checks it once
 * after acting; the deterministic tests; and the paid benchmark, whose goals
 * are written by the test, not by the model.
 *
 * `met` needs every check to pass. `partial` means the requested settings hold
 * but something only the renderer can confirm (drawing, data readiness) has
 * not been observed. Missing evidence is never success.
 */
import type { ScriptSurfaceAppearance, ViewerControl } from './contracts.js';

export type AskGoal =
  /** Anchor near the camera with other objects in view (the multi-turn close-up case). */
  | { readonly kind: 'camera-composition'; readonly anchor: string; readonly include: readonly string[]; readonly maxAnchorRangeKm?: number; readonly paused?: boolean; readonly et?: number }
  /** A computed encounter shown: selected, paused at its epoch, participants framed. */
  | { readonly kind: 'event-presentation'; readonly query: string; readonly pick?: 'closest' | 'selected' }
  /** Terrain coloured as asked, and the data to draw it present. */
  | { readonly kind: 'surface-appearance'; readonly body: string; readonly baseColor?: ScriptSurfaceAppearance['baseColor']; readonly palette?: ScriptSurfaceAppearance['palette'] }
  /** A transient pin, or a saved selected point, under a vehicle on the right body. */
  | { readonly kind: 'ground-point'; readonly object: string; readonly mode: 'pin' | 'saved' };

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

/** Rendering/readiness checks: their failure alone makes a goal `partial`, not `unmet`. */
const SOFT = new Set(['drawn', 'data-ready']);

function report(kind: AskGoal['kind'], checks: GoalCheck[]): GoalReport {
  const hard = checks.filter(c => !SOFT.has(c.name)), soft = checks.filter(c => SOFT.has(c.name));
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
  switch (g.kind) {
    case 'camera-composition':
      need(text('anchor'), 'camera-composition needs anchor');
      need(Array.isArray(g.include) && g.include.length > 0 && g.include.length <= 4 && g.include.every(n => typeof n === 'string'), 'camera-composition needs include: 1-4 object names');
      need(g.maxAnchorRangeKm === undefined || (typeof g.maxAnchorRangeKm === 'number' && g.maxAnchorRangeKm > 0), 'maxAnchorRangeKm must be positive');
      break;
    case 'event-presentation': need(text('query'), 'event-presentation needs query'); break;
    case 'surface-appearance': need(text('body'), 'surface-appearance needs body'); break;
    case 'ground-point': need(text('object') && (g.mode === 'pin' || g.mode === 'saved'), 'ground-point needs object and mode pin|saved'); break;
    default: throw new Error('kind must be camera-composition, event-presentation, surface-appearance or ground-point');
  }
  return g as unknown as AskGoal;
}

export function checkGoal(host: ViewerControl, goal: AskGoal): GoalReport {
  switch (goal.kind) {
    case 'camera-composition': {
      if (!host.getViewComposition) return report(goal.kind, [check('composition', null, 'this viewer cannot observe composition')]);
      const view = host.getViewComposition([goal.anchor, ...goal.include]);
      const [anchor, ...rest] = view.objects;
      const checks = [
        check('anchor-in-view', anchor.inView, anchor.available ? `${goal.anchor} centre ${anchor.inView ? 'in' : 'out of'} view` : `${goal.anchor} not in scene`),
        ...rest.map(o => check(`in-view:${o.object}`, o.available && o.inView && o.occlusion?.kind !== 'full',
          !o.available ? `${o.object} not in scene` : !o.inView ? `${o.object} out of frame` : o.occlusion ? `${o.object} in frame, ${o.occlusion.kind === 'full' ? 'hidden' : 'partly hidden'} behind ${o.occlusion.by}` : `${o.object} in frame`)),
      ];
      if (goal.maxAnchorRangeKm !== undefined) checks.push(check('anchor-range', anchor.rangeKm !== null && anchor.rangeKm <= goal.maxAnchorRangeKm, `${goal.anchor} at ${anchor.rangeKm === null ? 'unknown' : round(anchor.rangeKm)} km (limit ${goal.maxAnchorRangeKm})`));
      if (goal.paused !== undefined) checks.push(check('paused', view.playing === !goal.paused, view.playing ? 'playing' : 'paused'));
      if (goal.et !== undefined) checks.push(check('epoch', Math.abs(view.et - goal.et) < 1e-3, `ET ${round(view.et)}`));
      return report(goal.kind, checks);
    }
    case 'event-presentation': {
      if (!host.getEventVisualization || !host.listEventResults) return report(goal.kind, [check('event', null, 'this viewer cannot observe events')]);
      const v = host.getEventVisualization();
      const sel = v.selected?.query === goal.query ? v.selected : null;
      const checks = [check('selected', !!sel, sel ? `result ${sel.id} selected` : 'no result of this search is selected')];
      if (goal.pick === 'closest' && host.getEventResultPage) {
        const best = host.getEventResultPage(goal.query, { order: 'range-ascending', limit: 1 }).items[0];
        checks.push(check('closest', !!sel && !!best && best.reference.id === sel.id, best ? `closest is ${best.reference.id}` : 'no ranked result'));
      }
      const event = sel ? host.listEventResults(goal.query, { limit: 100 }).items.find(e => e.id === sel.id) : undefined;
      const inside = event ? event.temporality === 'instant' ? Math.abs(v.et - event.et) <= 1 : v.et >= event.start - 1 && v.et <= event.end + 1 : null;
      checks.push(check('epoch', inside, inside === null ? 'event epoch unavailable' : inside ? 'clock at the event' : 'clock away from the event'));
      checks.push(check('paused', !v.playing, v.playing ? 'playing' : 'paused'));
      const people = v.presentation?.participants ?? [];
      checks.push(check('framed', people.length ? people.every(p => p.inView && p.drawEnabled) : null, people.length ? people.map(p => `${p.object} ${p.inView ? 'in' : 'out of'} view`).join(', ') : 'no participant projection'));
      checks.push(check('drawn', v.status === 'observed', `event drawing ${v.status}`));
      return report(goal.kind, checks);
    }
    case 'surface-appearance': {
      const a = host.getSurfaceAppearance?.(goal.body);
      if (!a?.settings) return report(goal.kind, [check('appearance', a ? false : null, a?.unavailable ?? 'appearance unavailable')]);
      const s = a.settings;
      const checks: GoalCheck[] = [];
      if (goal.baseColor) checks.push(check('base-color', s.baseColor === goal.baseColor, `base colour ${s.baseColor}`));
      if (goal.palette) checks.push(check('palette', s.palette === goal.palette, `palette ${s.palette}`));
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
        checks.push(check('pin-body', pin ? pin.point.bodyName === body : false, pin ? `pin on ${pin.point.bodyName}` : 'no pin'));
        if (pin && projection?.point && pin.placedEt !== null && Math.abs(pin.placedEt - projection.et) < 1) {
          const gap = Math.hypot(...pin.point.bodyFixedPositionKm.map((v, i) => v - projection.point!.bodyFixedPositionKm[i]));
          checks.push(check('pin-under-object', gap < 0.05, `pin ${round(gap)} km from the sub-point`));
        } else checks.push(check('pin-under-object', null, 'pin was placed at another epoch; position not compared'));
        checks.push(check('drawn', pin?.drawn ?? false, pin?.drawn ? 'pin drawn' : 'pin drawing not observed'));
      } else {
        const sel = host.getSelectedGeographicFeature?.() ?? null;
        const layer = sel ? host.listGeographicLayers?.().find(l => l.id === sel.layer) : undefined;
        checks.push(check('saved-selected', !!sel, sel ? `feature ${sel.feature} selected` : 'no saved feature selected'));
        checks.push(check('layer-body', layer ? layer.body === body : null, layer ? `layer on ${layer.body}` : 'layer unknown'));
        checks.push(check('drawn', layer?.visible ?? false, layer?.visible ? 'layer visible' : 'layer hidden or unknown'));
      }
      return report(goal.kind, checks);
    }
  }
}
