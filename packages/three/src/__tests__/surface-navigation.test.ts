import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseCoordinatePair, pointFrameRangeKm } from '@cosmolabe/core';
import {
  bodyFixedToMeshLocal, meshLocalToBodyFixed, surfaceNavigable, surfacePoseFromBodyFixed, zoomTowardSurfacePoint,
  frameSurfacePoint, surfacePointCoordinatePair,
} from '../SurfaceNavigation.js';
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

  it('is not offered for a DSK pick, whose frame is the rotated shape model\'s', () => {
    // 67P-like: the model container turned away from the globe mesh frame.
    const model = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.1);
    const bm = {
      body: { name: '67P' }, position: new THREE.Vector3(), mesh: { quaternion: new THREE.Quaternion() },
      bodyToWorldQuaternion: (out: THREE.Quaternion) => out.copy(model),
    } as unknown as BodyMesh;
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 20);
    const dsk = { bodyName: '67P', bodyFixedPositionKm: [0, 0, 2], source: 'dsk' } as unknown as SurfacePoint;
    expect(surfaceNavigable(dsk)).toBe(false);
    expect(zoomTowardSurfacePoint(bm, camera, dsk, 1)).toBeNull();
    expect(surfaceNavigable({ source: 'terrain' })).toBe(true);
  });
});

describe('Frame here', () => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
  const bm = { body: { name: 'Moon' }, position: new THREE.Vector3(10, 0, 0), mesh: { quaternion: q } } as unknown as BodyMesh;
  const world = (v: THREE.Vector3) => v.clone().applyQuaternion(q).add(bm.position);
  const place = (camera: THREE.Camera, pose: { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 }) => {
    camera.position.copy(world(pose.position));
    camera.up.copy(pose.up).applyQuaternion(q);
  };

  it('lands at the fixed range along the line of sight, and does not move when repeated', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(10, 400, 3000);
    const range = pointFrameRangeKm(1737.4);
    const first = frameSurfacePoint(bm, camera, point([0, -1737, 0]), 1, range)!;
    const p = world(first.target);
    const before = camera.position.clone().sub(p).normalize();
    expect(world(first.position).distanceTo(p)).toBeCloseTo(range, 9);
    expect(world(first.position).sub(p).normalize().dot(before)).toBeCloseTo(1, 9);
    for (let i = 0; i < 3; i++) {
      place(camera, first);
      const again = frameSurfacePoint(bm, camera, point([0, -1737, 0]), 1, range)!;
      expect(again.position.distanceTo(first.position)).toBeLessThan(1e-9);
      expect(again.up.distanceTo(first.up)).toBeLessThan(1e-9);
    }
  });

  it('pulls back along the same ray from nearer than the range', () => {
    const camera = new THREE.PerspectiveCamera();
    const target = world(bodyFixedToMeshLocal([0, -1737, 0], 1));
    camera.position.copy(target).add(new THREE.Vector3(0.3, 0.2, 0.1));
    const pose = frameSurfacePoint(bm, camera, point([0, -1737, 0]), 1, 17.374)!;
    expect(world(pose.position).distanceTo(target)).toBeCloseTo(17.374, 9);
    expect(world(pose.position).sub(target).normalize().dot(camera.position.clone().sub(target).normalize())).toBeCloseTo(1, 9);
  });

  it('is incremental only for Zoom to here', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(10, 400, 3000);
    const target = world(bodyFixedToMeshLocal([0, -1737, 0], 1));
    const ranges: number[] = [];
    for (let i = 0; i < 3; i++) {
      const pose = zoomTowardSurfacePoint(bm, camera, point([0, -1737, 0]), 1)!;
      place(camera, pose);
      ranges.push(camera.position.distanceTo(target));
    }
    expect(ranges[1]).toBeCloseTo(ranges[0] / 4, 6);
    expect(ranges[2]).toBeCloseTo(ranges[1] / 4, 6);
  });

  it('refuses a bad range, a DSK pick and another body', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(10, 0, 3000);
    expect(frameSurfacePoint(bm, camera, point([0, -1737, 0]), 1, 0)).toBeNull();
    expect(frameSurfacePoint(bm, camera, { ...point([0, 0, 1]), source: 'dsk' } as SurfacePoint, 1, 5)).toBeNull();
    expect(frameSurfacePoint(bm, camera, { ...point([0, 0, 1]), bodyName: 'Mars' } as SurfacePoint, 1, 5)).toBeNull();
  });
});

describe('surfacePointCoordinatePair', () => {
  const A = 6378.137, B = 6356.752;
  /** A pick on Earth's ellipsoid at geodetic `latDeg`, `lonDeg`. */
  const earthPick = (latDeg: number, lonDeg: number, resolutionDeg: number) => {
    const phi = latDeg * Math.PI / 180, lam = lonDeg * Math.PI / 180;
    const n = A * A / Math.sqrt(A * A * Math.cos(phi) ** 2 + B * B * Math.sin(phi) ** 2);
    return {
      bodyName: 'Earth', source: 'ellipsoid', latDeg, lonDeg, latitudeKind: 'geodetic',
      bodyFixedPositionKm: [n * Math.cos(phi) * Math.cos(lam), n * Math.cos(phi) * Math.sin(lam), (B * B) / (A * A) * n * Math.sin(phi)],
      hit: { heightKm: 0, datum: { referenceShape: { kind: 'ellipsoid', radiiKm: [A, A, B] }, verticalDatum: 'ellipsoid', heightConvention: 'normal', origin: 'body-shape' } },
      resolution: { surfaceKm: 0.01, latDeg: resolutionDeg, lonDeg: resolutionDeg },
    } as unknown as SurfacePoint;
  };

  it('copies a hemisphere-lettered pair, to the pick\'s precision, that pastes back to the same place', () => {
    const pick = earthPick(45, -77.0366, 1e-4);
    const text = surfacePointCoordinatePair(pick);
    // Planetocentric: 45° geodetic is 44.8076° from the centre.
    expect(text).toBe('44.8076° N, 77.0366° W');
    const parsed = parseCoordinatePair(text, { order: 'lat-lon', direction: 'east' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [x, y, z] = pick.bodyFixedPositionKm;
    expect(parsed.latDeg).toBeCloseTo(Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, 4);
    expect(parsed.lonDeg).toBeCloseTo(-77.0366, 4);
    // Lon-first input order still reads it right: the letters say which is which.
    const lonFirst = parseCoordinatePair(text, { order: 'lon-lat', direction: 'east' });
    expect(lonFirst.ok && lonFirst.latDeg).toBeCloseTo(44.8076, 4);
  });

  it('keeps no more digits than the pick resolves, and wraps longitude to ±180', () => {
    expect(surfacePointCoordinatePair({ ...earthPick(0, 200, 0.05) })).toBe('0.00° N, 160.00° W');
  });
});
