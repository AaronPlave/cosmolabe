import type { TrajectoryAnalysisOptions, TrajectoryAnalysisSource, TrajectoryExtremaQuery, TrajectoryExtremaResponse, TrajectoryExtremum } from '@cosmolabe/interop';
import type { MissionActivity } from '../MissionActivity.js';
import type { Universe } from '../Universe.js';
import type { Trajectory } from '../trajectories/Trajectory.js';
import { CompositeTrajectory } from '../trajectories/CompositeTrajectory.js';
import { WaypointTrajectory } from '../trajectories/WaypointTrajectory.js';
import { SpiceTrajectory } from '../trajectories/SpiceTrajectory.js';
import { bodyFixedToGeodetic } from '../geographic/coordinates.js';
import { etToDate } from '../time.js';
import type { InstantEvent } from './events/types.js';
export type { TrajectoryHeightMetric, TrajectoryExtremaQuery, TrajectoryExtremum, TrajectoryExtremaResponse, TrajectoryAnalysisOptions } from '@cosmolabe/interop';
type Window = {
  start: number;
  end: number;
};
export interface TrajectoryAnalysisProvider {
  activities: readonly MissionActivity[];
  /** Changes only when authoritative inputs change, never for cache residency. */
  revision(): unknown;
  source(object: string, et: number): TrajectoryAnalysisSource;
  /** Undefined means unknown, NOT unlimited known coverage. State probes still apply. */
  coverage?(object: string): readonly Window[] | undefined;
  knots?(object: string, window: Window): readonly number[];
  /** Declared source period, when known; never inferred from mission activities. */
  period?(object: string): number | undefined;
  position(object: string, et: number, body: string, frame: string): readonly [
    number,
    number,
    number
  ] | null;
  /** Physical source height, in the exact requested reference datum/frame. No fallback. */
  terrain?(position: readonly [
    number,
    number,
    number
  ], query: TrajectoryExtremaQuery, options: TrajectoryAnalysisOptions): Promise<{
    heightKm: number;
    sourceUncertaintyKm: number | null;
  } | null>;
  /** Host yields to input/progress without making the algorithm depend on timers. */
  yield?(): Promise<void>;
}
function validFields(q: TrajectoryExtremaQuery): boolean {
  const ref = q?.reference;
  const radii = ref?.kind === 'sphere' ? [ref.radiusKm] : ref?.kind === 'ellipsoid' ? ref.radiiKm : [];
  const intervals = q?.scope?.kind === 'windows' ? q.scope.windows : [];
  return !!q && Array.isArray(q.objects) && q.objects.length > 0 && q.objects.length <= 32 && new Set(q.objects).size === q.objects.length && q.objects.every(s => typeof s === 'string' && s.length > 0)
    && typeof q.body === 'string' && !!q.body && typeof q.frame === 'string' && !!q.frame
    && ['radialHeightAboveReferenceSphere', 'heightAboveReferenceEllipsoid', 'heightAbovePhysicalTerrain'].includes(q.metric)
    && ['maximum', 'minimum'].includes(q.extremum) && radii.length > 0 && radii.every(r => Number.isFinite(r) && r > 0)
    && (ref.kind !== 'ellipsoid' || (radii.length === 3 && radii[0] === radii[1] && radii[2] <= radii[0]))
    && (q.metric !== 'radialHeightAboveReferenceSphere' || ref.kind === 'sphere')
    && (q.metric !== 'heightAboveReferenceEllipsoid' || ref.kind === 'ellipsoid')
    && Number.isFinite(q.stepSeconds) && q.stepSeconds > 0 && Number.isFinite(q.timeToleranceSeconds) && q.timeToleranceSeconds > 0 && q.timeToleranceSeconds <= q.stepSeconds
    && (q.sampling === undefined || q.sampling === 'adaptive' || q.sampling === 'fixed')
    && (q.maxEvaluations === undefined || (Number.isInteger(q.maxEvaluations) && q.maxEvaluations >= 1 && q.maxEvaluations <= 200000))
    && (q.scope?.kind === 'activities' || (q.scope?.kind === 'windows' && Array.isArray(intervals) && intervals.length > 0 && intervals.length <= 128 && intervals.every(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start <= w.end)))
    && (q.scope.kind !== 'activities' || ((!q.scope.ids || (Array.isArray(q.scope.ids) && q.scope.ids.length <= 128 && q.scope.ids.every(id => typeof id === 'string'))) && (!q.scope.window || Number.isFinite(q.scope.window.start) && Number.isFinite(q.scope.window.end) && q.scope.window.start <= q.scope.window.end)))
    && (q.metric !== 'heightAbovePhysicalTerrain' || (!!q.terrain?.id && !!q.terrain?.revision));
}
function valid(q: TrajectoryExtremaQuery): boolean {
  try {
    return validFields(q);
  }
  catch {
    return false;
  }
}
export function validateTrajectoryExtremaQuery(query: unknown): import('@cosmolabe/interop').TrajectoryAnalysisFault | undefined {
  return valid(query as TrajectoryExtremaQuery) ? undefined : { code: 'invalid-query', message: 'Explicit compatible metric/datum, frame, objects, scope and positive bounded sampling parameters required.' };
}
/** Abandon this consumer's wait without cancelling a source request shared by
 * other terrain consumers. Late source completion cannot publish a result. */
