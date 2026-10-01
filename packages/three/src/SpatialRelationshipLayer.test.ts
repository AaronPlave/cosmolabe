import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { anglePoints, directionHeadLength } from './SpatialRelationshipLayer.js';

describe('measurement geometry', () => {
  it('uses finite independent segments and draws the arc for a straight angle', () => {
    const vertex = new THREE.Vector3();
    const points = anglePoints(new THREE.Vector3(1, 0, 0), vertex, new THREE.Vector3(-1, 0, 0));
    expect(points.length).toBe(40);
    expect(points.every(p => p.toArray().every(Number.isFinite))).toBe(true);
    expect(points.slice(4).some(p => Math.abs(p.z) > 0.1 || Math.abs(p.y) > 0.1)).toBe(true);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    geometry.computeBoundingSphere();
    expect(Number.isFinite(geometry.boundingSphere!.radius)).toBe(true);
  });

  it('scales arrowheads at target depth and limits short or clipped segments', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10000);
    camera.updateMatrixWorld();
    const nearTarget = new THREE.Vector3(0, 0, -1);
    const farTarget = new THREE.Vector3(0, 0, -100);
    const head = directionHeadLength(camera, nearTarget, 1000, 600);
    expect(directionHeadLength(camera, farTarget, 1000, 600)).toBeCloseTo(head * 100);
    expect(head / (2 * Math.tan(Math.PI / 6) / 600)).toBeCloseTo(9);
    expect(directionHeadLength(camera, nearTarget, 0.001, 600)).toBe(0.0003);
    expect(directionHeadLength(camera, new THREE.Vector3(0, 0, 1), 1000, 600)).toBe(0);
  });
});
