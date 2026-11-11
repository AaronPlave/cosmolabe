/** Shared semantic operation for UI, typed scripts, embedding and Ask. */
import { InterpolatedStatesTrajectory, CompositeTrajectory, TLETrajectory, WaypointTrajectory, findTrajectoryExtrema as compute, validateTrajectoryExtremaQuery, universeTrajectoryAnalysisProvider, trajectoryExtremumEvent, bodyFixedToGeodetic, type TrajectoryExtremaQuery, type TrajectoryAnalysisOptions, type TrajectoryExtremaResponse } from '@cosmolabe/core';
import { analysis, createConfiguredEventQuery, setEventResults } from './analysis.svelte';
import { selectEvent, syncEventResultsInScene, removeConfiguredQuery } from './event-finder.svelte';
import { analysisResultGuards } from './trajectory-analysis-identity';
import { getRenderer, getSceneUniverse, sceneId, vs, asHostTimeChange, onViewerEvent } from './viewer-state.svelte';
import type { ScriptExtremaOptions, ScriptExtremaRequest, ScriptExtremaResult } from '@cosmolabe/control';
import { heightMetrics, resolveExtremaTask } from './trajectory-task';

export function getTrajectoryAnalysisOptions(objects?: string[], explicitBody?: string): ScriptExtremaOptions {
  const universe = getSceneUniverse();
  if (!universe) return { available: false, subjects: [], bodies: [], truncated: false };
  const all = objects ? objects.map(n => universe.getBody(n)).filter(b => !!b) : universe.getAllBodies().filter(b => universe.activities.list().some(a => a.enabled !== false && a.vehicle === b.name));
  const subjects = all.slice(0, 32).map(b => {
    const activities = universe.activities.list().filter(a => a.enabled !== false && a.vehicle === b.name);
    return { object: b.name, bodies: [...new Set(activities.length ? activities.map(a => a.body) : b.parentName ? [b.parentName] : [])], activities: activities.length, activityKinds: [...new Set(activities.map(a => a.kind))] };
  });
  const bodies = [...new Set([...subjects.flatMap(s => s.bodies), ...(explicitBody ? [explicitBody] : [])])].slice(0, 32).map(body => {
    const frame = universe.frames.bodyFixedFrameFor(body), availability = trajectoryMetricAvailability(body);
    return { body, frame, metrics: (Object.keys(heightMetrics) as (keyof typeof heightMetrics)[]).map(metric => ({ metric,
      available: availability[heightMetrics[metric]] === null, reason: availability[heightMetrics[metric]] ?? null })) };
  });
  return { available: true, subjects, bodies, truncated: all.length > subjects.length };
}

