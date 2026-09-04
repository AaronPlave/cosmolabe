/**
 * The catalog viewpoint convention (`distance` + `latitude` + `longitude`),
 * checked against SPICE.
 *
 * This math used to live inline in the viewer's catalog loader, where it had no
 * test home, and it was wrong: it conjugated `rotationAt` and stopped there.
 * Conjugating gets you from body-fixed back to the rotation model's OWN source
 * frame, but the rendered scene is uniformly EclipticJ2000 and most models are
 * stated in EquatorJ2000 (the default for Uniform / Fixed / FixedEuler, and
 * what a SPICE-backed IAU frame reports). The missing source→world step is the
 * J2000 obliquity, so a "look down at this surface feature" viewpoint aimed
 * ~23.44° away from the feature it names.
 *
 * That is the same defect commit 1ec7f60 fixed in the locked camera modes by
 * routing them through `composeBodyToWorldQuat`. This path was never brought
 * onto it, which is the argument for the convention living in core with a test
 * rather than in whichever app happens to need it.
 *
 * The check is against `pxform(IAU_EARTH -> ECLIPJ2000)` — CSPICE's own answer
 * for the same transform — rather than against our other implementation, so it
 * cannot pass by two copies agreeing on the same mistake.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import { bodyFixedOffsetToWorld, rotateVecByQuat, type Vec3 } from '../kinematics.js';
import { SpiceRotation } from '../rotations/SpiceRotation.js';

const KERNEL = (name: string) =>
  fileURLToPath(new URL(`../../../spice/test-kernels/${name}`, import.meta.url));

/** 2004-07-01T00:00 TDB-ish; any epoch inside the leapsecond kernel does. */
const ET = 141868864.0;
/** A direction well off both the pole and the prime meridian, so a missing
 *  rotation about X actually shows up in every component. */
const LAT = 37.5;
const LON = -112.25;
const DIST = 5.0e5;

describe('bodyFixedOffsetToWorld', () => {
  let spice: HeritageSpice;

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
  }, 120_000);

  /** The body-fixed offset the convention names, unrotated. */
  const bodyFixed = (): Vec3 => {
    const lat = (LAT * Math.PI) / 180;
    const lon = (LON * Math.PI) / 180;
    return [
      DIST * Math.cos(lat) * Math.cos(lon),
      DIST * Math.cos(lat) * Math.sin(lon),
      DIST * Math.sin(lat),
    ];
  };

  /** SPICE's own body-fixed → world for the same frame and epoch. */
  const spiceTruth = (bodyFrame: string): Vec3 => {
    const m = spice.pxform(bodyFrame, 'ECLIPJ2000', ET);
    const v = bodyFixed();
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
  };

  it('matches pxform(IAU_EARTH -> ECLIPJ2000) for a SPICE rotation model', () => {
    const rot = new SpiceRotation(spice, 'IAU_EARTH', 'J2000');
    const q = rot.rotationAt(ET)!;
    expect(q, 'IAU_EARTH rotation should be available').toBeDefined();

    const ours = bodyFixedOffsetToWorld(DIST, LAT, LON, q, rot.sourceFrame);
    const theirs = spiceTruth('IAU_EARTH');
    const d = Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1], ours[2] - theirs[2]);
    // 5e5 km out, so this bound is roughly a part in 1e11 of the lever arm.
    expect(d, 'viewpoint offset vs pxform (km)').toBeLessThan(1e-6);
  });

  it('rejects the composition this test exists to catch', () => {
    // A guard on the guard: the old inline math, verbatim. If the check above
    // were insensitive to the missing obliquity step, this would also pass.
    const rot = new SpiceRotation(spice, 'IAU_EARTH', 'J2000');
    const q = rot.rotationAt(ET)!;
    const conjugateOnly: [number, number, number, number] = [q[0], -q[1], -q[2], -q[3]];
    const old = rotateVecByQuat(bodyFixed(), conjugateOnly);
    const theirs = spiceTruth('IAU_EARTH');
    const d = Math.hypot(old[0] - theirs[0], old[1] - theirs[1], old[2] - theirs[2]);
    // The error is a 23.44° rotation of a 5e5 km vector: order 1e5 km. Stated
    // as a bound, not an equality, so it documents the scale without pinning
    // an epoch-specific number.
    expect(d, 'old conjugate-only path vs pxform (km)').toBeGreaterThan(1e4);

    // And say it as an angle, which is the number that actually matters: it is
    // the obliquity, independent of distance.
    const dot =
      (old[0] * theirs[0] + old[1] * theirs[1] + old[2] * theirs[2]) /
      (Math.hypot(...old) * Math.hypot(...theirs));
    const angleDeg = (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
    expect(angleDeg, 'aim error of the old path (deg)').toBeGreaterThan(1);
    expect(angleDeg).toBeLessThan(23.44 * 2);
  });

  it('is a pure scaling in distance and reduces to body-fixed with no rotation', () => {
    const rot = new SpiceRotation(spice, 'IAU_EARTH', 'J2000');
    const q = rot.rotationAt(ET)!;
    const a = bodyFixedOffsetToWorld(1, LAT, LON, q, rot.sourceFrame);
    const b = bodyFixedOffsetToWorld(1000, LAT, LON, q, rot.sourceFrame);
    for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i] * 1000, 9);

    // Identity rotation in the world frame: the offset passes straight through,
    // which is the fallback the loader uses for a body with no rotation model.
    const passthrough = bodyFixedOffsetToWorld(DIST, LAT, LON, [1, 0, 0, 0], 'EclipticJ2000');
    const raw = bodyFixed();
    for (let i = 0; i < 3; i++) expect(passthrough[i]).toBeCloseTo(raw[i], 9);
  });

  it('poles are on the world Z axis only after the frame step', () => {
    // A viewpoint at latitude 90 is "over the north pole". In EclipticJ2000
    // that is NOT +Z, because the body's pole is tilted — a useful sanity check
    // that the composition is doing something rather than passing through.
    const rot = new SpiceRotation(spice, 'IAU_EARTH', 'J2000');
    const q = rot.rotationAt(ET)!;
    const overPole = bodyFixedOffsetToWorld(DIST, 90, 0, q, rot.sourceFrame);
    const theirs = spice.pxform('IAU_EARTH', 'ECLIPJ2000', ET);
    // Body-fixed +Z mapped to world is column 2 of the matrix (row-major).
    const expected: Vec3 = [theirs[2] * DIST, theirs[5] * DIST, theirs[8] * DIST];
    const d = Math.hypot(
      overPole[0] - expected[0],
      overPole[1] - expected[1],
      overPole[2] - expected[2],
    );
    expect(d, 'over-the-pole offset vs pxform column (km)').toBeLessThan(1e-6);
  });
});
