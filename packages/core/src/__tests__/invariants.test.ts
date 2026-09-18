/**
 * Layer 3 — physical / structural invariants.
 *
 * Oracle-free (mostly) assertions about what MUST be true of the composed
 * scene, expressed semantically so the failure message names the symptom:
 *   - Saturn's ring plane normal is parallel to Saturn's pole (the literal
 *     "rings rotated wrong" guard).
 *   - Each regular moon's orbital plane is coplanar with Saturn's equator
 *     (the obliquity-in-position bug tilted all moon orbits ~23° off the ring
 *     plane — caught from a positions-only angle, independent of Layer 1).
 *   - subPointOf altitudes are physical (≥ 0), exercising the third obliquity
 *     copy (alignPositionToFrame + rotateVecByQuat in kinematics' subPointOf).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildScene } from './_harness/scenes.js';
import type { BuiltScene } from './_harness/buildUniverse.js';
import { composeBodyToWorldQuat, rotateVecByQuat, subPointOf, type Vec3 } from '../kinematics.js';

function sub(a: number[], b: number[]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v: number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function angleDeg(a: number[], b: number[]): number {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.min(1, Math.max(-1, d / (norm(a) * norm(b))))) * 180) / Math.PI;
}
/** Angle to the nearest of ±axis (parallel OR antiparallel both count as aligned). */
function alignmentDeg(a: number[], axis: number[]): number {
  return Math.min(angleDeg(a, axis), 180 - angleDeg(a, axis));
}

describe('invariants: saturn-soi', () => {
  let scene: BuiltScene;
  let saturnPoleEcl: Vec3;

  beforeAll(async () => {
    scene = await buildScene('saturn-soi');
    // SPICE truth Saturn pole (body +Z) in EclipticJ2000 = third row of ECLIPJ2000→body.
    const m = scene.spice!.pxform('ECLIPJ2000', 'IAU_SATURN', scene.et);
    saturnPoleEcl = [m[6], m[7], m[8]];
  }, 30000);

  it("Saturn's ring-plane normal is parallel to Saturn's pole (< 0.1°)", () => {
    const saturn = scene.universe.getBody('Saturn')!;
    // The ring annulus lies in Saturn's body-fixed equatorial plane; its world
    // normal is Saturn's body +Z mapped to world — exactly what the renderer
    // applies when it copies the parent quaternion onto the ring mesh.
    const bw = composeBodyToWorldQuat(saturn.rotationAt(scene.et)!, saturn.rotation!.sourceFrame);
    const ringNormal = rotateVecByQuat([0, 0, 1], bw);
    expect(alignmentDeg(ringNormal, saturnPoleEcl)).toBeLessThan(0.1);
  });

  // Regular Saturnian moons are within ~1.6° of Saturn's equatorial (ring)
  // plane. The pre-fix obliquity bug tilted their orbits ~23.4° off it.
  const REGULAR_MOONS = ['Mimas', 'Enceladus', 'Tethys', 'Dione', 'Rhea', 'Titan'];
  const SAMPLE_HR = [-24, -12, 0, 12, 24, 36]; // within the ~6-day SOI kernel window

  for (const moonName of REGULAR_MOONS) {
    it(`${moonName}'s orbital plane is coplanar with Saturn's equator (< 3°)`, () => {
      const { universe, et } = scene;
      // Relative positions over an arc; the orbit normal is the summed
      // angular-momentum direction (∝ Σ rᵢ × rᵢ₊₁), valid even for a partial arc.
      const rel: Vec3[] = SAMPLE_HR.map((hr) => {
        const t = et + hr * 3600;
        return sub(universe.absolutePositionOf(moonName, t), universe.absolutePositionOf('Saturn', t));
      });
      let n: Vec3 = [0, 0, 0];
      for (let i = 0; i < rel.length - 1; i++) {
        const c = cross(rel[i], rel[i + 1]);
        n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]];
      }
      expect(norm(n), `${moonName} degenerate orbit arc`).toBeGreaterThan(0);
      expect(alignmentDeg(n, saturnPoleEcl)).toBeLessThan(3);
    });
  }

  it('subPointOf altitudes are physical (≥ 0) for moons and Cassini', () => {
    const { universe, et } = scene;
    for (const name of ['Titan', 'Rhea', 'Cassini']) {
      const sp = subPointOf((n) => universe.getBody(n), name, et);
      expect(sp, `${name} subPointOf returned null`).not.toBeNull();
      expect(sp!.altKm, `${name} altitude`).toBeGreaterThan(0);
      expect(Math.abs(sp!.lat)).toBeLessThanOrEqual(90.0001);
    }
  });
});
