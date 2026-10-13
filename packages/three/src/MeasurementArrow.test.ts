import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MeasurementArrow } from './MeasurementArrow.js';

describe('annotation arrowhead', () => {
  it('owns a smooth closed cone with its tip and base matching the shaft junction', () => {
    const arrow = new MeasurementArrow();
    expect(arrow.cone.geometry.parameters.radialSegments).toBe(24);
    expect(arrow.cone.geometry.parameters.openEnded).toBe(false);
    arrow.setLength(88, 13, 13 * 0.65);
    for (const direction of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(1e-8, 0, 1).normalize()]) {
      arrow.setDirection(direction); arrow.updateMatrixWorld(true);
      const tip = new THREE.Vector3(0, 0, 0).applyMatrix4(arrow.cone.matrixWorld);
      const base = new THREE.Vector3(0, -1, 0).applyMatrix4(arrow.cone.matrixWorld);
      expect(tip.distanceTo(direction.clone().multiplyScalar(88))).toBeLessThan(1e-10);
      expect(base.distanceTo(direction.clone().multiplyScalar(75))).toBeLessThan(1e-10);
    }
    arrow.dispose();
  });
  it('disposes owned resources once without invalidating another arrow or shared helper geometry', () => {
    const a = new MeasurementArrow(), b = new MeasurementArrow(), helper = new THREE.ArrowHelper();
    expect(a.cone.geometry).not.toBe(b.cone.geometry);
    expect(a.cone.geometry).not.toBe(helper.cone.geometry);
    expect(a.outline.geometry).toBe(a.cone.geometry);
    let own = 0, other = 0;
    for (const resource of [a.cone.geometry, a.cone.material, a.outline.material]) resource.addEventListener('dispose', () => own++);
    for (const resource of [b.cone.geometry, b.cone.material, helper.cone.geometry]) resource.addEventListener('dispose', () => other++);
    a.dispose(); expect(own).toBe(3); expect(other).toBe(0);
    b.dispose(); helper.dispose();
  });
});