export async function analyzeTrajectoryExtrema(request: ScriptExtremaRequest, options: TrajectoryAnalysisOptions = {}): Promise<ScriptExtremaResult> {
  const universe = getSceneUniverse();
  const result = resolveExtremaTask(universe, request, getTrajectoryAnalysisOptions(request.objects, request.body), (name, metric) => {
    const body = universe?.getBody(name), mesh = getRenderer()?.getBodyMesh(name);
    if (metric === 'terrain-clearance') return mesh?.terrainDatum && mesh.terrainSourceId && mesh.terrainSourceRevision
      ? { reference: mesh.terrainDatum.referenceShape, terrain: { id: mesh.terrainSourceId, revision: mesh.terrainSourceRevision } } : null;
    if (metric === 'reference-ellipsoid-height') return body?.radii ? { reference: { kind: 'ellipsoid', radiiKm: body.radii } } : null;
    const shape = mesh?.terrainDatum?.referenceShape;
    const radius = body?.radii?.every(r => r === body.radii![0]) ? body.radii[0] : shape?.kind === 'sphere' ? shape.radiusKm : undefined;
    return radius ? { reference: { kind: 'sphere', radiusKm: radius } } : null;
  });
  if (!result.query) return result;
  if (options.signal?.aborted) return { ...result, status: 'cancelled', message: 'Analysis cancelled before execution.' };
  result.started = true;
  clearDirectResults();
  const response = await runAnalysis(result.query, options, undefined, true);
  result.response = response;
  result.status = response.status;
  result.scope.evaluated=response.results.length;
  result.scope.completed = response.results.filter(r => r.coverage === 'sampled-complete').length;
  result.coverage.completeIntervals=response.results.filter(r=>r.completeness?.temporal==='complete').length;
  result.coverage.unavailableSampleIntervals=response.results.filter(r=>(r.completeness?.unavailableSamples??0)>0).length;
  result.numerical={completeIntervals:response.results.filter(r=>r.completeness?.numerical==='complete').length,budgetLimitedIntervals:response.faults.filter(f=>f.code==='budget').length};
  if (response.results.length) result.candidateId = response.results.reduce((a,b)=>(request.extremum==='maximum'?b.value>a.value:b.value<a.value)?b:a).id;
  const complete = response.status === 'complete' && !response.faults.length && response.results.length === result.scope.requested && result.scope.completed === result.scope.requested;
  if (complete) result.winnerId = response.results.reduce((a, b) => (request.extremum === 'maximum' ? b.value > a.value : b.value < a.value) ? b : a).id;
  else if (response.status === 'complete') result.status = 'partial';
  result.reason = response.faults.some(f => f.code === 'budget') ? 'work-budget' : complete ? null : 'data-unavailable';
  result.message = complete ? 'Compared every requested interval using sampled and locally refined results. This is not a certified global extremum or telemetry accuracy bound.'
    : `${response.results.length}/${result.scope.requested} intervals produced candidates; ${result.coverage.completeIntervals} have complete temporal coverage at source epoch encoding precision; ${result.numerical.budgetLimitedIntervals} reached numerical limits. Report these separately from unavailable samples and source accuracy. A limited interval could contain a higher value; no full-scope winner is established. Do not rerun equivalent analysis.`;
  return result;
}
let active: AbortController | null = null;
let sequence = 0;
const stored = new Map<string, {
  event: ReturnType<typeof trajectoryExtremumEvent>;
  current: () => boolean;
}>();
const directItems = new Set<string>();
function clearDirectResults() {
  for (const id of directItems)
    removeConfiguredQuery(id);
  directItems.clear();
  for (const [id, entry] of stored)
    if (!analysis.items.some(item => item.id === entry.event.queryId)) {
      stored.delete(id);
      analysisResultGuards.delete(`${entry.event.queryId}/${id}`);
    }
}
onViewerEvent('load', () => { active?.abort(); stored.clear(); directItems.clear(); analysisResultGuards.clear(); });
export function findViewerTrajectoryExtrema(query: TrajectoryExtremaQuery, options: TrajectoryAnalysisOptions = {}): Promise<TrajectoryExtremaResponse> {
  const invalid = validateTrajectoryExtremaQuery(query);
  if (invalid)
    return Promise.resolve({ status: 'unavailable', results: [], faults: [invalid] });
  clearDirectResults();
  return runAnalysis(query, options);
}
async function runAnalysis(query: TrajectoryExtremaQuery, options: TrajectoryAnalysisOptions = {}, eventQuery?: import('@cosmolabe/core').EventQuery, collection = false): Promise<TrajectoryExtremaResponse> {
  const invalid = validateTrajectoryExtremaQuery(query);
  if (invalid)
    return { status: 'unavailable', results: [], faults: [invalid] };
  // Host-owned request/result objects must never mutate stored scene identity.
  query = JSON.parse(JSON.stringify(query));
  for (const [id, entry] of stored)
    if (entry.event.queryId === eventQuery?.id || !analysis.items.some(item => item.id === entry.event.queryId)) {
      stored.delete(id);
      analysisResultGuards.delete(`${entry.event.queryId}/${id}`);
    }
  active?.abort();
  const token = new AbortController();
  const abort = () => token.abort();
  active = token;
  const scene = sceneId(), universe = getSceneUniverse(), renderer = getRenderer();
  if (!universe || !renderer)
    return { status: 'unavailable', results: [], faults: [{ code: 'unavailable', message: 'No loaded scene.' }] };
  // Capture identities, not runtime cache revisions (loading finest grids must
  // not invalidate the operation that requested them).
  const activities = universe.activities.list(), kernels = vs.kernelCount, kernelRevision = vs.kernelRevision;
  const bodies = universe.getAllBodies().map(b => ({ body: b, trajectory: b.trajectory, rotation: b.rotation }));
  const frameDefinitions = universe.frames.definitions();
  const sameFrames = () => {
    const now = universe.frames.definitions();
    return now.length === frameDefinitions.length && now.every((definition, index) => frameDefinitions[index] === definition);
  };
  const terrainBody = renderer.getBodyMesh(query.body);
  const terrainRevision = terrainBody?.terrainSourceRevision;
  const terrainId = terrainBody?.terrainSourceId;
  const current = () => sceneId() === scene && getSceneUniverse() === universe && universe.getAllBodies().length === bodies.length && universe.activities.list() === activities && vs.kernelCount === kernels && vs.kernelRevision === kernelRevision
    && sameFrames()
    && bodies.every(b => universe.getBody(b.body.name) === b.body && b.body.trajectory === b.trajectory && b.body.rotation === b.rotation)
    && (query.metric !== 'heightAbovePhysicalTerrain' || (getRenderer()?.getBodyMesh(query.body) === terrainBody && terrainBody?.terrainSourceRevision === terrainRevision && terrainBody?.terrainSourceId === terrainId));
  const provider = universeTrajectoryAnalysisProvider(universe, () => current() ? token : null);
  provider.yield = () => new Promise(resolve => setTimeout(resolve, 0));
  provider.terrain = async (p, q, opts) => {
    const datum = terrainBody?.terrainDatum;
    if (opts.signal?.aborted || !terrainBody || !datum || terrainBody.terrainFrameAvailability?.kind !== 'available'
      || !terrainBody.terrainFrameAvailability.frame || !universe.frames.sameFrame(terrainBody.terrainFrameAvailability.frame, q.frame) || terrainId !== q.terrain?.id || terrainRevision !== q.terrain?.revision
      || !sameReference(datum.referenceShape, q.reference)
      || (datum.referenceShape.kind === 'sphere' ? datum.verticalDatum !== 'reference-sphere' || datum.heightConvention !== 'radial' : datum.verticalDatum !== 'ellipsoid' || datum.heightConvention !== 'geodetic-normal'))
      return null;
    const location = bodyFixedToGeodetic({ xKm: p[0], yKm: p[1], zKm: p[2] }, datum);
    const sample = await terrainBody.requestTerrainAnalysisSample(location.latDeg, location.lonDeg, opts.signal);
    if (!sample || sample.source.id !== q.terrain?.id || sample.source.version !== q.terrain.revision)
      return null;
    return { heightKm: sample.elevationKm, sourceUncertaintyKm: sample.source.uncertaintyKm ?? null };
  };
  options.signal?.addEventListener?.('abort', abort);
  try {
    const computeOptions: TrajectoryAnalysisOptions = { signal: { get aborted() { return token.signal.aborted || !!options.signal?.aborted; }, addEventListener: (_type, listener) => token.signal.addEventListener('abort', listener), removeEventListener: (_type, listener) => token.signal.removeEventListener('abort', listener) }, onProgress: fraction => {
        options.onProgress?.(fraction);
      } };
    let response: TrajectoryExtremaResponse;
    if (collection && query.scope.kind === 'activities') {
      // One native collection operation, bounded by 128 intervals and one million
      // evaluations. Source knots determine each existing solver call's allowance;
      // dense early activities cannot consume the entire collection's budget.
      const scope=query.scope;
      const jobs=activities.filter(a=>a.enabled!==false && query.objects.includes(a.vehicle) && a.body===query.body && (!scope.ids || scope.ids.includes(a.id)));
      response={status:'complete',results:[],faults:[]};let evaluations=0;
      const position=provider.position;
      provider.position=(...args)=>{evaluations++;return position(...args);};
      for (const [i,a] of jobs.entries()) {
        if (!current() || computeOptions.signal?.aborted) { response={status:computeOptions.signal?.aborted?'cancelled':'stale',results:[],faults:[{code:computeOptions.signal?.aborted?'cancelled':'stale',message:'Collection cancelled or authoritative inputs changed.'}]};break; }
        const window={start:Math.max(a.start,scope.window?.start??a.start),end:Math.min(a.end,scope.window?.end??a.end)};
        const knots=provider.knots?.(a.vehicle,window).length??0;
        const budget=Math.min(1000000-evaluations,query.maxEvaluations??200000,Math.max(4096,Math.ceil(knots*8+(window.end-window.start)/query.stepSeconds)));
        if (budget<1) { response.status='partial';response.faults.push({code:'budget',object:a.vehicle,activityId:a.id,window,message:'Collection evaluation budget exhausted.'});continue; }
        const part=await compute({...query,objects:[a.vehicle],scope:{...scope,ids:[a.id]},maxEvaluations:budget},provider,{...computeOptions,onProgress:f=>options.onProgress?.((i+f)/jobs.length)});
        response.results.push(...part.results);response.faults.push(...part.faults);
        if (part.status==='cancelled'||part.status==='stale') { response=part;break; }
        if (part.status!=='complete') response.status='partial';
      }
      if (!response.results.length && response.status==='partial') response.status='unavailable';
    } else response = await compute(query, provider, computeOptions);
    if (active !== token)
      return { status: 'cancelled', results: [], faults: [{ code: 'cancelled', message: 'Superseded by a newer analysis.' }] };
    if (response.results.length && current()) {
      let queryId = eventQuery?.id;
      if (!queryId) {
        const item = createConfiguredEventQuery(eventConfiguration(query, activities), `${query.extremum}: ${query.metric}`, 'explicit');
        item.query.trajectoryAnalysis = query;
        directItems.add(item.id);
        queryId = item.id;
      }
      const events = response.results.map(r => {
        r.id = `trajectory-analysis-${++sequence}`;
        const event = trajectoryExtremumEvent(r, queryId!);
        stored.set(r.id, { event, current });
        analysisResultGuards.set(`${queryId}/${r.id}`, () => current() && !!analysis.eventResults[queryId!]?.some(event => event.id === r.id) && analysis.items.some(item => item.id === queryId && item.enabled));
        return event;
      });
      if (!eventQuery) {
        setEventResults(queryId, events);
        syncEventResultsInScene();
      }
    }
    return JSON.parse(JSON.stringify(response));
  }
  finally {
    options.signal?.removeEventListener?.('abort', abort);
    if (active === token)
      active = null;
  }
}
/** Instant cut to the actual measured vehicle: no deferred flight can retake
 * the camera after manual input/cancellation. Clock writes preserve host cause. */
