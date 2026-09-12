import type { EventKind } from '../registry.js';
import type { InstantEvent } from '../types.js';
import { rangeAt, rangeMetric } from './range-metrics.js';

/** Parameters of a {@link closestApproachKind} search. */
export interface ClosestApproachParams {
  /**
   * `local` reports every local distance minimum in the window — each flyby of
   * a repeating encounter. `global` reports only the deepest one.
   */
  scope?: 'local' | 'global';
  /**
   * Discards approaches farther than this (km). Optional: a flyby search over
   * a long window is mostly distant minima, and this is how a caller says how
   * close counts as an encounter. Filtering needs a provider that can measure
   * range; against one that cannot, a search that asks for it fails rather
   * than silently returning unfiltered results.
   */
  maxRangeKm?: number;
}

/**
 * Closest approach between two bodies.
 *
 * The geometry is `gfdist`'s own distance-extremum search (`LOCMIN`/`ABSMIN`),
 * not a sampled minimum found in the UI: GF brackets and refines the extremum
 * itself, so the instant is as good as the ephemeris rather than as good as
 * the sampling. The step is the sampling interval GF brackets with — an
 * approach that begins and ends between two samples is missed — so it wants to
 * be shorter than the encounter, not shorter than the mission.
 *
 * `gfdist` returns *when*, never *how far*. The range at the approach — the
 * number the result is about — is one position lookup through the provider's
 * optional `range`, so events carry it whenever the provider can answer.
 */
export const closestApproachKind: EventKind<ClosestApproachParams> = {
  kind: 'closest-approach',
  label: 'Closest approach',
  description:
    'Moments when the target is nearer to the observer than at any time just before or after — one result per encounter.',
  temporality: 'instant',
  roles: [
    { role: 'observer', label: 'Observer' },
    { role: 'target', label: 'Target' },
  ],
  params: [
    {
      kind: 'choice',
      key: 'scope',
      label: 'Find',
      default: 'local',
      options: [
        { value: 'local', label: 'Every local minimum' },
        { value: 'global', label: 'Deepest approach only' },
      ],
      help: 'Local minima give one result per encounter; the deepest gives one result overall.',
    },
    {
      kind: 'number',
      key: 'maxRangeKm',
      label: 'Max range',
      unit: 'km',
      min: 0,
      required: false,
      help: 'Optional. Ignores approaches farther than this.',
    },
  ],
  primaryRole: 'target',
  // An hour brackets planetary and interplanetary encounters without making a
  // decade-long window expensive. Close-orbit work wants far less; that is the
  // caller's call, and `EventQuery.step` is how it is made.
  defaultStep: 3600,
  defaultAbcorr: 'NONE',

  validate: (query) => {
    const scope = query.params?.scope;
    if (scope !== undefined && scope !== 'local' && scope !== 'global') {
      return { code: 'invalid-params', message: 'Scope must be "local" or "global"' };
    }

    const max = query.params?.maxRangeKm;
    if (max !== undefined && (!Number.isFinite(max) || max <= 0)) {
      return { code: 'invalid-params', message: 'Max range must be a positive distance in km' };
    }

    return undefined;
  },

  run: async (query, ctx) => {
    const target = query.bodies.target!;
    const observer = query.bodies.observer!;
    const maxRangeKm = query.params?.maxRangeKm;

    if (maxRangeKm !== undefined && !ctx.provider.range) {
      throw new Error(
        'Closest approach: filtering by max range needs a provider that can measure range',
      );
    }

    const relate = query.params?.scope === 'global' ? 'ABSMIN' : 'LOCMIN';
    const found = await ctx.provider.gfdist(
      target,
      query.abcorr,
      observer,
      relate,
      // `refval` and `adjust` are unused by the extremum relations; adjust must
      // stay zero, since neither shipped provider carries a nonzero one.
      0,
      0,
      query.step,
      [query.window],
    );

    const events: InstantEvent[] = [];
    for (const window of found) {
      // GF reports an extremum as a degenerate interval. Taking the midpoint
      // rather than the start keeps the instant right if a provider ever widens
      // one, and is identical when it does not.
      const et = (window.start + window.end) / 2;
      const km = await rangeAt(ctx.provider, target, query.abcorr, observer, et);
      if (maxRangeKm !== undefined && km !== undefined && km > maxRangeKm) continue;

      events.push({
        id: ctx.nextEventId(),
        queryId: query.id,
        kind: query.kind,
        temporality: 'instant',
        et,
        bodies: { observer, target },
        label: query.label ?? `${target} closest approach from ${observer}`,
        ...(km === undefined ? {} : { metrics: [rangeMetric('range', 'Range', km)] }),
      });
    }

    return events;
  },
};