function cancellableTerrain<T>(work: Promise<T>, signal: TrajectoryAnalysisOptions['signal']): Promise<T | null> {
  if (!signal?.addEventListener)
    return work;
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener?.('abort', stop); resolve(null); };
    signal.addEventListener!('abort', stop);
    work.then(value => { signal.removeEventListener?.('abort', stop); resolve(value); }, error => { signal.removeEventListener?.('abort', stop); reject(error); });
    if (signal.aborted)
      stop();
  });
}
/** Deterministic bounded search. Local refinement is not a proof of a global extremum.
 * Every value comes from the trajectory/physical source ports, never authored targets. */
export async function findTrajectoryExtrema(q: TrajectoryExtremaQuery, provider: TrajectoryAnalysisProvider, options: TrajectoryAnalysisOptions = {}): Promise<TrajectoryExtremaResponse> {
  const faults: TrajectoryExtremaResponse['faults'] = [];
  const results: TrajectoryExtremum[] = [];
  const response = (status: TrajectoryExtremaResponse['status']): TrajectoryExtremaResponse => ({ status, results, faults });
  const invalid = validateTrajectoryExtremaQuery(q);
  if (invalid) {
    faults.push(invalid);
    return response('unavailable');
  }
  const revision = provider.revision();
  const interrupted = () => options.signal?.aborted ? 'cancelled' as const : provider.revision() !== revision ? 'stale' as const : null;
  const scope = q.scope;
  const jobs = q.objects.flatMap<{
    object: string;
    window: Window;
    activity: MissionActivity | undefined;
  }>(object => scope.kind === 'activities'
    ? provider.activities.filter(a => a.enabled !== false && a.vehicle === object && a.body === q.body && (!scope.ids || scope.ids.includes(a.id)) && (!scope.activityKind || a.kind === scope.activityKind) && (!scope.window || a.start <= scope.window.end && a.end >= scope.window.start)).map(a => ({ object, window: { start: Math.max(a.start, scope.window?.start ?? a.start), end: Math.min(a.end, scope.window?.end ?? a.end) }, activity: a }))
    : scope.windows.map(window => ({ object, window, activity: undefined })));
  if (!jobs.length || jobs.length > 128) {
    faults.push({ code: 'unavailable', message: 'No matching catalog intervals, or more than 128 intervals requested. Narrow the scope.' });
    return response('unavailable');
  }
  if (jobs.some(job => !Number.isFinite(etToDate(job.window.start).getTime()) || !Number.isFinite(etToDate(job.window.end).getTime()))) {
    faults.push({ code: 'invalid-query', message: 'Search epochs must be representable as UTC dates.' });
    return response('unavailable');
  }
  for (const object of q.objects)
    if (!jobs.some(j => j.object === object))
      faults.push({ code: 'unavailable', object, message: 'No matching catalog activity intervals for this object.' });
  let evaluations = 0;
  let furthest = 0;
  const report = (fraction: number) => { furthest = Math.max(furthest, Math.min(1, fraction)); options.onProgress?.(furthest); };
  const maximum = q.maxEvaluations ?? 200000;
  const direction = q.extremum === 'maximum' ? 1 : -1;
  for (const [index, job] of jobs.entries()) {
    const stopped = interrupted();
    if (stopped) {
      results.length = 0;
      faults.push({ code: stopped, message: 'Analysis cancelled or its authoritative inputs changed.' });
      return response(stopped);
    }
    const { object, window, activity } = job;
    let missing = false, budget = false;
    const coverage = provider.coverage?.(object);
    const pieces = coverage ? coverage.map(w => ({ start: Math.max(w.start, window.start), end: Math.min(w.end, window.end) })).filter(w => w.start <= w.end).sort((a, b) => a.start - b.start) : [window];
    if (coverage) {
      let edge = window.start;
      for (const piece of pieces) {
        if (piece.start > edge)
          missing = true;
        edge = Math.max(edge, piece.end);
      }
      if (!pieces.length || edge < window.end)
        missing = true;
    }
    type Sample = {
      et: number;
      value: number;
      position: readonly [
        number,
        number,
        number
      ];
      uncertainty: number | null;
    };
    let best: Sample | undefined;
    const cache = new Map<number, Sample | null>();
    const evaluate = async (et: number): Promise<Sample | null> => {
      if (cache.has(et))
        return cache.get(et)!;
      if (interrupted())
        return null;
      if (evaluations >= maximum) {
        budget = true;
        return null;
      }
      evaluations++;
      if (evaluations % 256 === 0) {
        await provider.yield?.();
        report((index + (et - window.start) / Math.max(1, window.end - window.start)) / jobs.length);
      }
      let sample: Sample | null = null;
      try {
        const p = provider.position(object, et, q.body, q.frame);
        if (p && p.every(Number.isFinite) && Math.hypot(...p) > 0) {
          const radius = Math.hypot(...p);
          const referenceHeight = q.reference.kind === 'sphere' ? radius - q.reference.radiusKm
            : bodyFixedToGeodetic({ xKm: p[0], yKm: p[1], zKm: p[2] }, { referenceShape: { kind: 'ellipsoid', radiiKm: [...q.reference.radiiKm] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' }).heightKm!;
          const terrain = q.metric === 'heightAbovePhysicalTerrain' && provider.terrain ? await cancellableTerrain(provider.terrain(p, q, options), options.signal) : undefined;
          const value = q.metric === 'heightAbovePhysicalTerrain' ? terrain ? referenceHeight - terrain.heightKm : NaN : referenceHeight;
          if (Number.isFinite(value))
            sample = { et, value, position: p, uncertainty: terrain?.sourceUncertaintyKm ?? null };
        }
      }
      catch { /* Availability and conversion failures are data gaps, not invented samples. */ }
      if (!sample)
        missing = true;
      else if (!best || direction * (sample.value - best.value) > 0 || (sample.value === best.value && et < best.et))
        best = sample;
      cache.set(et, sample);
      return sample;
    };
    const before = evaluations;
    let actualStep = 0;
    for (const [pieceIndex, piece] of pieces.entries()) {
      const knots = [...new Set([piece.start, ...(provider.knots?.(object, piece) ?? []).filter(t => Number.isFinite(t) && t > piece.start && t < piece.end), piece.end])].sort((a, b) => a - b);
      const times = new Set<number>(knots);
      // Leave room for local refinement and later objects/coverage intervals.
      // Known interpolation boundaries always survive the adaptive grid. A
      // declared period asks for at least 32 samples/orbit when budget permits.
      const remaining = maximum - evaluations;
      const share = Math.max(4, Math.floor(remaining / (jobs.length - index) / (pieces.length - pieceIndex) / 2));
      const target = Math.max(4, Math.min(4096, share) - 4 * knots.length);
      const period = provider.period?.(object);
      const scaleStep = Math.min((piece.end - piece.start) / target, period && Number.isFinite(period) && period > 0 ? period / 32 : Infinity);
      const step = q.sampling === 'adaptive' ? Math.max(q.stepSeconds, scaleStep) : q.stepSeconds;
      let undersampled = false;
      for (let k = 1; k < knots.length; k++) {
        const a = knots[k - 1], b = knots[k];
        // Four subdivisions per interpolation segment detect interior spline peaks,
        // even when the requested regular step exceeds a whole segment.
        let n = Math.max(4, Math.ceil((b - a) / step));
        // An insufficient budget still yields useful candidates. Never reject
        // a long segment before evaluating any states, or silently coarsen a
        // fixed override and call it complete.
        if (times.size + n - 1 > remaining) {
          undersampled = true;
          n = Math.max(1, remaining - times.size + 1);
        }
        for (let j = 1; j < n; j++)
          times.add(a + (b - a) * j / n);
      }
      const sampled: (Sample | null)[] = [];
      let previousTime: number | undefined;
      for (const t of [...times].sort((a, b) => a - b)) {
        if (previousTime !== undefined) actualStep = Math.max(actualStep, t - previousTime);
        previousTime = t;
        sampled.push(await evaluate(t));
        if (budget || interrupted())
          break;
      }
      if (undersampled) budget = true;
      // Refine every bracketed local candidate, rather than only the largest knot.
      for (let k = 1; k < sampled.length - 1 && !budget && !interrupted(); k++) {
        const a = sampled[k - 1], m = sampled[k], b = sampled[k + 1];
        if (!a || !m || !b || direction * (m.value - a.value) < 0 || direction * (m.value - b.value) < 0 || (a.value === m.value && b.value === m.value))
          continue;
        let lo = a.et, hi = b.et;
        const ratio = (Math.sqrt(5) - 1) / 2;
        let x = hi - ratio * (hi - lo), y = lo + ratio * (hi - lo), sx = await evaluate(x), sy = await evaluate(y);
        for (let iteration = 0; iteration < 80 && hi - lo > q.timeToleranceSeconds && sx && sy && !budget && !interrupted(); iteration++) {
          if (direction * (sx.value - sy.value) > 0) {
            hi = y;
            y = x;
            sy = sx;
            x = hi - ratio * (hi - lo);
            sx = await evaluate(x);
          }
          else {
            lo = x;
            x = y;
            sx = sy;
            y = lo + ratio * (hi - lo);
            sy = await evaluate(y);
          }
        }
      }
    }
    if (missing || budget)
      faults.push({ code: budget ? 'budget' : 'unavailable', object, activityId: activity?.id, window, message: budget ? 'Evaluation budget exhausted; no global ranking is established.' : 'Some requested state, frame or finest physical terrain samples are unavailable.' });
    if (best) {
      const p = best.position;
      results.push({ id: `extremum:${index}`, object, activityId: activity?.id ?? null, activityName: activity?.name ?? null, body: q.body, frame: q.frame,
        metric: q.metric, extremum: q.extremum, value: best.value, units: 'km', et: best.et, utc: etToDate(best.et).toISOString(),
        location: { positionKm: [...p], latitudeDeg: Math.atan2(p[2], Math.hypot(p[0], p[1])) * 180 / Math.PI, longitudeDeg: Math.atan2(p[1], p[0]) * 180 / Math.PI, convention: 'planetocentric' },
        datum: q.reference, heightConvention: q.reference.kind === 'sphere' ? 'radial' : 'geodetic-normal', window, source: provider.source(object, best.et), terrain: q.metric === 'heightAbovePhysicalTerrain' ? { ...q.terrain!, sourceUncertaintyKm: best.uncertainty } : null,
        coverage: missing || budget ? 'partial' : 'sampled-complete', method: { guarantee: 'sampled-and-locally-refined', stepSeconds: actualStep, timeToleranceSeconds: q.timeToleranceSeconds, evaluations: evaluations - before, heightErrorBoundKm: null,
          limits: 'Endpoints and interpolation-segment subdivisions sampled; local brackets numerically refined. Narrow unsampled extrema or gaps may be missed. Time tolerance controls bracket width, not source accuracy or global height error.' } });
    }
    report((index + 1) / jobs.length);
  }
  const stopped = interrupted();
  if (stopped) {
    results.length = 0;
    faults.push({ code: stopped, message: 'Analysis cancelled or its authoritative inputs changed.' });
    return response(stopped);
  }
  results.sort((a, b) => direction * (b.value - a.value) || a.et - b.et || a.object.localeCompare(b.object));
  return response(results.length ? faults.length ? 'partial' : 'complete' : 'unavailable');
}
function arcs(trajectory: Trajectory): {
  trajectory: Trajectory;
  start: number;
  end: number;
}[] {
  // Catalog arcs explicitly declare WaypointTrajectory's clamped endpoint
  // state valid through their window (including UTC/TDB rounding at landing).
  return trajectory instanceof CompositeTrajectory ? trajectory.arcs.flatMap(a => a.trajectory instanceof WaypointTrajectory
    ? [{ trajectory: a.trajectory, start: a.startTime, end: a.endTime }]
    : arcs(a.trajectory).map(w => ({ ...w, start: Math.max(w.start, a.startTime), end: Math.min(w.end, a.endTime) })))
    : [{ trajectory, start: trajectory.startTime ?? -Infinity, end: trajectory.endTime ?? Infinity }];
}
/** Reuses Universe's coverage-aware state and required frame conversion for both
 * catalog interpolation and SPICE. Does not read render positions or move time. */
export function universeTrajectoryAnalysisProvider(universe: Universe, revision: () => unknown): TrajectoryAnalysisProvider {
  return {
    revision, activities: universe.activities.list(),
    source: (object, et) => {
      const b = universe.getBody(object), p = b?.surfaceTrajectory;
      const availability = b?.trajectory.availabilityAt?.(et);
      return { id: availability?.provenance?.id ?? availability?.sourceId ?? (p ? object : null), revision: availability?.provenance?.version ?? null,
        classification: p?.purpose === 'synthetic-demo' || availability?.classification === 'synthetic' ? 'synthetic' : 'unknown' };
    },
    coverage: object => {
      const b = universe.getBody(object);
      if (!b)
        return [];
      return arcs(b.trajectory).flatMap(arc => {
        let windows = [{ start: arc.start, end: arc.end }];
        if (arc.trajectory instanceof SpiceTrajectory && universe.spiceInstance) {
          try {
            const target = arc.trajectory.spiceTarget;
            const id = Number.isInteger(Number(target)) ? Number(target) : universe.spiceInstance.bodn2c(target);
            if (id != null)
              windows = universe.spiceInstance.spkcov(id).map(w => ({ start: Math.max(arc.start, w.start), end: Math.min(arc.end, w.end) }));
          }
          catch { /* Unknown coverage is still checked by each state probe. */ }
        }
        return windows.map(({ start, end }) => ({ start: Math.max(start, b.existsFrom ?? -Infinity), end: Math.min(end, b.existsUntil ?? Infinity) })).filter(w => w.start <= w.end);
      });
    },
    knots: (object, window) => { const b = universe.getBody(object); return b ? arcs(b.trajectory).flatMap(a => [a.start, a.end, ...(a.trajectory.samplingBreakpoints?.(window.start, window.end) ?? [])]).filter(t => t >= window.start && t <= window.end) : []; },
    period: object => universe.getBody(object)?.trajectory.period,
    position: (object, et, body, frame) => {
      const b = universe.getBody(object);
      if (!b || !arcs(b.trajectory).some(a => et >= a.start && et <= a.end))
        return null;
      if (universe.frames.get(frame)?.kind !== 'body-fixed')
        return null;
      return universe.stateIn(object, et, { center: body, frame }).position;
    },
  };
}
/** Existing event/timeline/3D consumers receive the same measured result. */
export function trajectoryExtremumEvent(result: TrajectoryExtremum, queryId: string): InstantEvent {
  const labels = { radialHeightAboveReferenceSphere: 'Radial sphere height', heightAboveReferenceEllipsoid: 'Ellipsoid height', heightAbovePhysicalTerrain: 'Physical terrain clearance' };
  return { id: result.id, queryId, kind: 'trajectory-extremum', temporality: 'instant', et: result.et, bodies: { observer: result.object, center: result.body }, primaryRole: 'observer',
    label: `${result.object}: ${result.activityName ?? result.extremum}`, metrics: [{ key: result.metric, label: labels[result.metric], value: result.value, unit: 'km', precision: 5 }], trajectoryAnalysis: result };
}
