import { ACTIVITY_KINDS } from '../../../MissionActivity.js';
import type { EventKind } from '../registry.js';
import type { EventQuery } from '../types.js';
import { trajectoryExtremumEvent, validateTrajectoryExtremaQuery } from '../../trajectory-extrema.js';
/** Native Event Finder kind. The numerical service is injected just like GF;
 * catalog sampling and terrain never become an agent-owned solver. */
export const trajectoryExtremumKind: EventKind = {
  kind: 'trajectory-extremum', label: 'Altitude / terrain clearance', engine: 'trajectory-analysis',
  description: 'Find the highest or lowest height above a reference sphere, ellipsoid, or physical terrain. Closest approach instead minimizes center-to-center distance; its altitude is measured at that encounter.',
  temporality: 'instant', primaryRole: 'observer', defaultStep: .1, defaultAbcorr: 'NONE',
  resultNotice: 'One sampled, locally refined candidate per vehicle and matching interval. Ranking compares these candidates, not certified global extrema. Incomplete searches cannot establish an overall winner.',
  roles: [
    { role: 'center', label: 'Central body' },
    { role: 'observer', label: 'Vehicle(s)', required: false, emptyLabel: 'All matching trajectory objects' },
  ],
  params: [
    { kind: 'choice', key: 'metric', label: 'Height relative to', default: 'heightAbovePhysicalTerrain', options: [
        { value: 'heightAbovePhysicalTerrain', label: 'Physical terrain clearance (AGL)' },
        { value: 'radialHeightAboveReferenceSphere', label: 'Radial height above reference sphere' },
        { value: 'heightAboveReferenceEllipsoid', label: 'Height above reference ellipsoid' },
      ] },
    { kind: 'choice', key: 'extremum', label: 'Find', default: 'maximum', options: [{ value: 'maximum', label: 'Highest' }, { value: 'minimum', label: 'Lowest' }] },
    { kind: 'choice', key: 'scope', label: 'Where to search', default: 'window', options: [
        { value: 'window', label: 'Time window' },
        { value: 'activities', label: 'Mission activities' },
        { value: 'selected-activities', label: 'Specific activities' },
      ], help: 'The time window is independent of mission activities. Activity restrictions use only explicit catalog records and never imply trajectory coverage.' },
    { kind: 'choice', key: 'activityKind', label: 'Activity kind', default: 'all', when: { key: 'scope', values: ['activities', 'selected-activities'] }, options: [
        { value: 'all', label: 'All kinds' }, ...ACTIVITY_KINDS.map(value => ({ value, label: value })),
      ] },
    { kind: 'activities', key: 'activityIds', label: 'Activities', when: { key: 'scope', values: ['selected-activities'] }, help: 'Select explicit mission records; each interval is clipped to the search window.' },
    { kind: 'number', key: 'timeToleranceSeconds', advanced: true, label: 'Refine to', unit: 's', min: .000001, default: .005, help: 'Local time bracket tolerance; global height error and source accuracy remain separate.' },
    { kind: 'choice', key: 'sampling', advanced: true, label: 'Sampling', default: 'adaptive', options: [{ value: 'adaptive', label: 'Adaptive to source / duration' }, { value: 'fixed', label: 'Fixed maximum step' }], help: 'Adaptive retains source breakpoints, uses declared periods when known, and reserves evaluations for refinement. Step is a minimum spacing; actual maximum spacing is reported. Neither policy certifies a global height bound.' },
    { kind: 'text', key: 'frame', advanced: true, label: 'Frame', required: false, help: 'Defaults to the central body’s declared body-fixed frame; reported explicitly with every result.' },
    { kind: 'number', key: 'radiusKm', advanced: true, label: 'Sphere radius', unit: 'km', required: false, min: .000001, help: 'Optional reference sphere override. Otherwise requires a declared physical sphere. Ellipsoid height uses the declared body radii.' },
    { kind: 'text', key: 'terrainId', advanced: true, label: 'Terrain source', required: false, help: 'Optional exact source identity pin; otherwise the active CPU source is pinned at execution.' },
    { kind: 'text', key: 'terrainRevision', advanced: true, label: 'Terrain rev.', required: false, help: 'Optional exact version pin; never inferred from a URL or filename.' },
  ],
  validate(query: EventQuery) {
    if (query.trajectoryAnalysis) {
      const invalid = validateTrajectoryExtremaQuery(query.trajectoryAnalysis);
      return invalid ? { code: 'invalid-params', message: invalid.message } : undefined;
    }
    const p = query.params ?? {};
    if (!['heightAbovePhysicalTerrain', 'radialHeightAboveReferenceSphere', 'heightAboveReferenceEllipsoid'].includes(String(p.metric)) || !['maximum', 'minimum'].includes(String(p.extremum)) || !['activities', 'selected-activities', 'window'].includes(String(p.scope)))
      return { code: 'invalid-params', message: 'Choose an explicit height metric, extremum and scope.' };
    if (p.scope === 'selected-activities' && (!Array.isArray(p.activityIds) || !p.activityIds.length || p.activityIds.length > 128 || !p.activityIds.every(id => typeof id === 'string')))
      return { code: 'invalid-params', message: 'Select at least one explicit mission activity (maximum 128).' };
    if (p.activityKind !== undefined && p.activityKind !== 'all' && !ACTIVITY_KINDS.includes(p.activityKind as typeof ACTIVITY_KINDS[number]))
      return { code: 'invalid-params', message: 'Choose a declared mission activity kind.' };
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
    return response.results.map(result => trajectoryExtremumEvent(response.status === 'partial' ? { ...result, coverage: 'partial' } : result, query.id));
  },
};
