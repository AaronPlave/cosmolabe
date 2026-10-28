import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { UniverseRenderer } from '../UniverseRenderer.js';

type ClampHarness = {
  camera: THREE.PerspectiveCamera;
  _cameraClampCorrectionKm: number;
  clampCameraAboveSurfaces(options?: { cubeOnly?: boolean; resetCorrection?: boolean }): boolean;
};

function fixture(cube = true) {
  let radiusKm = 100;
  const navigation = vi.fn(() => ({ radiusKm }));
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
    camera, scaleFactor: 1, cameraController: { focusBody: null },
    bodyMeshes: new Map([['Mars', body]]), _terrainClampCache: new Map(), _renderDebugFrame: 0,
    _cameraClampCorrectionKm: 0,
  }) as ClampHarness;
  return { renderer, navigation, select: (radius: number) => { radiusKm = radius; } };
}

describe('camera clearance after terrain selection', () => {
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
