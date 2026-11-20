// The instrument view rendered streamed lunar terrain black: baked imagery's
// terminator gate reads the body centre in *view space* (a uniform the terrain
// update sets for the main camera), so the instrument's own pass computed every
// fragment's local "up" from the main camera's origin and gated the imagery to
// its night floor. The terrain must re-aim that uniform at whichever camera draws.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TerrainManager } from '../TerrainManager.js';
import { createSurfaceAsIsUniforms } from '../SurfaceIllumination.js';

function camera(position: THREE.Vector3, lookAt: THREE.Vector3) {
  const c = new THREE.PerspectiveCamera(30, 1, 1e-9, 10);
  c.position.copy(position);
  c.lookAt(lookAt);
  c.updateMatrixWorld();
  return c;
}

describe('terrain shading state per camera', () => {
  it('re-aims the terminator gate at the instrument camera, and back', () => {
    const body = new THREE.Vector3(0, 0, 0);
    const main = camera(new THREE.Vector3(0.002, 0, 0), body);
    const instrument = camera(new THREE.Vector3(0, 0.0017, 0.0002), new THREE.Vector3(0, 0, 0.0002));
    const tm = Object.assign(Object.create(TerrainManager.prototype), {
      asIs: createSurfaceAsIsUniforms(), bakedNightFloor: 0.03, gateBodyWorldPos: null,
    }) as unknown as { asIs: ReturnType<typeof createSurfaceAsIsUniforms>; setViewCamera(c: THREE.Camera): void; updateTerminatorGate(c: THREE.Camera, p: THREE.Vector3): void };
    tm.updateTerminatorGate(main, body);
    const inView = (c: THREE.Camera) => body.clone().applyMatrix4(c.matrixWorldInverse);
    expect(tm.asIs.centerView.value.distanceTo(inView(main))).toBeLessThan(1e-12);
    tm.setViewCamera(instrument);
    expect(tm.asIs.centerView.value.distanceTo(inView(instrument))).toBeLessThan(1e-12);
    expect(tm.asIs.centerView.value.distanceTo(inView(main))).toBeGreaterThan(1e-4);
    tm.setViewCamera(main);
    expect(tm.asIs.centerView.value.distanceTo(inView(main))).toBeLessThan(1e-12);
  });
});
