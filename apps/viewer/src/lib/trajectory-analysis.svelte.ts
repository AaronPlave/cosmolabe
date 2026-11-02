/** Shared semantic operation for UI, typed scripts, embedding and Ask. */
import { findTrajectoryExtrema as compute, validateTrajectoryExtremaQuery, universeTrajectoryAnalysisProvider, trajectoryExtremumEvent, bodyFixedToGeodetic, type TrajectoryExtremaQuery, type TrajectoryAnalysisOptions, type TrajectoryExtremaResponse } from '@cosmolabe/core';
import { analysis, createConfiguredEventQuery, setEventResults } from './analysis.svelte';
import { selectEvent, syncEventResultsInScene, removeConfiguredQuery } from './event-finder.svelte';
import { analysisResultGuards } from './trajectory-analysis-identity';
import { getRenderer, getSceneUniverse, sceneId, vs, asHostTimeChange, onViewerEvent } from './viewer-state.svelte';
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
async function runAnalysis(query: TrajectoryExtremaQuery, options: TrajectoryAnalysisOptions = {}, eventQuery?: import('@cosmolabe/core').EventQuery): Promise<TrajectoryExtremaResponse> {
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
  const activities = universe.activities.list(), kernels = vs.kernelCount;
  const bodies = universe.getAllBodies().map(b => ({ body: b, trajectory: b.trajectory, rotation: b.rotation }));
  const frameDefinitions = universe.frames.definitions();
  const sameFrames = () => {
    const now = universe.frames.definitions();
    return now.length === frameDefinitions.length && now.every((definition, index) => frameDefinitions[index] === definition);
  };
  const terrainBody = renderer.getBodyMesh(query.body);
  const terrainRevision = terrainBody?.terrainSourceRevision;
  const terrainId = terrainBody?.terrainSourceId;
  const current = () => sceneId() === scene && getSceneUniverse() === universe && universe.getAllBodies().length === bodies.length && universe.activities.list() === activities && vs.kernelCount === kernels
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
      || (datum.referenceShape.kind === 'sphere' ? datum.verticalDatum !== 'reference-sphere' : datum.verticalDatum !== 'ellipsoid' || datum.heightConvention !== 'geodetic-normal'))
      return null;
    const location = bodyFixedToGeodetic({ xKm: p[0], yKm: p[1], zKm: p[2] }, datum);
    const sample = await terrainBody.requestTerrainAnalysisSample(location.latDeg, location.lonDeg);
    if (!sample || sample.source.id !== q.terrain?.id || sample.source.version !== q.terrain.revision)
      return null;
    return { heightKm: sample.elevationKm, sourceUncertaintyKm: sample.source.uncertaintyKm ?? null };
  };
  options.signal?.addEventListener?.('abort', abort);
  try {
    const response = await compute(query, provider, { signal: { get aborted() { return token.signal.aborted || !!options.signal?.aborted; }, addEventListener: (_type, listener) => token.signal.addEventListener('abort', listener), removeEventListener: (_type, listener) => token.signal.removeEventListener('abort', listener) }, onProgress: fraction => {
        options.onProgress?.(fraction);
      } });
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
  const scope = String(p.scope ?? 'flights');
  const activities = universe.activities.list().filter(a => a.enabled !== false && a.body === bodyName && (!eventQuery.bodies.observer || a.vehicle === eventQuery.bodies.observer)
    && (scope !== 'flights' || a.kind === 'flight' || a.kind === 'hop') && a.start <= eventQuery.window.end && a.end >= eventQuery.window.start);
  const metric = p.metric as TrajectoryExtremaQuery['metric'];
  const datum = terrain?.terrainDatum;
  let reference: TrajectoryExtremaQuery['reference'];
  if (metric === 'heightAbovePhysicalTerrain') {
    if (!datum || !terrain?.terrainSourceId || !terrain.terrainSourceRevision)
      return unavailable('A versioned physical CPU terrain source is required for AGL.');
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
    objects: eventQuery.bodies.observer ? [eventQuery.bodies.observer] : [...new Set(activities.map(a => a.vehicle))],
    body: bodyName, frame: typeof p.frame === 'string' ? p.frame : universe.frames.bodyFixedFrameFor(bodyName),
    metric, extremum: p.extremum as TrajectoryExtremaQuery['extremum'], reference,
    scope: scope === 'window' ? { kind: 'windows', windows: [eventQuery.window] } : { kind: 'activities', ids: activities.map(a => a.id), window: eventQuery.window },
    stepSeconds: eventQuery.step ?? .1, timeToleranceSeconds: Number(p.timeToleranceSeconds ?? .005),
    ...(metric === 'heightAbovePhysicalTerrain' ? { terrain: { id: typeof p.terrainId === 'string' ? p.terrainId : terrain!.terrainSourceId!, revision: typeof p.terrainRevision === 'string' ? p.terrainRevision : terrain!.terrainSourceRevision! } } : {}),
  };
  return runAnalysis(query, options, eventQuery);
}
function eventConfiguration(query: TrajectoryExtremaQuery, activities: readonly import('@cosmolabe/core').MissionActivity[]): import('@cosmolabe/core').EventQueryConfiguration {
  const scope = query.scope;
  const windows = scope.kind === 'windows' ? scope.windows : activities.filter(a => query.objects.includes(a.vehicle) && (!scope.ids || scope.ids.includes(a.id))).map(a => ({ start: a.start, end: a.end }));
  return { kind: 'trajectory-extremum', bodies: { center: query.body, ...(query.objects.length === 1 ? { observer: query.objects[0] } : {}) },
    window: { start: Math.min(...windows.map(w => w.start)), end: Math.max(...windows.map(w => w.end)) }, step: query.stepSeconds, abcorr: 'NONE',
    params: { metric: query.metric, extremum: query.extremum, scope: query.scope.kind === 'windows' ? 'window' : 'activities', timeToleranceSeconds: query.timeToleranceSeconds, frame: query.frame,
      ...(query.reference.kind === 'sphere' ? { radiusKm: query.reference.radiusKm } : {}), ...(query.terrain ? { terrainId: query.terrain.id, terrainRevision: query.terrain.revision } : {}) } };
}
function sameReference(a: TrajectoryExtremaQuery['reference'], b: TrajectoryExtremaQuery['reference']): boolean {
  if (a.kind === 'sphere')
    return b.kind === 'sphere' && a.radiusKm === b.radiusKm;
  return b.kind === 'ellipsoid' && a.radiiKm.every((radius, index) => radius === b.radiiKm[index]);
}
