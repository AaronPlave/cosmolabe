/**
 * Regression guard for camera-mode orientation (Body-Fixed / SC-Locked / Surface).
 *
 * These "locked-to-body" modes must orient the camera with the SAME body→world
 * quaternion BodyMesh renders the mesh with — `composeBodyToWorldQuat(rotationAt,
 * sourceFrame)` — so the surface stays fixed under the camera. They used to
 * conjugate `rotationAt` directly (`[-x,-y,-z,w]`), skipping the
 * EquatorJ2000→EclipticJ2000 obliquity, so for a planet/moon with an
 * EquatorJ2000 rotation source the camera sat ~23.4° off the (ecliptic) mesh
 * whenever the SPICE pxform path wasn't taken (SPICE-free demos, CK gaps, TLE).
 * `bodyWorldOrientation` is the shared fix; this test pins its behavior without
 * needing SPICE or WebGL.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { composeBodyToWorldQuat } from '@cosmolabe/core';
import type { Quaternion } from '@cosmolabe/core';
import { bodyWorldOrientation } from '../CameraModes.js';
import type { BodyMesh } from '../../BodyMesh.js';

const OBLIQUITY_DEG = 23.4392911;
const OBLIQUITY_RAD = (OBLIQUITY_DEG * Math.PI) / 180;

/** Minimal BodyMesh stub — the helper only reads body.rotation + body.rotationAt. */
function fakeBodyMesh(sourceFrame: string | null, q: Quaternion | undefined): BodyMesh {
  const rotation = sourceFrame == null ? undefined : { sourceFrame };
  return {
    body: {
      rotation,
      rotationAt: () => q,
    },
  } as unknown as BodyMesh;
}

/** The pre-fix orientation: conjugate of source→body, with NO frame alignment. */
function legacyConjugate(q: Quaternion): THREE.Quaternion {
  return new THREE.Quaternion(-q[1], -q[2], -q[3], q[0]);
}

describe('bodyWorldOrientation (camera-mode body→world)', () => {
  // A representative spin: 40° about an off-axis direction so the obliquity
  // genuinely reorients the result (not just relabels an X-aligned vector).
  const axis = new THREE.Vector3(0.3, 0.4, 0.866).normalize();
  const spin = new THREE.Quaternion().setFromAxisAngle(axis, (40 * Math.PI) / 180);
  // RotationModel quaternions are [w, x, y, z]; THREE is (x, y, z, w).
  const sourceToBody: Quaternion = [spin.w, spin.x, spin.y, spin.z];

  it('matches BodyMesh exactly: composeBodyToWorldQuat in THREE order', () => {
    const out = new THREE.Quaternion();
    const got = bodyWorldOrientation(fakeBodyMesh('EquatorJ2000', sourceToBody), 0, out)!;
    const e = composeBodyToWorldQuat(sourceToBody, 'EquatorJ2000');
    const expected = new THREE.Quaternion(e[1], e[2], e[3], e[0]);
    expect(got.angleTo(expected)).toBeLessThan(1e-9);
  });

  it('carries the J2000 obliquity for an EquatorJ2000-source body (the regression)', () => {
    const got = bodyWorldOrientation(
      fakeBodyMesh('EquatorJ2000', sourceToBody), 0, new THREE.Quaternion(),
    )!;
    // The old conjugate-only fallback differs from the correct orientation by
    // exactly the EquatorJ2000→EclipticJ2000 obliquity (~23.44°).
    const legacy = legacyConjugate(sourceToBody);
    expect(got.angleTo(legacy)).toBeCloseTo(OBLIQUITY_RAD, 6);
  });

  it('applies no rotation for an EclipticJ2000-source body (already world frame)', () => {
    const got = bodyWorldOrientation(
      fakeBodyMesh('EclipticJ2000', sourceToBody), 0, new THREE.Quaternion(),
    )!;
    // World == source here, so it equals the plain conjugate (no obliquity).
    const legacy = legacyConjugate(sourceToBody);
    expect(got.angleTo(legacy)).toBeLessThan(1e-9);
  });

  it('returns null when the body has no rotation model (mesh is not oriented)', () => {
    expect(bodyWorldOrientation(fakeBodyMesh(null, undefined), 0, new THREE.Quaternion())).toBeNull();
    // Rotation present but rotationAt yields nothing (e.g. coverage gap) → null.
    expect(bodyWorldOrientation(fakeBodyMesh('EquatorJ2000', undefined), 0, new THREE.Quaternion())).toBeNull();
  });
});