export function navigateToAnalysisResult(id: string, host = false): boolean {
  const entry = stored.get(id);
  if (!entry || !entry.current() || !analysis.eventResults[entry.event.queryId]?.some(e => e.id === id) || !analysis.items.some(item => item.id === entry.event.queryId && item.enabled))
    return false;
  const navigate = () => {
    return selectEvent(entry.event) === true;
  };
  return host ? asHostTimeChange(navigate) : navigate();
}
/** Standard Event Finder requests resolve source defaults once, then execute the
 * exact same typed analysis used by embedding and Ask. */
export async function runTrajectoryEventQuery(eventQuery: import('@cosmolabe/core').EventQuery, options: TrajectoryAnalysisOptions): Promise<TrajectoryExtremaResponse> {
  if (eventQuery.trajectoryAnalysis)
    return runAnalysis(eventQuery.trajectoryAnalysis, options, eventQuery);
  const universe = getSceneUniverse();
  const bodyName = eventQuery.bodies.center!;
  const body = universe?.getBody(bodyName);
  const terrain = getRenderer()?.getBodyMesh(bodyName);
  const p = eventQuery.params ?? {};
  const unavailable = (message: string): TrajectoryExtremaResponse => ({ status: 'unavailable', results: [], faults: [{ code: 'unavailable', message }] });
  if (!body || !universe)
    return unavailable('The central body is unavailable.');
  const scope = String(p.scope ?? 'window');
  const activities = universe.activities.list().filter(a => a.enabled !== false && a.body === bodyName && (!eventQuery.bodies.observer || a.vehicle === eventQuery.bodies.observer)
    && (!p.activityKind || p.activityKind === 'all' || a.kind === p.activityKind)
    && (scope !== 'selected-activities' || (Array.isArray(p.activityIds) && p.activityIds.includes(a.id))) && a.start <= eventQuery.window.end && a.end >= eventQuery.window.start);
  if (scope !== 'window' && !activities.length)
    return unavailable('No explicit mission activities match this restriction and time window. Choose other activities or Time window.');
  const objects = eventQuery.bodies.observer ? [eventQuery.bodies.observer] : scope !== 'window' ? [...new Set(activities.map(a => a.vehicle))] : trajectoryCandidates(universe, bodyName, eventQuery.window);
  if (!objects.length)
    return unavailable('No objects have probeable relative states in this time window. Choose a trajectory object or another window.');
  const metric = p.metric as TrajectoryExtremaQuery['metric'];
  const datum = terrain?.terrainDatum;
  let reference: TrajectoryExtremaQuery['reference'];
  if (metric === 'heightAbovePhysicalTerrain') {
    if (!datum || !terrain?.terrainSourceId || !terrain.terrainSourceRevision)
      return unavailable('Physical terrain clearance is unavailable: a versioned CPU terrain source is required. Choose Radial height above reference sphere or Height above reference ellipsoid explicitly to search a reference surface.');
    reference = datum.referenceShape;
    if (p.radiusKm !== undefined && (reference.kind !== 'sphere' || p.radiusKm !== reference.radiusKm))
      return unavailable('The requested radius does not match the physical terrain datum.');
  }
  else if (metric === 'heightAboveReferenceEllipsoid') {
    if (!body.radii)
      return unavailable('No declared reference ellipsoid.');
    reference = { kind: 'ellipsoid', radiiKm: body.radii };
  }
  else {
    const radius = p.radiusKm ?? (body.radii && body.radii.every(r => r === body.radii![0]) ? body.radii[0] : datum?.referenceShape.kind === 'sphere' ? datum.referenceShape.radiusKm : undefined);
    if (typeof radius !== 'number')
      return unavailable('Specify a reference sphere radius for this body.');
    reference = { kind: 'sphere', radiusKm: radius };
  }
  const query: TrajectoryExtremaQuery = {
    objects,
    body: bodyName, frame: typeof p.frame === 'string' ? p.frame : universe.frames.bodyFixedFrameFor(bodyName),
    metric, extremum: p.extremum as TrajectoryExtremaQuery['extremum'], reference,
    scope: scope === 'window' ? { kind: 'windows', windows: [eventQuery.window] } : { kind: 'activities', ids: activities.map(a => a.id), window: eventQuery.window },
    stepSeconds: eventQuery.step ?? .1, timeToleranceSeconds: Number(p.timeToleranceSeconds ?? .005),
    sampling: p.sampling === 'fixed' ? 'fixed' : 'adaptive',
    ...(metric === 'heightAbovePhysicalTerrain' ? { terrain: { id: typeof p.terrainId === 'string' ? p.terrainId : terrain!.terrainSourceId!, revision: typeof p.terrainRevision === 'string' ? p.terrainRevision : terrain!.terrainSourceRevision! } } : {}),
  };
  return runAnalysis(query, options, eventQuery);
}
/** Availability is shown before execution; choosing another datum is explicit. */
export function trajectoryMetricAvailability(bodyName?: string, frameOverride?: string, radiusOverride?: string): Record<string, string | null> {
  const universe = getSceneUniverse(), body = bodyName ? universe?.getBody(bodyName) : undefined;
  if (!body || !universe) return {};
  const terrain = getRenderer()?.getBodyMesh(body.name);
  const frame = frameOverride || universe.frames.bodyFixedFrameFor(body.name);
  const shape = terrain?.terrainDatum?.referenceShape;
  const datum = terrain?.terrainDatum;
  const terrainFrame = terrain?.terrainFrameAvailability;
  const compatible = shape?.kind === 'sphere' ? datum?.verticalDatum === 'reference-sphere' && datum?.heightConvention === 'radial' : shape?.kind === 'ellipsoid' && datum?.verticalDatum === 'ellipsoid' && datum?.heightConvention === 'geodetic-normal';
  return {
    heightAbovePhysicalTerrain: !terrain?.terrainSourceId || !terrain.terrainSourceRevision ? 'A versioned physical CPU terrain source is unavailable. Choose a labeled reference surface explicitly.'
      : !datum ? 'Physical terrain datum is missing. Declare its reference shape, vertical datum and height convention.'
        : !compatible ? `Physical terrain datum is unsupported: ${datum.verticalDatum}, ${datum.heightConvention}, ${shape?.kind}. Clearance requires reference-sphere/radial or ellipsoid/geodetic-normal heights.`
          : !terrainFrame?.frame ? `Physical terrain frame is missing. Declare the validated source frame before searching in ${frame}.`
            : terrainFrame.kind !== 'available' ? `Physical terrain frame ${terrainFrame.frame} is unavailable: ${terrainFrame.reason ?? 'source metadata has not been validated'}.`
              : !universe.frames.sameFrame(terrainFrame.frame, frame) ? `Physical terrain frame ${terrainFrame.frame} does not match analysis frame ${frame}. Choose the validated terrain frame.` : null,
    radialHeightAboveReferenceSphere: Number(radiusOverride) > 0 || (body.radii && body.radii.every(r => r === body.radii![0])) || shape?.kind === 'sphere' ? null : 'Set an explicit sphere radius in Advanced, or choose the declared ellipsoid.',
    heightAboveReferenceEllipsoid: body.radii && body.radii[0] === body.radii[1] && body.radii[2] <= body.radii[0] ? null : 'No supported oblate reference ellipsoid is declared.',
  };
}
function eventConfiguration(query: TrajectoryExtremaQuery, activities: readonly import('@cosmolabe/core').MissionActivity[]): import('@cosmolabe/core').EventQueryConfiguration {
  const scope = query.scope;
  const windows = scope.kind === 'windows' ? scope.windows : activities.filter(a => query.objects.includes(a.vehicle) && (!scope.ids || scope.ids.includes(a.id))).map(a => ({ start: a.start, end: a.end }));
  return { kind: 'trajectory-extremum', bodies: { center: query.body, ...(query.objects.length === 1 ? { observer: query.objects[0] } : {}) },
    window: { start: Math.min(...windows.map(w => w.start)), end: Math.max(...windows.map(w => w.end)) }, step: query.stepSeconds, abcorr: 'NONE',
    params: { metric: query.metric, extremum: query.extremum, scope: query.scope.kind === 'windows' ? 'window' : 'activities', timeToleranceSeconds: query.timeToleranceSeconds, sampling: query.sampling ?? 'fixed', frame: query.frame,
      ...(query.reference.kind === 'sphere' ? { radiusKm: query.reference.radiusKm } : {}), ...(query.terrain ? { terrainId: query.terrain.id, terrainRevision: query.terrain.revision } : {}) } };
}
function sameReference(a: TrajectoryExtremaQuery['reference'], b: TrajectoryExtremaQuery['reference']): boolean {
  if (a.kind === 'sphere')
    return b.kind === 'sphere' && a.radiusKm === b.radiusKm;
  return b.kind === 'ellipsoid' && a.radiiKm.every((radius, index) => radius === b.radiiKm[index]);
}

