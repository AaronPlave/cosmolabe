import { afterEach, describe, expect, it, vi } from 'vitest';
import { Body, FixedPointTrajectory, FixedRotation, InterpolatedStatesTrajectory, Universe, findTrajectoryExtrema, trajectoryExtremumEvent, type MissionActivity } from '@cosmolabe/core';

const runtime = vi.hoisted(() => ({ universe: null as unknown }));
vi.mock('../viewer-state.svelte', async importOriginal => ({
  ...await importOriginal<typeof import('../viewer-state.svelte')>(),
  getSceneUniverse: () => runtime.universe,
  getRenderer: () => null,
}));
import { trajectoryCandidates, trajectorySourceWindow, trajectoryMetricAvailability } from '../trajectory-analysis.svelte';
import { createConfiguredEventQuery, setEventResults } from '../analysis.svelte';
import { ef, resetForScene, setSelection } from '../event-finder.svelte';
import { emit, vs } from '../viewer-state.svelte';
import { analysisResultGuards } from '../trajectory-analysis-identity';
import { activityEvent } from '../mission-activities';

afterEach(() => { resetForScene(); analysisResultGuards.clear(); vs.activities = []; runtime.universe = null; });

function scene() {
  const universe = new Universe();
  universe.addBody(new Body({ name: 'Moon', radii: [10, 10, 10], trajectory: new FixedPointTrajectory([0, 0, 0]), rotation: new FixedRotation([1, 0, 0, 0], 'ECLIPJ2000', 'IAU_MOON') }));
  const add = (name: string, start: number, end: number) => universe.addBody(new Body({ name, parentName: 'Sun', trajectory: new InterpolatedStatesTrajectory([
    { et: start, position: [12, 0, 0], velocity: [0, 0, 0] }, { et: end, position: [13, 0, 0], velocity: [0, 0, 0] },
  ], { frame: 'IAU_MOON' }) }));
  add('flyby', 0, 10); add('later', 100, 110);
  runtime.universe = universe;
  return universe;
}

describe('trajectory scope and contextual metrics', () => {
  it('discovers cross-parent flybys from relative states and excludes nonoverlapping sources', () => {
    const universe = scene();
    expect(trajectoryCandidates(universe, 'Moon', { start: 0, end: 10 })).toEqual(['flyby']);
    expect(trajectoryCandidates(universe, 'Moon', { start: 50, end: 60 })).toEqual([]);
    expect(trajectoryCandidates(universe, 'Moon', { start: 0, end: 110 })).toEqual(['flyby', 'later']);
  });
  it('limits unqualified discovery to vehicles in a mixed catalog, preserving named expert objects', () => {
    const universe = scene();
    const sampled = () => new InterpolatedStatesTrajectory([
      { et: 0, position: [30, 0, 0], velocity: [0, 0, 0] }, { et: 10, position: [31, 0, 0], velocity: [0, 0, 0] },
    ], { frame: 'IAU_MOON' });
    for (const classification of ['spacecraft', 'lander', 'rover', 'planet', 'star', 'barycenter', 'asteroid', 'static'])
      universe.addBody(new Body({ name: classification, classification, parentName: 'Sun', trajectory: sampled() }));
    universe.addBody(new Body({ name: 'unclassified-fixed', trajectory: new FixedPointTrajectory([50, 0, 0]) }));
    universe.addBody(new Body({ name: 'unclassified-globe', geometryType: 'Globe', trajectory: sampled() }));
    universe.addBody(new Body({ name: 'unclassified-natural', radii: [10, 10, 10], trajectory: sampled() }));
    universe.addBody(new Body({ name: 'mission-fixed', trajectory: new FixedPointTrajectory([15, 0, 0]) }));
    universe.activities.replace('fixture', [{ version: 1, id: 'mission-drive', name: 'Drive', kind: 'drive', vehicle: 'mission-fixed', body: 'Moon', temporality: 'interval', start: 0, end: 10, provenance: { source: 'fixture', version: 'v1', authority: 'authored', timing: 'exact', limitations: 'test' } }]);
    expect(trajectoryCandidates(universe, 'Moon', { start: 0, end: 10 })).toEqual(['flyby', 'spacecraft', 'lander', 'rover', 'mission-fixed']);
    // Named source windows bypass unqualified vehicle discovery.
    expect(trajectorySourceWindow('Moon', 'planet')).toEqual({ start: 0, end: 10 });
  });
  it('offers a source envelope across disjoint vehicles without treating the gaps as coverage', () => {
    scene();
    expect(trajectorySourceWindow('Moon')).toEqual({ start: 0, end: 110 });
    expect(trajectorySourceWindow('Moon', 'flyby')).toEqual({ start: 0, end: 10 });
  });
  it('explains unavailable physical terrain while retaining explicit reference choices', () => {
    scene();
    expect(trajectoryMetricAvailability('Moon')).toMatchObject({ heightAbovePhysicalTerrain: expect.stringContaining('unavailable'), radialHeightAboveReferenceSphere: null, heightAboveReferenceEllipsoid: null });
  });
});

describe('activity refresh selection identity', () => {
  const activity: MissionActivity = { version: 1, id: 'drive', name: 'Traverse', kind: 'drive', vehicle: 'rover', body: 'Moon', temporality: 'interval', start: 0, end: 10, provenance: { source: 'fixture', version: 'v1', authority: 'authored', timing: 'exact', limitations: 'test' } };
  async function selectNumerical() {
    const response = await findTrajectoryExtrema({ objects: ['rover'], body: 'Moon', frame: 'IAU_MOON', metric: 'radialHeightAboveReferenceSphere', extremum: 'maximum', reference: { kind: 'sphere', radiusKm: 10 }, scope: { kind: 'activities' }, stepSeconds: 1, timeToleranceSeconds: .01 }, {
      activities: [activity], revision: () => 1, source: () => ({ id: 'fixture', revision: 'v1', classification: 'synthetic' }), position: (_, et) => [12 + et / 10, 0, 0],
    });
    const item = createConfiguredEventQuery({ kind: 'trajectory-extremum', bodies: { center: 'Moon' }, window: { start: 0, end: 10 } }, 'Height');
    const event = trajectoryExtremumEvent(response.results[0], item.id);
    setEventResults(item.id, [event]);
    vs.activities = [activity];
    analysisResultGuards.set(`${event.queryId}/${event.id}`, () => true);
    setSelection(event);
    return event;
  }
  it('retains a valid extrema selection on presentation refresh despite its numerical query ID', async () => {
    const event = await selectNumerical();
    vs.activities = [{ ...activity }];
    emit('activities', 1);
    expect([ef.selectedId, ef.selectedQueryId]).toEqual([event.id, event.queryId]);
  });
  it.each(['removed', 'replaced'] as const)('clears extrema selection when its activity/source is %s', async reason => {
    const event = await selectNumerical();
    if (reason === 'removed') vs.activities = [];
    else analysisResultGuards.set(`${event.queryId}/${event.id}`, () => false);
    emit('activities', vs.activities.length);
    expect(ef.selectedId).toBeNull();
  });
  it('keeps the direct mission-activity query identity check', () => {
    vs.activities = [activity];
    setSelection(activityEvent(activity));
    emit('activities', 1);
    expect(ef.selectedId).toBe(activity.id);
    vs.activities = [{ ...activity, vehicle: 'another-rover' }];
    emit('activities', 1);
    expect(ef.selectedId).toBeNull();
  });
});
