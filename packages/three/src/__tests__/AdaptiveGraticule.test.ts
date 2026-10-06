import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory, bodySurfaceCoordinates, surfacePositionToBodyFixed } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { normalizeGridSettings } from '@cosmolabe/control';
import { chooseGridStep, GRID_STEPS } from '../AdaptiveGraticule.js';

describe('adaptive graticule', () => {
  it('keeps zoom noise inside hysteresis and bounds extreme regional density', () => {
    expect(chooseGridStep(10, 10)).toBe(10);
    expect(chooseGridStep(11, 10)).toBe(10);
    expect(chooseGridStep(10, 30)).toBe(10);
    expect(chooseGridStep(0.001)).toBe(30);
    expect(chooseGridStep(1e9)).toBe(0.001);
    for (let p = 0.1; p < 1e6; p *= 1.2) expect(GRID_STEPS).toContain(chooseGridStep(p));
  });
  it('refines a screen-filling regional view without a global geometry lattice', () => {
    const body = new Body({ name: 'Region', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [100, 100, 100], geometryType: 'Globe',
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => [1, 0, 0, 0] } });
    const bm = new BodyMesh(body);
    bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
    camera.position.set(100.1, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(100, 0, 0); camera.updateMatrixWorld(true);
    bm.showGrid(true, false, normalizeGridSettings());
    bm.updateGrid(camera, { width: 800, height: 800 }, null);
    expect(bm.gridMetrics!.latitudeStep).toBeLessThan(1);
    expect(bm.gridMetrics!.longitudeStep).toBeLessThan(1);
    expect(bm.gridMetrics!.candidates).toBeLessThanOrEqual(96);
    expect(bm.gridMetrics!.labels).toBe(0);
    // No Line objects or tessellated grid buffers: surface material carries the lattice.
    expect(bm.children.some(child => child instanceof THREE.Line)).toBe(false);
    bm.dispose();
  });
  it('round-trips body coordinates with or without a rotation model and ignores model pre-rotation', () => {
    for (const rotation of [undefined, { sourceFrame: 'ECLIPJ2000', rotationAt: () => [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number] }]) {
      const body = new Body({ name: 'Fixture', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [2, 2, 1], geometryType: 'Globe', rotation });
      const bm = new BodyMesh(body);
      bm.updatePosition([0, 0, 0], 0, 1);
      const c = bodySurfaceCoordinates(body)!;
      const fixed = surfacePositionToBodyFixed({ latDeg: 45, lonDeg: 90 }, c);
      const p = new THREE.Vector3(fixed.xKm, fixed.yKm, fixed.zKm);
      const q = bm.bodyToWorldQuaternion(new THREE.Quaternion());
      expect(p.clone().applyQuaternion(q).applyQuaternion(q.clone().invert()).distanceTo(p)).toBeLessThan(1e-12);
      if (rotation) {
        const before = q.clone();
        bm.meshRotationQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
        bm.updatePosition([0, 0, 0], 0, 1);
        expect(before.angleTo(bm.bodyToWorldQuaternion(q))).toBeLessThan(1e-7);
      }
      bm.dispose();
    }
  });
});