/** Unqualified searches include declared vehicles and conservative legacy vehicle
 * evidence. Natural/unknown classifications are never inferred to be vehicles.
 * Unclassified sampled/TLE/surface mission objects qualify only without natural
 * body metadata. A bare fixed point or arbitrary ephemeris is ambiguous: name it
 * explicitly to search it. Explicit object requests bypass this discovery policy. */
function isTrajectoryVehicle(universe: import('@cosmolabe/core').Universe, body: import('@cosmolabe/core').Body): boolean {
  const classification = body.classification?.trim().toLowerCase();
  if (classification) return ['spacecraft', 'lander', 'rover', 'vehicle', 'orbiter', 'probe', 'hopper', 'helicopter'].includes(classification);
  if (body.mu !== undefined || body.mass !== undefined || body.radii || body.geometryType === 'Globe') return false;
  return !!body.surfaceTrajectory || universe.activities.list({ vehicle: body.name }).some(a => a.enabled !== false)
    || body.trajectory instanceof InterpolatedStatesTrajectory || body.trajectory instanceof CompositeTrajectory
    || body.trajectory instanceof TLETrajectory || body.trajectory instanceof WaypointTrajectory;
}

/** Candidate discovery uses vehicle evidence and relative state/coverage, not catalog parentage.
 * These probes establish eligibility only; the solver checks the entire scope. */
