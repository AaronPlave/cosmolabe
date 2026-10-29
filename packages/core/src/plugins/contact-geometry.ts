import type { Universe } from '../Universe.js';
import { rotateVecByQuat, type Vec3 } from '../kinematics.js';

/** Exploratory straight-line visibility against each body's physical triaxial
 * ellipsoid (`radii`), oriented by its rotation model when it has one and
 * axis-aligned with the scene frame otherwise. No terrain, elevation mask,
 * refraction, antenna constraints or light-time correction. Never a host
 * contact schedule.
 */
export function hasLineOfSight(universe: Universe, spacecraft: string, station: string, et: number): boolean {
  if (!Number.isFinite(et) || spacecraft === station || !universe.getBody(spacecraft) || !universe.getBody(station)) return false;
  const a = universe.absolutePositionOf(spacecraft, et);
  const b = universe.absolutePositionOf(station, et);
  if (![...a, ...b].every(Number.isFinite)) return false;
  const d = b.map((v, i) => v - a[i]);
  const length2 = d.reduce((sum, v) => sum + v * v, 0);
  if (length2 === 0) return false;
  for (const body of universe.getAllBodies()) {
    if (body.name === spacecraft || body.name === station || !body.radii) continue;
    if (!body.radii.every(r => r > 0 && Number.isFinite(r))) continue;
    const center = universe.absolutePositionOf(body.name, et);
    if (!center.every(Number.isFinite)) return false; // unknown geometry is not clear
    // Work in the body-fixed frame with axes scaled by the radii, where the
    // ellipsoid is the unit sphere. Nearest point of the segment to the origin:
    const q = universe.bodyToWorldQuat(body, et);
    const toUnit = (v: Vec3): Vec3 => {
      const f = q ? rotateVecByQuat(v, [q[0], -q[1], -q[2], -q[3]]) : v;
      return [f[0] / body.radii![0], f[1] / body.radii![1], f[2] / body.radii![2]];
    };
    const p = toUnit([a[0] - center[0], a[1] - center[1], a[2] - center[2]] as Vec3);
    const v = toUnit(d as Vec3);
    const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    const t = vv === 0 ? 0 : Math.max(0, Math.min(1, -(p[0] * v[0] + p[1] * v[1] + p[2] * v[2]) / vv));
    const distance2 = (p[0] + t * v[0]) ** 2 + (p[1] + t * v[1]) ** 2 + (p[2] + t * v[2]) ** 2;
    // Allow a station on the surface; penetration, including just behind the
    // horizon, remains blocked. Tolerance only absorbs floating-point noise.
    if (distance2 < 1 - 1e-12) return false;
  }
  return true;
}
