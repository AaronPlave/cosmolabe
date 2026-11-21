/**
 * Reference model for terrain solar visibility (#205): the horizon a receiver
 * sees along the Sun's azimuth, and how much of the Sun's disk clears it.
 *
 * This is the **ground truth** the GPU path is measured against, not the
 * renderer. It is pure (no Three.js, no GPU, no streaming) so the synthetic
 * ridge acceptance case, the coverage-radius budget and the "unknown is never
 * lit" rule are testable. See docs/terrain-solar-visibility.md.
 *
 * Geometry is a sphere of `radiusKm` seen from a receiver at height `h0Km`, so
 * body curvature is exact: at 1° solar elevation the curvature drop over 100 km
 * on the Moon (~2.9 km) is as large as the relief being tested for shadow.
 */

/** Terrain height above the reference sphere, km, at (eastKm, northKm) from the receiver; null = no source coverage. */
export type HeightKm = (eastKm: number, northKm: number) => number | null;

export interface HorizonResult {
  /** Highest terrain elevation angle seen along the azimuth, degrees above the receiver's local horizontal. */
  elevationDeg: number;
  /** Distance of the first sample with no source coverage, km; null when the whole range was covered. */
  unknownFromKm: number | null;
}

const DEG = Math.PI / 180;

/**
 * March the terrain along `azimuthDeg` (clockwise from north) out to `rangeKm`.
 * `stepKm` must not exceed the source's sample spacing or a narrow ridge can be
 * stepped over (ponytail: fixed step; a hierarchical/clipmap march is the
 * upgrade when range/step gets large).
 */
export function horizonAlong(
  height: HeightKm, azimuthDeg: number, receiverHeightKm: number, radiusKm: number, rangeKm: number, stepKm: number,
): HorizonResult {
  const se = Math.sin(azimuthDeg * DEG), sn = Math.cos(azimuthDeg * DEG);
  const rp = radiusKm + receiverHeightKm;
  let best = -Math.PI / 2, unknownFromKm: number | null = null;
  for (let d = stepKm; d <= rangeKm; d += stepKm) {
    const h = height(d * se, d * sn); // ponytail: tangent-plane lookup; great-circle azimuth drift matters past ~10° of arc
    if (h === null) { unknownFromKm ??= d; continue; }
    const phi = d / radiusKm, rq = radiusKm + h;
    best = Math.max(best, Math.atan2(rq * Math.cos(phi) - rp, rq * Math.sin(phi)));
  }
  return { elevationDeg: best / DEG, unknownFromKm };
}

/**
 * Fraction (0..1) of a Sun disk of angular radius `sunRadiusDeg`, centred
 * `sunElevationDeg` above the local horizontal, that clears a flat horizon at
 * `horizonDeg`. Linear in angle across the disk: the penumbra width is the Sun's
 * diameter and the result is continuous in time (no abrupt toggling).
 */
export function sunFraction(sunElevationDeg: number, horizonDeg: number, sunRadiusDeg = 0.2665): number {
  const t = (sunElevationDeg - horizonDeg) / (2 * sunRadiusDeg) + 0.5;
  return Math.min(1, Math.max(0, t));
}

export type SolarVisibility =
  | { state: 'lit' | 'shadowed' | 'partial'; fraction: number; horizonDeg: number }
  /** Terrain along the Sun azimuth was not resident. Never presented as lit or shadowed. */
  | { state: 'unknown'; fraction: null; horizonDeg: number; unknownFromKm: number };

/**
 * Direct-sun visibility of a receiver. If coverage ends before `rangeKm` the
 * answer is `unknown` unless the covered part already fully shadows it (more
 * terrain can only add shadow) or the unknown part is too far to matter for the
 * given `maxReliefKm` (see `occluderRangeKm`).
 */
export function solarVisibility(
  height: HeightKm, azimuthDeg: number, sunElevationDeg: number, receiverHeightKm: number,
  radiusKm: number, rangeKm: number, stepKm: number, sunRadiusDeg = 0.2665,
): SolarVisibility {
  const h = horizonAlong(height, azimuthDeg, receiverHeightKm, radiusKm, rangeKm, stepKm);
  const fraction = sunFraction(sunElevationDeg, h.elevationDeg, sunRadiusDeg);
  if (h.unknownFromKm !== null && fraction > 0) {
    return { state: 'unknown', fraction: null, horizonDeg: h.elevationDeg, unknownFromKm: h.unknownFromKm };
  }
  return { state: fraction === 1 ? 'lit' : fraction === 0 ? 'shadowed' : 'partial', fraction, horizonDeg: h.elevationDeg };
}

/**
 * The farthest ground distance, km, from which terrain of height `maxHeightKm`
 * can still block a Sun at `sunElevationDeg` seen from `receiverHeightKm`.
 * Beyond it the Sun ray is above every possible occluder, so terrain coverage
 * past this radius cannot change the answer. This is the documented
 * "required terrain coverage" for a given relief bound.
 *
 * Ray from the receiver: `r(φ) = rp·cos(el) / cos(el + φ)`; solve `r = R + hmax`.
 * Returns Infinity when the ray never climbs above `maxHeightKm` (el ≤ 0 case).
 */
export function occluderRangeKm(sunElevationDeg: number, receiverHeightKm: number, maxHeightKm: number, radiusKm: number): number {
  const el = sunElevationDeg * DEG;
  if (el <= 0 || maxHeightKm <= receiverHeightKm) return el <= 0 ? Infinity : 0;
  const c = ((radiusKm + receiverHeightKm) * Math.cos(el)) / (radiusKm + maxHeightKm);
  return radiusKm * Math.max(0, Math.acos(Math.min(1, c)) - el);
}
