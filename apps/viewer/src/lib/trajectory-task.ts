/** Resolve routine intent once, then use the existing numerical service. No solver here. */
import { universeTrajectoryAnalysisProvider, type Universe, type TrajectoryExtremaQuery } from '@cosmolabe/core';
import type { ScriptExtremaOptions, ScriptExtremaRequest, ScriptExtremaResult } from '@cosmolabe/control';

export const heightMetrics = {
  'reference-sphere-height': 'radialHeightAboveReferenceSphere',
  'reference-ellipsoid-height': 'heightAboveReferenceEllipsoid',
  'terrain-clearance': 'heightAbovePhysicalTerrain',
} as const;

/** Pure preflight also used by tests. Scope counts include every matching native activity,
 * never a model-paged inventory. Unknown coverage is checked by the solver, not invented. */
export function resolveExtremaTask(universe: Universe | null, request: ScriptExtremaRequest, options: ScriptExtremaOptions,
  reference: (body: string, metric: keyof typeof heightMetrics) => { reference: TrajectoryExtremaQuery['reference']; terrain?: TrajectoryExtremaQuery['terrain'] } | null): ScriptExtremaResult {
  const result: ScriptExtremaResult = { status: 'unavailable', reason: null, message: '', started: false, body:null, query: null,
    scope: { requested: 0, completed: 0, activityIds: [] }, options, response: null, winnerId: null, candidateId:null,
    coverage:{assessed:false,incompleteIntervals:0,maximumGapSeconds:0} };
  const fail = (reason: ScriptExtremaResult['reason'], message: string) => Object.assign(result, { reason, message });
  if (!universe || !request.objects.length || request.objects.length > 32 || new Set(request.objects).size !== request.objects.length || request.objects.some(n => !universe.getBody(n)))
    return fail('missing-subject', 'Choose existing distinct scene objects; no analysis ran.');
  const scope = request.scope;
  if (!scope || !['activities','windows'].includes(scope.kind)) return fail('invalid-scope', 'Choose activities or explicit windows.');
  if (scope.kind==='activities' && 'windows' in scope || scope.kind==='windows' && ['ids','activityKind','window'].some(k=>k in scope)) return fail('invalid-scope','Activity restrictions and explicit windows cannot be mixed.');
  if (scope.kind === 'windows' && (!Array.isArray(scope.windows) || !scope.windows.length || scope.windows.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start > w.end))
    || scope.kind === 'activities' && (scope.window && (!Number.isFinite(scope.window.start) || !Number.isFinite(scope.window.end) || scope.window.start > scope.window.end) || scope.ids && new Set(scope.ids).size !== scope.ids.length))
    return fail('invalid-scope', 'Provide ordered finite windows and distinct activity IDs.');
  const activities = universe.activities.list().filter(a => a.enabled !== false && request.objects.includes(a.vehicle)
    && (!request.body || a.body === request.body) && (scope.kind !== 'activities' || (!scope.activityKind || a.kind === scope.activityKind)
      && (!scope.ids || scope.ids.includes(a.id)) && (!scope.window || a.start <= scope.window.end && a.end >= scope.window.start)));
  if (scope.kind === 'activities' && (!activities.length || request.objects.some(n => !activities.some(a => a.vehicle === n)) || scope.ids?.some(id => !activities.some(a => a.id === id))))
    return fail('invalid-scope', 'No complete match for the requested enabled activities and subjects. No partial subset was silently selected.');
  const bodies = request.body ? [request.body] : scope.kind === 'activities' ? [...new Set(activities.map(a => a.body))]
    : [...new Set(request.objects.map(n => universe.getBody(n)?.parentName).filter((n): n is string => !!n))];
  if (bodies.length !== 1 || !universe.getBody(bodies[0])) return fail('ambiguous-body', 'Choose the central reference body; the subjects/scope do not identify one body.');
  const body = bodies[0], bodyOptions = options.bodies.find(b => b.body === body);
  result.body=body;
  result.scope = { requested: scope.kind === 'activities' ? activities.length : scope.windows.length * request.objects.length,
    completed: 0, activityIds: scope.kind === 'activities' ? activities.map(a => a.id).slice(0, 128) : [] };
  if (result.scope.requested > 128) return fail('work-budget', 'More than 128 intervals requested; narrow the scope explicitly.');
  if (request.metric === 'elevation') {
    if (!bodyOptions?.metrics.some(m=>m.available)) return fail('data-unavailable','No compatible declared height measurement is available for this subject/scope.');
    result.status = 'clarification';
    return fail('ambiguous-metric', 'Elevation can mean reference-surface height or physical terrain clearance (AGL). Which available metric do you mean? Ask one question with the available alternatives; do not substitute a datum.');
  }
  const choice = bodyOptions?.metrics.find(m => m.metric === request.metric);
  if (!choice?.available) return fail(request.metric==='terrain-clearance' && !/unsupported/i.test(choice?.reason??'') ? 'data-unavailable' : 'unsupported-metric', choice?.reason ?? 'This metric has no compatible declared datum/frame/source in this scene. This does not establish absent surface geometry.');
  const resolved = reference(body, request.metric);
  if (!resolved || !bodyOptions) return fail('unsupported-metric', 'No compatible declared reference/source.');
  const windows = scope.kind === 'activities' ? activities.map(a => ({ object: a.vehicle, start: Math.max(a.start, scope.window?.start ?? a.start), end: Math.min(a.end, scope.window?.end ?? a.end) }))
    : request.objects.flatMap(object => scope.windows.map(w => ({ object, ...w })));
  const provider = universeTrajectoryAnalysisProvider(universe, () => universe);
  result.coverage.assessed = true;
  for (const w of windows) {
    const intervals = provider.coverage?.(w.object);
    if (!intervals) { result.coverage.assessed = false; continue; }
    let edge = w.start, largest = 0;
    for (const piece of intervals.filter(p=>p.end>=w.start && p.start<=w.end).sort((a,b)=>a.start-b.start)) {
      largest = Math.max(largest, Math.max(0,piece.start-edge)); edge=Math.max(edge,Math.min(w.end,piece.end));
    }
    largest=Math.max(largest,w.end-edge);
    if (largest>0) result.coverage.incompleteIntervals++;
    result.coverage.maximumGapSeconds=Math.max(result.coverage.maximumGapSeconds,largest);
  }
  // These probes establish that execution is meaningful, not complete coverage.
  const anyState = windows.some(w => {
    const coverage=provider.coverage?.(w.object);
    const pieces=coverage ? coverage.map(p=>({start:Math.max(p.start,w.start),end:Math.min(p.end,w.end)})).filter(p=>p.start<=p.end) : [w];
    return pieces.some(p=>[p.start, (p.start+p.end)/2, p.end].some(et => {
    try { const p = provider.position(w.object, et, body, bodyOptions.frame); return !!p && p.every(Number.isFinite); } catch { return false; }
    }));
  });
  if (!anyState) return fail('data-unavailable', 'The analysis is supported, but no relative states can be read in the requested intervals/frame. Do not guess a different frame or datum.');
  result.query = { objects: request.objects, body, frame: bodyOptions.frame, metric: heightMetrics[request.metric], extremum: request.extremum, ...resolved,
    scope: scope.kind === 'activities' ? { ...scope, ids: activities.map(a => a.id) } : scope,
    stepSeconds: .1, timeToleranceSeconds: .005, sampling: 'adaptive', maxEvaluations: 200000 };
  result.message = 'Ready: native activity windows, declared datum/frame/source and bounded adaptive sampling. Global height error remains unknown.';
  return result;
}
