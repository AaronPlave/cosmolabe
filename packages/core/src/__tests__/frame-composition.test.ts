/**
 * Frame-composition consistency tests — the keystone guard against the
 * "two offsetting bugs that cancel" failure mode that broke Saturn's moons
 * (see Universe.absolutePositionOf comment re: pre-Phase-3 masking).
 *
 * The EquatorJ2000 ↔ EclipticJ2000 obliquity rotation is encoded TWICE:
 *   - position side: `alignPositionToFrame` (matrix form) — drives body POSITION
 *   - rotation side: `frameAlignmentQuat` (quaternion form) — drives body ORIENTATION
 * If these two ever disagree, positions and orientations diverge and the
 * composed scene tilts even though each piece "looks fine" in isolation.
 * These tests pin the two encodings to each other and to the conventions
 * BodyMesh relies on.
 */
import { describe, it, expect } from 'vitest';
import {
  alignPositionToFrame,
  rotateVecByQuat,
  frameAlignmentQuat,
  multiplyQuat,
  composeBodyToWorldQuat,
  type Vec3,
} from '../kinematics.js';
import type { Quaternion } from '../rotations/RotationModel.js';

// The IAU 1976 value written out independently of src/constants.ts (84381.448
// arcsec exactly), so this test still fails if that constant is ever wrong.
const OBLIQUITY_DEG = 84381.448 / 3600;

function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const na = Math.hypot(a[0], a[1], a[2]);
  const nb = Math.hypot(b[0], b[1], b[2]);
  return (Math.acos(Math.min(1, Math.max(-1, dot / (na * nb)))) * 180) / Math.PI;
}

describe('obliquity-consistency: position vs rotation encodings agree', () => {
  // A spread of vectors, including off-axis ones where a sign/magnitude error
  // in either encoding would surface.
  const vectors: Vec3[] = [
    [0, 185520, 0], // Saturn-moon-scale, purely in the rotated plane
    [1, 0, 0], // along the rotation axis → must be invariant
    [0, 1, 0],
    [0, 0, 1],
    [3, -4, 5],
    [-100000, 250000, -75000],
  ];

  for (const v of vectors) {
    it(`Equator→Ecliptic: alignPositionToFrame == rotateVecByQuat(frameAlignmentQuat) for [${v}]`, () => {
      const viaMatrix = alignPositionToFrame(v, 'EquatorJ2000', 'EclipticJ2000');
      const viaQuat = rotateVecByQuat(v, frameAlignmentQuat('EquatorJ2000', 'EclipticJ2000'));
      expect(viaQuat[0]).toBeCloseTo(viaMatrix[0], 9);
      expect(viaQuat[1]).toBeCloseTo(viaMatrix[1], 9);
      expect(viaQuat[2]).toBeCloseTo(viaMatrix[2], 9);
    });

    it(`Ecliptic→Equator: alignPositionToFrame == rotateVecByQuat(frameAlignmentQuat) for [${v}]`, () => {
      const viaMatrix = alignPositionToFrame(v, 'EclipticJ2000', 'EquatorJ2000');
      const viaQuat = rotateVecByQuat(v, frameAlignmentQuat('EclipticJ2000', 'EquatorJ2000'));
      expect(viaQuat[0]).toBeCloseTo(viaMatrix[0], 9);
      expect(viaQuat[1]).toBeCloseTo(viaMatrix[1], 9);
      expect(viaQuat[2]).toBeCloseTo(viaMatrix[2], 9);
    });
  }

  it('the obliquity rotation is exactly the IAU 1976 J2000 mean obliquity (84381.448 arcsec)', () => {
    // A vector along +Z (ecliptic) maps to a vector 23.44° off +Z in equator.
    const z: Vec3 = [0, 0, 1];
    const rotated = alignPositionToFrame(z, 'EclipticJ2000', 'EquatorJ2000');
    expect(angleBetweenDeg(z, rotated)).toBeCloseTo(OBLIQUITY_DEG, 5);
  });

  it('the X axis is invariant under the obliquity rotation (rotation is about +X)', () => {
    const x: Vec3 = [1, 0, 0];
    const r = rotateVecByQuat(x, frameAlignmentQuat('EquatorJ2000', 'EclipticJ2000'));
    expect(angleBetweenDeg(x, r)).toBeCloseTo(0, 9);
  });

  it('Equator→Ecliptic and Ecliptic→Equator alignments are inverses', () => {
    const v: Vec3 = [12345, -6789, 4242];
    const round = rotateVecByQuat(
      rotateVecByQuat(v, frameAlignmentQuat('EquatorJ2000', 'EclipticJ2000')),
      frameAlignmentQuat('EclipticJ2000', 'EquatorJ2000'),
    );
    expect(round[0]).toBeCloseTo(v[0], 6);
    expect(round[1]).toBeCloseTo(v[1], 6);
    expect(round[2]).toBeCloseTo(v[2], 6);
  });
});

