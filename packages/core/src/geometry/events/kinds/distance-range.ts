import type { EventKind } from '../registry.js';
import type { GeometryEvent } from '../types.js';
import { rangeExtremum, rangeMetric } from './range-metrics.js';

/** Parameters of a {@link distanceRangeKind} search. */
export interface DistanceRangeParams {
  /** How the observer→target distance must compare to {@link distanceKm}. */
  relation?: '<' | '>' | '=';
  /** The distance compared against (km). */
  distanceKm?: number;
}

const RELATION_LABEL: Record<string, string> = {
  '<': 'within',
  '>': 'beyond',
  '=': 'at',
};

/**
 * Windows in which two bodies are closer than, farther than, or exactly at a
 * given distance — the "is it in range?" search, answered by `gfdist` directly.
 *
 * It yields both temporalities on purpose: `<` and `>` give spans, `=` gives
 * the instants the distance crosses the threshold, and the shared model already
 * carries the difference, so neither needs its own kind.
 *
 * A span's most useful number is not its endpoints — those sit on the threshold
 * by construction — but how far the distance went inside it. Each interval is
 * therefore annotated with its extreme range, one nested GF extremum search,
 * whenever the provider can measure range.
 */
export const distanceRangeKind: EventKind<DistanceRangeParams> = {
  kind: 'distance-range',
  label: 'Distance / range',
  description:
    'Stretches of time for which the observer→target distance stays on one side of a threshold. Each result is a window, and its duration is how long the condition held.',
  roles: [
    { role: 'observer', label: 'Observer' },
    { role: 'target', label: 'Target' },
  ],
  params: [
    {
      kind: 'choice',
      key: 'relation',
      label: 'Condition',
      default: '<',
      options: [
        { value: '<', label: 'Closer than' },
        { value: '>', label: 'Farther than' },
        { value: '=', label: 'Exactly' },
      ],
    },
    {
      kind: 'number',
      key: 'distanceKm',
      label: 'Distance',
      unit: 'km',
      default: 1_000_000,
      min: 0,
      help: 'Threshold the observer→target distance is compared against.',
    },
  ],
  primaryRole: 'target',
  defaultStep: 3600,
  defaultAbcorr: 'NONE',

  validate: (query) => {
    const relation = query.params?.relation;
    if (relation !== '<' && relation !== '>' && relation !== '=') {
      return { code: 'invalid-params', message: 'Condition must be one of "<", ">", "="' };
    }

    const distanceKm = query.params?.distanceKm;
    if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm <= 0) {
      return { code: 'invalid-params', message: 'Distance must be a positive number of km' };
    }

    return undefined;
  },

  run: async (query, ctx) => {
    const target = query.bodies.target!;
    const observer = query.bodies.observer!;
    const relation = query.params!.relation!;
    const distanceKm = query.params!.distanceKm!;

    const found = await ctx.provider.gfdist(
      target,
      query.abcorr,
      observer,
      relation,
      distanceKm,
      0,
      query.step,
      [query.window],
    );

    const threshold = rangeMetric('threshold', 'Threshold', distanceKm);
    const label =
      query.label ?? `${target} ${RELATION_LABEL[relation]} ${formatKm(distanceKm)} of ${observer}`;

    const events: GeometryEvent[] = [];
    for (const window of found) {
      const base = {
        id: ctx.nextEventId(),
        queryId: query.id,
        kind: query.kind,
        bodies: { observer, target },
        label,
      };

      if (window.end <= window.start) {
        // A threshold crossing, or a window GF could not widen: a point in time.
        events.push({ ...base, temporality: 'instant' as const, et: window.start, metrics: [threshold] });
        continue;
      }

      // Inside a `<` window the interesting number is how close it got; inside
      // a `>` window, how far it went. Either way it is the opposite extremum
      // from the one the threshold already tells you.
      const extremum = await rangeExtremum(
        ctx.provider,
        target,
        query.abcorr,
        observer,
        relation === '>' ? 'ABSMAX' : 'ABSMIN',
        query.step,
        window,
      );

      events.push({
        ...base,
        temporality: 'interval' as const,
        start: window.start,
        end: window.end,
        metrics: [
          threshold,
          { key: 'duration', label: 'Duration', value: window.end - window.start, unit: 's', precision: 0 },
          ...(extremum
            ? [rangeMetric(relation === '>' ? 'maxRange' : 'minRange',
                relation === '>' ? 'Max range' : 'Min range', extremum.km)]
            : []),
        ],
      });
    }

    return events;
  },
};

/** Compact km for a label; the UI formats metrics itself. */
function formatKm(km: number): string {
  if (km >= 1e6) return `${(km / 1e6).toPrecision(3)}M km`;
  if (km >= 1e3) return `${(km / 1e3).toPrecision(3)}k km`;
  return `${km} km`;
}
