import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { UniverseRenderer } from '../UniverseRenderer.js';

/** Run the renderer's real clamp without constructing a WebGL context. */
function setup() {
  const R = 1737.4;
  let elevation = -5.3, longitude = 0, revision = 1;
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(R + elevation + 0.002, 0, 0);
  const bm = {
    body: { name: 'Moon', geometryType: 'Globe' }, position: new THREE.Vector3(), displayRadius: R,
    mesh: { quaternion: new THREE.Quaternion() }, hasTerrain: true,
    get terrainRevision() { return revision; },
    terrainBodyFixedToGeodetic: () => ({ latDeg: 0, lonDeg: longitude }),
    terrainReferenceRadiusAt: () => R,
    sampleTerrainBodyFixed: () => ({ elevationKm: elevation }),
  };
  const state = { camera, cameraController: { focusBody: null }, scaleFactor: 1,
    bodyMeshes: new Map([['Moon', bm]]), _terrainClampCache: new Map(), _renderDebugFrame: 1 };
  const clamp = () => (UniverseRenderer.prototype as unknown as { clampCameraAboveSurfaces(): void }).clampCameraAboveSurfaces.call(state);
  return { camera, clamp, R, change: (h: number, lon: number, rev: number) => { elevation = h; longitude = lon; revision = rev; } };
}

describe('terrain clamp during surface navigation', () => {
  it('samples the new flight location immediately, before the five-frame cache expires', () => {
    const { camera, clamp, R, change } = setup();
    clamp();
    change(-4.3, 0.001, 1);
    clamp();
    expect(camera.position.length() - R).toBeCloseTo(-4.298, 9);
  });

  it('samples newly decoded terrain immediately at the same location', () => {
    const { camera, clamp, R, change } = setup();
    clamp();
    change(-5.2, 0, 2);
    clamp();
    expect(camera.position.length() - R).toBeCloseTo(-5.198, 9);
  });
});
