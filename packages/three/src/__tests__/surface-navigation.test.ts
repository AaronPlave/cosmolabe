import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyFixedToMeshLocal, meshLocalToBodyFixed, surfacePoseFromBodyFixed, zoomTowardSurfacePoint } from '../SurfaceNavigation.js';
import type { BodyMesh } from '../BodyMesh.js';
import type { SurfacePoint } from '../SceneHit.js';

const point = (p: [number, number, number]) => ({ bodyName: 'Moon', bodyFixedPositionKm: p } as unknown as SurfacePoint);

describe('surface navigation helpers', () => {
  it('map body-fixed Z-up to the Y-up mesh frame and back', () => {
    const v = bodyFixedToMeshLocal([1, 2, 3], 1e-3);
    expect(v.toArray()).toEqual([0.001, 0.003, -0.002]);
    const back = meshLocalToBodyFixed(v, 1e-3);
    back.forEach((x, i) => expect(x).toBeCloseTo([1, 2, 3][i], 12));
    // The north pole of the body is +Y in the mesh frame.
    expect(bodyFixedToMeshLocal([0, 0, 1], 1).toArray()).toEqual([0, 1, -0]);
    const pose = surfacePoseFromBodyFixed({ eyeKm: [0, 0, 2], targetKm: [0, 0, 1], upKm: [5, 0, 0] }, 2);
    expect(pose.position.y).toBe(4);
    expect(pose.up.length()).toBeCloseTo(1, 12);
  });

  it('zooms along the line of sight toward the picked point', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
    const bm = { body: { name: 'Moon' }, position: new THREE.Vector3(10, 0, 0), mesh: { quaternion: q } } as unknown as BodyMesh;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(10, 0, 3000);
    const pose = zoomTowardSurfacePoint(bm, camera, point([0, -1737, 0]), 1)!;
    const world = (v: THREE.Vector3) => v.clone().applyQuaternion(q).add(bm.position);
    const p = world(pose.target), e = world(pose.position);
    // Same view direction, a quarter of the range.
    const before = camera.position.clone().sub(p);
    const after = e.clone().sub(p);
    expect(after.length()).toBeCloseTo(before.length() / 4, 6);
    expect(after.normalize().dot(before.normalize())).toBeCloseTo(1, 9);
    expect(zoomTowardSurfacePoint(bm, camera, { ...point([0, 0, 1]), bodyName: 'Mars' } as SurfacePoint, 1)).toBeNull();
  });
});