export function trajectoryCandidates(universe: import('@cosmolabe/core').Universe, bodyName: string, window?: { start: number; end: number }): string[] {
  const provider = universeTrajectoryAnalysisProvider(universe, () => universe);
  const frame = universe.frames.bodyFixedFrameFor(bodyName);
  return universe.getAllBodies().filter(body => {
    if (body.name === bodyName || !isTrajectoryVehicle(universe, body)) return false;
    const coverage = provider.coverage?.(body.name);
    const intervals = window ? coverage ? coverage.map(w => ({ start: Math.max(w.start, window.start), end: Math.min(w.end, window.end) })).filter(w => w.start <= w.end) : [window] : coverage ?? [];
    return intervals.some(w => [w.start, (w.start + w.end) / 2, w.end].filter(Number.isFinite).some(et => {
      try { const p = provider.position(body.name, et, bodyName, frame); return p !== null && p.every(Number.isFinite) && Math.hypot(...p) > 0; }
      catch { return false; }
    }));
  }).map(body => body.name);
}
/** Finite source envelope, possibly containing gaps and disjoint vehicles.
 * It is not a guarantee of relative-state or terrain coverage. */
export function trajectorySourceWindow(bodyName?: string, object?: string): { start: number; end: number } | null {
  const universe = getSceneUniverse();
  if (!universe || !bodyName) return null;
  const objects = object ? [object] : trajectoryCandidates(universe, bodyName);
  const provider = universeTrajectoryAnalysisProvider(universe, () => universe);
  const windows = objects.flatMap(name => provider.coverage?.(name) ?? []);
  if (!windows.length || windows.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end))) return null;
  return { start: Math.min(...windows.map(w => w.start)), end: Math.max(...windows.map(w => w.end)) };
}
