import type { EventKind } from '../registry.js';
import type { EventQuery } from '../types.js';
import { trajectoryExtremumEvent, validateTrajectoryExtremaQuery } from '../../trajectory-extrema.js';
/** Native Event Finder kind. The numerical service is injected just like GF;
 * catalog sampling and terrain never become an agent-owned solver. */
export const trajectoryExtremumKind: EventKind = {
  kind: 'trajectory-extremum', label: 'Trajectory height extrema', engine: 'trajectory-analysis',
  description: 'Find maximum or minimum sphere height, ellipsoid height or physical terrain clearance, including between trajectory waypoints.',
  temporality: 'instant', primaryRole: 'observer', defaultStep: .1, defaultAbcorr: 'NONE',
  resultNotice: 'Sampled and locally refined extrema. Global height error is unknown; source accuracy is separate. Select a result for its frame, datum, provenance and measured epoch.',
  roles: [
    { role: 'center', label: 'Central body' },
    { role: 'observer', label: 'Vehicle', required: false, emptyLabel: 'All matching activity vehicles' },
  ],
  params: [
    { kind: 'choice', key: 'metric', label: 'Height', default: 'heightAbovePhysicalTerrain', options: [
        { value: 'heightAbovePhysicalTerrain', label: 'Physical terrain clearance (AGL)' },
        { value: 'radialHeightAboveReferenceSphere', label: 'Radial height above reference sphere' },
        { value: 'heightAboveReferenceEllipsoid', label: 'Height above reference ellipsoid' },
      ] },
    { kind: 'choice', key: 'extremum', label: 'Find', default: 'maximum', options: [{ value: 'maximum', label: 'Maximum' }, { value: 'minimum', label: 'Minimum' }] },
    { kind: 'choice', key: 'scope', label: 'Scope', default: 'flights', options: [
        { value: 'flights', label: 'Catalog flight / hop intervals' },
        { value: 'activities', label: 'All catalog activity intervals' },
        { value: 'window', label: 'Entire search window' },
      ], help: 'Blank vehicle searches every matching catalog vehicle. Flight scope excludes parked intervals. The window clips each activity.' },
    { kind: 'number', key: 'timeToleranceSeconds', label: 'Refine to', unit: 's', min: .000001, default: .005, help: 'Local time bracket tolerance; global height error and source accuracy remain separate.' },
    { kind: 'text', key: 'frame', label: 'Frame', required: false, help: 'Defaults to the central body’s declared body-fixed frame; reported explicitly with every result.' },
    { kind: 'number', key: 'radiusKm', label: 'Sphere radius', unit: 'km', required: false, min: .000001, help: 'Optional reference sphere override. Otherwise requires a declared physical sphere. Ellipsoid height uses the declared body radii.' },
    { kind: 'text', key: 'terrainId', label: 'Terrain source', required: false, help: 'Optional exact source identity pin; otherwise the active CPU source is pinned at execution.' },
    { kind: 'text', key: 'terrainRevision', label: 'Terrain rev.', required: false, help: 'Optional exact version pin; never inferred from a URL or filename.' },
  ],
  validate(query: EventQuery) {
    if (query.trajectoryAnalysis) {
      const invalid = validateTrajectoryExtremaQuery(query.trajectoryAnalysis);
      return invalid ? { code: 'invalid-params', message: invalid.message } : undefined;
    }
    const p = query.params ?? {};
    if (!['heightAbovePhysicalTerrain', 'radialHeightAboveReferenceSphere', 'heightAboveReferenceEllipsoid'].includes(String(p.metric)) || !['maximum', 'minimum'].includes(String(p.extremum)) || !['flights', 'activities', 'window'].includes(String(p.scope)))
      return { code: 'invalid-params', message: 'Choose an explicit height metric, extremum and scope.' };
    if (p.scope === 'window' && !query.bodies.observer)
      return { code: 'missing-body', role: 'observer', message: 'An entire-window height search requires a vehicle. Leave it blank only for catalog activity scope.' };
    if (typeof p.timeToleranceSeconds !== 'number' || !Number.isFinite(p.timeToleranceSeconds) || p.timeToleranceSeconds <= 0 || p.timeToleranceSeconds > (query.step ?? .1))
      return { code: 'invalid-params', message: 'Refinement tolerance must be positive and no larger than the search step.' };
    return undefined;
  },
  async run(query, ctx) {
    if (!ctx.trajectoryAnalysis) {
      ctx.reportFault?.({ code: 'unavailable', message: 'The host does not supply trajectory / physical terrain analysis.' });
      return [];
    }
    const response = await ctx.trajectoryAnalysis(query);
    for (const fault of response.faults)
      ctx.reportFault?.({ code: fault.code === 'invalid-query' ? 'invalid-params' : 'unavailable', message: fault.message, window: fault.window });
    return response.results.map(result => trajectoryExtremumEvent(result, query.id));
  },
};
