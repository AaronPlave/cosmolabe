import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { UniverseRenderer } from '../UniverseRenderer.js';

type ClampHarness = {
  camera: THREE.PerspectiveCamera;
  _cameraClampCorrectionKm: number;
  cameraController: { focusBody: unknown; controls: { target: THREE.Vector3 } };
  clampCameraAboveSurfaces(options?: { cubeOnly?: boolean; resetCorrection?: boolean }): boolean;
};

function fixture(cube = true) {
  let radiusKm = 100;
  let settled = true;
  const navigation = vi.fn(() => ({ radiusKm, settled }));
  const body = {
    body: { name: 'Mars', geometryType: 'Globe', geometryData: {} },
    position: new THREE.Vector3(), mesh: { quaternion: new THREE.Quaternion() },
    displayRadius: 100, hasTerrain: true, terrainCubeStats: cube ? {} : null,
    terrainBodyFixedToGeodetic: () => ({ latDeg: 0, lonDeg: 0 }),
    terrainNavigationSurface: navigation,
  };
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(100.05, 0, 0);
  const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
    camera, scaleFactor: 1, cameraController: { focusBody: null, controls: { target: new THREE.Vector3(100, 0, 0) } },
    bodyMeshes: new Map([['Mars', body]]), _terrainClampCache: new Map(), _renderDebugFrame: 0,
    _cameraClampCorrectionKm: 0,
  }) as ClampHarness;
  return { renderer, navigation, select: (radius: number, ready = true) => { radiusKm = radius; settled = ready; } };
}

describe('camera clearance after terrain selection', () => {
  it('recovers a parked rover close-up after transient coarse terrain refines', () => {
    const { renderer, select } = fixture();
    renderer.cameraController.focusBody = { body: { parentName: 'Mars', geometryData: { surfaceLock: true } } };
    select(101, false);
    renderer.clampCameraAboveSurfaces();
    expect(renderer.camera.position.length()).toBeCloseTo(101.002, 10);
    select(100, true);
    renderer.clampCameraAboveSurfaces();
    expect(renderer.camera.position.length()).toBeCloseTo(100.05, 10);
  });

  it('never restores a reserved camera below newly established physical ground', () => {
    const { renderer, select } = fixture();
    renderer.cameraController.focusBody = { body: { parentName: 'Mars', geometryData: { surfaceLock: true } } };
    select(101, false); renderer.clampCameraAboveSurfaces();
    select(100.1, true); renderer.clampCameraAboveSurfaces();
    expect(renderer.camera.position.length()).toBeCloseTo(100.102, 10);
  });

  it.each(['camera', 'target', 'focus'] as const)('cancels recovery after %s input', input => {
    const { renderer, select } = fixture();
    renderer.cameraController.focusBody = { body: { parentName: 'Mars', geometryData: { surfaceLock: true } } };
    select(101, false); renderer.clampCameraAboveSurfaces();
    if (input === 'camera') renderer.camera.position.y += .01;
    if (input === 'target') renderer.cameraController.controls.target.y += .01;
    if (input === 'focus') renderer.cameraController.focusBody = null;
    const before = renderer.camera.position.clone();
    select(100, true); renderer.clampCameraAboveSurfaces();
    expect(renderer.camera.position.distanceTo(before)).toBe(0);
  });

  it('accounts for a newly visible coarse triangle in the same frame', () => {
    const { renderer, navigation, select } = fixture();
    expect(renderer.clampCameraAboveSurfaces()).toBe(false);
    // Streaming exposes an ancestor 300 m above the independent physical grid.
    select(100.3);
    expect(renderer.clampCameraAboveSurfaces({ cubeOnly: true, resetCorrection: false })).toBe(true);
    expect(renderer.camera.position.length()).toBeCloseTo(100.302, 10);
    expect(renderer._cameraClampCorrectionKm).toBeCloseTo(.252, 10);
    expect(navigation).toHaveBeenCalledTimes(2); // no previous-frame scalar cache
  });

  it('preserves the larger earlier correction in the frame diagnostic', () => {
    const { renderer, select } = fixture();
    renderer._cameraClampCorrectionKm = .5;
    select(100.3);
    renderer.clampCameraAboveSurfaces({ cubeOnly: true, resetCorrection: false });
    expect(renderer._cameraClampCorrectionKm).toBe(.5);
  });

  it('does not resample non-cube bodies in the post-selection pass', () => {
    const { renderer, navigation, select } = fixture(false);
    select(100.3);
    expect(renderer.clampCameraAboveSurfaces({ cubeOnly: true, resetCorrection: false })).toBe(false);
    expect(navigation).not.toHaveBeenCalled();
    expect(renderer.camera.position.length()).toBe(100.05);
  });
});
