import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { CompositeTrajectory } from '@cosmolabe/core';
import { CameraModeName } from '@cosmolabe/three';
import type { ScriptCamera } from '@cosmolabe/control';
const state = vi.hoisted(() => ({ renderer: null as any, universe: null as any }));
vi.mock('../viewer-state.svelte', () => ({ getRenderer: () => state.renderer, getSceneUniverse: () => state.universe }));
import { getObjectContext, getViewpointInfo } from '../viewpoint-control';

const actual: ScriptCamera = { position: [0.03, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 45 };
beforeEach(() => {
  const view = { name: 'Release', epoch: 123.456789, definition: { time: '2001-01-01T00:00:00Z' }, trackBody: 'Vehicle',
    position: new Vector3(0.03, 0, 0), target: new Vector3(), up: new Vector3(0, 1, 0), fov: 45 };
  state.renderer = { scaleFactor: 1, timeController: { et: view.epoch, playing: false }, cameraController: {
    mode: CameraModeName.FREE_ORBIT, trackedBody: { body: { name: 'Vehicle' } }, originBody: { body: { name: 'Vehicle' } }, lookAtBody: null,
    getViewpoint: (name: string) => name === view.name ? view : undefined,
  } };
  state.universe = { viewpoints: [{ name: 'Release' }], getBody: () => undefined };
});
describe('authored scene context', () => {
  it('separates exact authored epoch from observed pose/time and playback', () => {
    expect(getViewpointInfo('Release', actual)).toMatchObject({ source: 'catalog-viewpoint', epoch: 123.456789,
      navigation: { poseMatches: true, epochMatches: true, observedEt: 123.456789, playing: false } });
    state.renderer.timeController.et += 0.1;
    expect(getViewpointInfo('Release', actual)?.navigation).toMatchObject({ poseMatches: true, epochMatches: false });
    expect(getViewpointInfo('Release', { ...actual, target: [0, 1, 0] })?.navigation.poseMatches).toBe(false);
    state.renderer.cameraController.originBody = null;
    expect(getViewpointInfo('Release', actual)?.navigation.poseMatches).toBe(false);
    expect(getViewpointInfo('missing', actual)).toBeUndefined();
  });
  it('reports unresolved view poses as unavailable and re-reads the active renderer', () => {
    state.renderer.cameraController.getViewpoint = () => ({ target: new Vector3(), resolve: () => { throw new Error('private path'); } });
    expect(getViewpointInfo('broken', actual)).toMatchObject({ camera: null, navigation: { poseMatches: false } });
    state.renderer = null;
    expect(getViewpointInfo('Release', actual)).toBeUndefined();
  });
  it('bounds scene windows and withholds asset paths without calling them measured events', () => {
    state.universe.getBody = () => ({ existsFrom: 100, trajectory: new CompositeTrajectory([
      { startTime: 95, endTime: 100, centerName: 'Carrier', trajectory: {} as never },
      { startTime: 100, endTime: 200, centerName: 'Planet', trajectory: {} as never },
    ]), geometryType: 'TimeSwitched', geometryData: { sequence: Array.from({ length: 20 }, (_, i) => ({ startEt: i ? 100 : -Infinity, endEt: Infinity,
      geometry: { source: '/private/sensitive?key=secret' } })) } });
    const result = getObjectContext('Probe')!;
    expect(result).toMatchObject({ source: 'scene-configuration', existence: { start: 100, end: null }, truncated: true });
    expect(result.trajectoryArcs).toEqual([{ start: 95, end: 100, center: 'Carrier' }, { start: 100, end: 200, center: 'Planet' }]);
    expect(result.geometryWindows).toHaveLength(16);
    expect(result.geometryWindows[0]).toEqual({ start: null, end: null });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|Infinity/);
    expect(result.limitations.join(' ')).toMatch(/not measured mission events/);
  });
});
