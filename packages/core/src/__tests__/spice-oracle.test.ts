/**
 * Layer 1 — SPICE-as-oracle correctness tests.
 *
 * Independently recompute the truth with SPICE's own frame machinery and check
 * cosmolabe's hand-rolled composition against it:
 *   - POSITION: per-leg `absolutePositionOf(body) − absolutePositionOf(parent)`
 *     vs `spkpos(body, et, 'ECLIPJ2000', 'NONE', center)`. Catches the obliquity
 *     frame-composition bug (the ~73 km/moon displacement that tilted Saturn's
 *     moons off the ring plane), independent of where the chain is rooted.
 *   - ORIENTATION: cosmolabe's composed body→world pole vs SPICE's
 *     `pxform('ECLIPJ2000', 'IAU_SATURN')` pole. Catches a ~23.4° obliquity
 *     error in the orientation composition.
 *
 * Uses only the bundled SOI SCPSE kernel — no large mission kernels.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildScene, SCENES } from './_harness/scenes.js';
import type { BuiltScene } from './_harness/buildUniverse.js';
import { composeBodyToWorldQuat, rotateVecByQuat, type Vec3 } from '../kinematics.js';

// Both bounds are set just above the measured residual, not at a round
// "close enough" number: this layer exists to pin cosmolabe's hand-rolled
// composition to SPICE's own, and a bound loose enough to pass a wrong answer
// pins nothing. Measured by setting each to 0 and reading the residuals off
// the failures — re-measure the same way if a kernel or rotation model moves.
//
// Worst position residual is 9.6e-8 km (0.096 mm), on Titan; Saturn rel. SUN
// is exact. 1e-6 km leaves ~10× headroom and still catches the 73 km/moon
// obliquity regression by 7e7×.
const POS_TOL_KM = 1e-6; // 1 mm
// Pole residual is 2.56e-4° — a real systematic offset, not float noise,
// so the bound sits ~4× above it rather than at the float floor. Catches a
// 23.4° obliquity error by 2e4×.
const POLE_TOL_DEG = 1e-3;

function sub(a: Vec3 | number[], b: Vec3 | number[]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function norm(v: number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function angleDeg(a: number[], b: number[]): number {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.min(1, Math.max(-1, d / (norm(a) * norm(b))))) * 180) / Math.PI;
}

describe('SPICE oracle: saturn-soi', () => {
  let scene: BuiltScene;
  const def = SCENES['saturn-soi'];

  beforeAll(async () => {
    scene = await buildScene('saturn-soi');
  }, 30000);

  it('builds the full scene (Saturn + rings + 6 moons + Cassini + Sun)', () => {
    expect(scene.bodyNames).toEqual(
      expect.arrayContaining(['Sun', 'Saturn', 'Saturn Rings', 'Titan', 'Cassini']),
    );
  });

  for (const ob of SCENES['saturn-soi'].oracleBodies) {
    it(`position: ${ob.name} relative to ${ob.spiceCenter} matches SPICE within ${POS_TOL_KM} km`, () => {
      const { universe, spice, et } = scene;
      expect(spice).toBeDefined();
      const body = universe.getBody(ob.name)!;
      const parentName = body.parentName!;

      const ours = sub(universe.absolutePositionOf(ob.name, et), universe.absolutePositionOf(parentName, et));
      // Independent SPICE truth (its own frame machinery), same abcorr cosmolabe uses.
      const truth = spice!.spkpos(ob.spiceName, et, 'ECLIPJ2000', 'NONE', ob.spiceCenter).position;

      const delta = norm(sub(ours, truth));
      expect(Number.isFinite(delta), `${ob.name} produced NaN — SPICE coverage gap?`).toBe(true);
      expect(delta).toBeLessThan(POS_TOL_KM);
    });
  }

  for (const ob of def.oracleBodies.filter((b) => b.hasPole)) {
    it(`orientation: ${ob.name} pole matches SPICE pck within ${POLE_TOL_DEG}°`, () => {
      const { universe, spice, et } = scene;
      const body = universe.getBody(ob.name)!;
      const q = body.rotationAt(et)!;
      expect(q, `${ob.name} has no rotation model`).toBeDefined();
      expect(body.rotation).toBeDefined();

      // cosmolabe's composed body→world pole (body +Z mapped into EclipticJ2000).
      const bw = composeBodyToWorldQuat(q, body.rotation!.sourceFrame);
      const poleOurs = rotateVecByQuat([0, 0, 1], bw);

      // SPICE truth: ECLIPJ2000→body matrix (flat row-major); the body Z axis
      // expressed in ecliptic is the third row.
      const m = spice!.pxform('ECLIPJ2000', `IAU_${ob.spiceName}`, et);
      const poleTruth: Vec3 = [m[6], m[7], m[8]];

      expect(angleDeg(poleOurs, poleTruth)).toBeLessThan(POLE_TOL_DEG);
    });
  }
});
