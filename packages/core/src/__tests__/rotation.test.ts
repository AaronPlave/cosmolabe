import { describe, it, expect } from 'vitest';
import { UniformRotation } from '../rotations/UniformRotation.js';

/** Rotate a vector by a quaternion: q * v * q^-1 (q rotates inertial → body-fixed) */
function rotateByConjugate(q: [number, number, number, number], v: [number, number, number]): [number, number, number] {
  // Apply q^-1 * v * q (body-fixed → inertial)
  const [w, x, y, z] = q;
  // q^-1 = [w, -x, -y, -z] (conjugate, since unit quaternion)
  const qw = w, qx = -x, qy = -y, qz = -z;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

describe('UniformRotation', () => {
  it('pole direction is preserved by the rotation', () => {
    // poleRA=0, poleDec=π/2 → pole at inertial +Z
    const rot = new UniformRotation(86400, 0, 0, 0, Math.PI / 2);
    const q = rot.rotationAt(0);
    // Body-fixed Z (pole) mapped to inertial space should give [0, 0, 1]
    const pole = rotateByConjugate(q as [number, number, number, number], [0, 0, 1]);
    expect(pole[0]).toBeCloseTo(0, 5);
    expect(pole[1]).toBeCloseTo(0, 5);
    expect(pole[2]).toBeCloseTo(1, 5);
  });

  it('tilted pole points in the correct direction', () => {
    // Jupiter-like: inclination=25.57°, ascendingNode=358.05°
    // → poleDec = 64.43°, poleRA = 268.05°
    const poleRA = 268.05 * Math.PI / 180;
    const poleDec = 64.43 * Math.PI / 180;
    const rot = new UniformRotation(86400, 0, 0, poleRA, poleDec);
    const q = rot.rotationAt(0);
    // Body-fixed Z mapped to inertial should match the pole direction
    const pole = rotateByConjugate(q as [number, number, number, number], [0, 0, 1]);
    const expectedPole = [
      Math.cos(poleDec) * Math.cos(poleRA),
      Math.cos(poleDec) * Math.sin(poleRA),
      Math.sin(poleDec),
    ];
    expect(pole[0]).toBeCloseTo(expectedPole[0], 4);
    expect(pole[1]).toBeCloseTo(expectedPole[1], 4);
    expect(pole[2]).toBeCloseTo(expectedPole[2], 4);
  });

  it('returns to same orientation after full period', () => {
    const period = 86400;
    const rot = new UniformRotation(period, 0, 0, 0, Math.PI / 2);
    const q0 = rot.rotationAt(0);
    const q1 = rot.rotationAt(period);
    // After full period, quaternion may differ by sign (double cover) but represents same rotation
    const sameSign = Math.sign(q0[0]) === Math.sign(q1[0]);
    const factor = sameSign ? 1 : -1;
    expect(q1[0] * factor).toBeCloseTo(q0[0], 3);
    expect(q1[1] * factor).toBeCloseTo(q0[1], 3);
    expect(q1[2] * factor).toBeCloseTo(q0[2], 3);
    expect(q1[3] * factor).toBeCloseTo(q0[3], 3);
  });

  it('spins correctly: pole stays fixed while equator rotates', () => {
    const period = 86400;
    const rot = new UniformRotation(period, 0, 0, 0, Math.PI / 2); // pole at +Z
    const q0 = rot.rotationAt(0) as [number, number, number, number];
    const qHalf = rot.rotationAt(period / 2) as [number, number, number, number];
    // Pole direction should be the same at both times
    const pole0 = rotateByConjugate(q0, [0, 0, 1]);
    const poleHalf = rotateByConjugate(qHalf, [0, 0, 1]);
    expect(poleHalf[0]).toBeCloseTo(pole0[0], 5);
    expect(poleHalf[1]).toBeCloseTo(pole0[1], 5);
    expect(poleHalf[2]).toBeCloseTo(pole0[2], 5);
    // But the prime meridian (body X) should have rotated 180° in the equatorial plane
    const meridian0 = rotateByConjugate(q0, [1, 0, 0]);
    const meridianHalf = rotateByConjugate(qHalf, [1, 0, 0]);
    // Dot product of the two meridian directions should be -1 (180° apart)
    const dot = meridian0[0] * meridianHalf[0] + meridian0[1] * meridianHalf[1] + meridian0[2] * meridianHalf[2];
    expect(dot).toBeCloseTo(-1, 3);
  });
});
