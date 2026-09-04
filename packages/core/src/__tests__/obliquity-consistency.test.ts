/**
 * The obliquity constant, checked against CSPICE rather than against itself.
 *
 * cosmolabe carries two implementations of the EquatorJ2000 <-> EclipticJ2000
 * rotation — a matrix in `frames/InertialFrame` and a quaternion in
 * `kinematics` — and a third lives in the Cesium adapter. `frame-composition`
 * already pins that our own copies agree with each other. What none of those
 * can tell us is whether the shared number is *right*, because they all read
 * it from the same place.
 *
 * This does: it compares our analytical rotation against
 * `pxform('J2000', 'ECLIPJ2000')`, which is CSPICE's own answer. That matters
 * because the renderer mixes the two freely — an analytical rotation model and
 * a SPICE-backed one can sit on sibling bodies in the same scene — so if the
 * constants disagree, the two paths disagree by construction and nothing else
 * in the suite notices.
 *
 * Nothing else noticed for a while, in fact. Three hand-written copies all read
 * 23.4392911 degrees, which is 84381.44796 arcsec: 4.0e-5 arcsec short of the
 * IAU 1976 value CSPICE uses. That is small, and it survived precisely because
 * it was small — the golden fingerprints compare positions with a 1 m tolerance
 * and the error's worst effect in the Saturn scene was 143 mm at Titan, so the
 * broad regression net could not see it either. An error under every tolerance
 * is still an error that biases every equatorial-frame body in the same
 * direction forever, and the fix costs nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import {
  OBLIQUITY_J2000_ARCSEC,
  OBLIQUITY_J2000_DEG,
  OBLIQUITY_J2000_RAD,
} from '../constants.js';
import { alignPositionToFrame, frameAlignmentQuat, rotateVecByQuat } from '../kinematics.js';
import { EquatorJ2000 } from '../frames/InertialFrame.js';

const KERNEL = (name: string) =>
  fileURLToPath(new URL(`../../../spice/test-kernels/${name}`, import.meta.url));

/** Machine-precision agreement, in arcseconds. Both sides compute a rotation
 *  from the same decimal constant, so anything above rounding noise means the
 *  constants themselves differ. */
const AGREEMENT_ARCSEC = 1e-9;

describe('J2000 obliquity', () => {
  let spice: HeritageSpice;
  /** CSPICE's own obliquity, recovered from its J2000 -> ECLIPJ2000 matrix. */
  let spiceEpsRad: number;

  beforeAll(async () => {
    spice = await createHeritageSpice();
    for (const name of ['naif0012.tls', 'pck00010.tpc']) {
      const b = readFileSync(KERNEL(name));
      await spice.furnish({
        type: 'buffer',
        data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
        filename: name,
      });
    }
    // ECLIPJ2000 is a fixed offset frame, so the epoch is irrelevant. The
    // matrix is row-major and the rotation is about X, so row 1 is
    // [0, cos eps, sin eps].
    const m = spice.pxform('J2000', 'ECLIPJ2000', 0);
    spiceEpsRad = Math.atan2(m[5], m[4]);
  }, 120_000);

  it('is the exact IAU 1976 value, in the units the standard states it in', () => {
    // Written as arcseconds because that is how the standard defines it; a
    // hand-rounded degree value is how the old truncation got in.
    expect(OBLIQUITY_J2000_ARCSEC).toBe(84381.448);
    expect(OBLIQUITY_J2000_DEG).toBe(84381.448 / 3600);
    expect(OBLIQUITY_J2000_RAD).toBe(((84381.448 / 3600) * Math.PI) / 180);
  });

  it('agrees with CSPICE to machine precision', () => {
    const deltaArcsec = Math.abs(OBLIQUITY_J2000_RAD - spiceEpsRad) * (180 / Math.PI) * 3600;
    expect(deltaArcsec, 'our constant vs CSPICE ECLIPJ2000').toBeLessThan(AGREEMENT_ARCSEC);
  });

  it('rejects the truncation this test exists to catch', () => {
    // A guard on the guard: confirm the check above is actually sensitive to
    // the error that was there, rather than passing for everything.
    const truncatedRad = (23.4392911 * Math.PI) / 180;
    const deltaArcsec = Math.abs(truncatedRad - spiceEpsRad) * (180 / Math.PI) * 3600;
    expect(deltaArcsec).toBeGreaterThan(AGREEMENT_ARCSEC);
    expect(deltaArcsec).toBeCloseTo(4.0e-5, 10);
  });

  describe('both analytical implementations match SPICE, not just each other', () => {
    // A vector well off the X axis, so the obliquity actually shows.
    const v: [number, number, number] = [1.0e6, -7.5e5, 4.25e5];

    /** SPICE's answer for the same rotation, via its matrix. */
    function spiceRotate(vec: [number, number, number]): [number, number, number] {
      const m = spice.pxform('J2000', 'ECLIPJ2000', 0);
      return [
        m[0] * vec[0] + m[1] * vec[1] + m[2] * vec[2],
        m[3] * vec[0] + m[4] * vec[1] + m[5] * vec[2],
        m[6] * vec[0] + m[7] * vec[1] + m[8] * vec[2],
      ];
    }

    it('the position path (alignPositionToFrame) matches pxform', () => {
      const ours = alignPositionToFrame(v, 'EquatorJ2000', 'EclipticJ2000');
      const theirs = spiceRotate(v);
      const d = Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1], ours[2] - theirs[2]);
      // |v| is ~1.3e6 km, so this bound is well under a micrometre of drift.
      expect(d, 'position rotation delta (km)').toBeLessThan(1e-9);
    });

    it('the orientation path (frameAlignmentQuat) matches pxform', () => {
      const q = frameAlignmentQuat('EquatorJ2000', 'EclipticJ2000');
      const ours = rotateVecByQuat(v, q);
      const theirs = spiceRotate(v);
      const d = Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1], ours[2] - theirs[2]);
      expect(d, 'orientation rotation delta (km)').toBeLessThan(1e-9);
    });

    it('the frames-module matrix matches pxform', () => {
      // InertialFrame publishes the equator-to-ecliptic matrix directly.
      const m = EquatorJ2000.toInertial(0);
      const ours: [number, number, number] = [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
      ];
      const theirs = spiceRotate(v);
      const d = Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1], ours[2] - theirs[2]);
      expect(d, 'frames matrix rotation delta (km)').toBeLessThan(1e-9);
    });
  });
});