describe('frameAlignmentQuat: pass-through frames return identity', () => {
  const identity: Quaternion = [1, 0, 0, 0];
  for (const [src, dst] of [
    ['EclipticJ2000', 'EclipticJ2000'],
    ['EquatorJ2000', 'J2000'], // same family, different spelling
    ['ICRF', 'EME2000'], // same family, different spelling
    ['IAU_MOON', 'EclipticJ2000'], // SPICE frame — no analytic conversion
    ['MOON_ME', 'EclipticJ2000'],
  ] as const) {
    it(`${src} → ${dst} is identity`, () => {
      const q = frameAlignmentQuat(src, dst);
      expect(q).toEqual(identity);
    });
  }
});

describe('composeBodyToWorldQuat: conventions match BodyMesh', () => {
  it('with an ECLIPJ2000-sourced rotation, body→world == conjugate(rotationAt)', () => {
    // rotationAt returns source→body; with source already the world frame the
    // frame alignment is identity, so body→world is just the conjugate.
    const rot: Quaternion = [Math.cos(0.3), 0, 0, Math.sin(0.3)]; // spin about Z
    const bw = composeBodyToWorldQuat(rot, 'ECLIPJ2000');
    const expected: Quaternion = [rot[0], -rot[1], -rot[2], -rot[3]];
    // componentwise (toEqual distinguishes -0 from +0; the math doesn't)
    for (let i = 0; i < 4; i++) expect(bw[i]).toBeCloseTo(expected[i], 12);
  });

  it('with an EquatorJ2000-sourced rotation, body→world == frameAlign ∘ conjugate', () => {
    const rot: Quaternion = [Math.cos(0.5), Math.sin(0.5), 0, 0];
    const expected = multiplyQuat(
      frameAlignmentQuat('EquatorJ2000', 'EclipticJ2000'),
      [rot[0], -rot[1], -rot[2], -rot[3]],
    );
    const bw = composeBodyToWorldQuat(rot, 'EquatorJ2000');
    for (let i = 0; i < 4; i++) expect(bw[i]).toBeCloseTo(expected[i], 12);
  });

  it("an EquatorJ2000-sourced body pole lands 23.44° off the ecliptic pole", () => {
    // Identity rotation (body axes == source axes). The body +Z pole, expressed
    // in EquatorJ2000, must appear tilted by the obliquity in EclipticJ2000 —
    // exactly the Earth/Saturn celestial-pole-vs-ecliptic-pole case.
    const identityRot: Quaternion = [1, 0, 0, 0];
    const bw = composeBodyToWorldQuat(identityRot, 'EquatorJ2000');
    const poleInWorld = rotateVecByQuat([0, 0, 1], bw);
    expect(angleBetweenDeg([0, 0, 1], poleInWorld)).toBeCloseTo(OBLIQUITY_DEG, 5);
  });
});
