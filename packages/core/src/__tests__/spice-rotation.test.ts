import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Spice, type SpiceInstance } from '@spicecraft/spice';
import { SpiceRotation } from '../rotations/SpiceRotation.js';

const KERNEL_DIR = join(__dirname, '../../../spice/test-kernels');

/**
 * Apply quaternion [w,x,y,z] to a 3D vector.
 * Returns the rotated vector: q * v * q⁻¹
 */
function rotateVector(q: [number, number, number, number], v: [number, number, number]): [number, number, number] {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;

  // q * v * q⁻¹ expanded
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);

  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

describe('SpiceRotation integration', () => {
  let spice: SpiceInstance;

  beforeAll(async () => {
    const s = await Spice.init();
    spice = s;

    const lsk = readFileSync(join(KERNEL_DIR, 'naif0012.tls'));
    const pck = readFileSync(join(KERNEL_DIR, 'pck00010.tpc'));
    const spk = readFileSync(join(KERNEL_DIR, 'de425s.bsp'));

    await s.furnish({ type: 'buffer', data: lsk.buffer, filename: 'naif0012.tls' });
    await s.furnish({ type: 'buffer', data: pck.buffer, filename: 'pck00010.tpc' });
    await s.furnish({ type: 'buffer', data: spk.buffer, filename: 'de425s.bsp' });
  }, 30000);

  it('quaternion is unit-length', () => {
    const rot = new SpiceRotation(spice, 'IAU_EARTH');
    const et = spice.str2et('2024-01-01T00:00:00');
    const q = rot.rotationAt(et);

    const norm = Math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2);
    expect(norm).toBeCloseTo(1, 10);
  });

  it('Earth pole is tilted ~23.4° from ecliptic north', () => {
    const rot = new SpiceRotation(spice, 'IAU_EARTH', 'ECLIPJ2000');
    const et = spice.str2et('2024-01-01T00:00:00');
    const q = rot.rotationAt(et);

    // In body-fixed frame, the pole is +Z = [0,0,1].
    // Our quaternion rotates FROM inertial TO body-fixed.
    // To find where the body pole points in inertial coords,
    // we apply the inverse rotation (conjugate) to [0,0,1].
    const qInv: [number, number, number, number] = [q[0], -q[1], -q[2], -q[3]];
    const poleInertial = rotateVector(qInv, [0, 0, 1]);

    // In ecliptic coordinates, ecliptic north is [0,0,1].
    // Earth's pole should be tilted ~23.44° from ecliptic north.
    const dotWithEclipticNorth = poleInertial[2]; // dot with [0,0,1]
    const angleDeg = Math.acos(dotWithEclipticNorth) * (180 / Math.PI);

    expect(angleDeg).toBeCloseTo(23.44, 0); // within ~0.5°
  });

  it('Earth rotates ~360° per sidereal day', () => {
    const rot = new SpiceRotation(spice, 'IAU_EARTH', 'ECLIPJ2000');
    const et0 = spice.str2et('2024-01-01T00:00:00');
    const siderealDay = 86164.1; // seconds

    const q0 = rot.rotationAt(et0);
    const q1 = rot.rotationAt(et0 + siderealDay);

    // After one sidereal day, the body should be in nearly the same orientation.
    // Compute the relative rotation: q_rel = q1 * q0⁻¹
    // For unit quaternions, q⁻¹ = conjugate = [w, -x, -y, -z]
    const q0inv: [number, number, number, number] = [q0[0], -q0[1], -q0[2], -q0[3]];

    // Quaternion multiply: q1 * q0inv
    const [w1, x1, y1, z1] = q1;
    const [w0i, x0i, y0i, z0i] = q0inv;
    const relW = w1 * w0i - x1 * x0i - y1 * y0i - z1 * z0i;

    // For a full 360° rotation, the quaternion is [-1,0,0,0] or [1,0,0,0]
    // (quaternion double cover means 360° → w = -1)
    // |w| should be close to 1
    expect(Math.abs(relW)).toBeCloseTo(1, 2);
  });

  it('Mars pole is tilted ~25.2° from ecliptic north', () => {
    const rot = new SpiceRotation(spice, 'IAU_MARS', 'ECLIPJ2000');
    const et = spice.str2et('2024-01-01T00:00:00');
    const q = rot.rotationAt(et);

    const qInv: [number, number, number, number] = [q[0], -q[1], -q[2], -q[3]];
    const poleInertial = rotateVector(qInv, [0, 0, 1]);

    const dotWithEclipticNorth = poleInertial[2];
    const angleDeg = Math.acos(dotWithEclipticNorth) * (180 / Math.PI);

    // Mars obliquity is ~25.19° to its own orbit; ~26.7° from ecliptic north
    // (difference due to Mars's ~1.85° orbital inclination)
    expect(angleDeg).toBeCloseTo(26.7, 0);
  });

  it('pxform matrix roundtrips through quaternion', () => {
    const et = spice.str2et('2024-06-15T12:00:00');

    // Get the rotation matrix directly from SPICE
    const mat = spice.pxform('ECLIPJ2000', 'IAU_EARTH', et);

    // Get quaternion from SpiceRotation (which uses the same pxform internally)
    const rot = new SpiceRotation(spice, 'IAU_EARTH', 'ECLIPJ2000');
    const q = rot.rotationAt(et);

    // Apply the quaternion to basis vectors and compare with matrix columns
    // Matrix is row-major: row i = [m[i*3], m[i*3+1], m[i*3+2]]
    // mat * [1,0,0] = [mat[0], mat[3], mat[6]]
    const xRotQ = rotateVector(q, [1, 0, 0]);
    expect(xRotQ[0]).toBeCloseTo(mat[0], 5);
    expect(xRotQ[1]).toBeCloseTo(mat[3], 5);
    expect(xRotQ[2]).toBeCloseTo(mat[6], 5);

    const yRotQ = rotateVector(q, [0, 1, 0]);
    expect(yRotQ[0]).toBeCloseTo(mat[1], 5);
    expect(yRotQ[1]).toBeCloseTo(mat[4], 5);
    expect(yRotQ[2]).toBeCloseTo(mat[7], 5);

    const zRotQ = rotateVector(q, [0, 0, 1]);
    expect(zRotQ[0]).toBeCloseTo(mat[2], 5);
    expect(zRotQ[1]).toBeCloseTo(mat[5], 5);
    expect(zRotQ[2]).toBeCloseTo(mat[8], 5);
  });
});
