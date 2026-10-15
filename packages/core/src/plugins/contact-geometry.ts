import type { Universe } from '../Universe.js';

/** Exploratory straight-line visibility against conservative spherical body
 * bounds (largest physical radius). No terrain, elevation mask, refraction,
 * antenna constraints or light-time correction. Never a host contact schedule.
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
    const radius = Math.max(...body.radii);
    if (!(radius > 0) || !Number.isFinite(radius)) continue;
    const center = universe.absolutePositionOf(body.name, et);
    if (!center.every(Number.isFinite)) return false; // unknown geometry is not clear
    const t = Math.max(0, Math.min(1, center.reduce((sum, v, i) => sum + (v - a[i]) * d[i], 0) / length2));
    const distance2 = center.reduce((sum, v, i) => sum + (a[i] + t * d[i] - v) ** 2, 0);
    // Allow a station on the surface; penetration, including just behind the
    // horizon, remains blocked. Tolerance only absorbs floating-point noise.
    if (distance2 < radius * radius * (1 - 1e-12)) return false;
  }
  return true;
}
