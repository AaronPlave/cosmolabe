import { geodeticToBodyFixed, bodyFixedToGeodetic, type TerrainDatum } from '@cosmolabe/core';
/**
 * Renderer-independent surface navigation math for the Surface Explorer camera.
 *
 * Motion is applied as a displacement in the local East/North/Up frame (or along
 * the camera's view ray) in body-fixed Cartesian space and then converted back
 * to geodetic coordinates. There is no `1 / cos(latitude)` longitude increment,
 * so motion is well-defined at and across the poles; heading is parallel-
 * transported into the new local frame so a walk over the pole keeps going
 * "straight" instead of spinning.
 *
 * Conventions: conventional Z-up body-fixed (ECEF-like) km, radians, heading
 * measured clockwise from north (0 = north, π/2 = east), pitch positive up from
 * the local horizon. "Up" is the geodetic ellipsoid normal.
 */

export type Vec3 = [number, number, number];

export interface Ellipsoid {
  /** Equatorial radius, km. */
  readonly a: number;
  /** First eccentricity squared, 1 - c²/a². Zero for a sphere. */
  readonly e2: number;
}

export interface SurfacePose {
  latRad: number;
  lonRad: number;
  /** Height above the reference ellipsoid along the geodetic normal, km. */
  altKm: number;
  headingRad: number;
  pitchRad: number;
}

export interface LocalFrame {
  east: Vec3;
  north: Vec3;
  /** Geodetic ellipsoid normal. */
  up: Vec3;
}

const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const len = (u: Vec3) => Math.sqrt(dot(u, u));

function coordinateDatum(ell: Ellipsoid): TerrainDatum {
  return { referenceShape: { kind: 'ellipsoid', radiiKm: [ell.a, ell.a, ell.a * Math.sqrt(1 - ell.e2)] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
}
/** Coordinate entry and surface navigation use the same conversion as the grid/probe. */
export function geodeticToBodyFixedKm(latRad: number, lonRad: number, altKm: number, ell: Ellipsoid): Vec3 {
  const p = geodeticToBodyFixed({ latDeg: latRad * 180 / Math.PI, lonDeg: lonRad * 180 / Math.PI, heightKm: altKm }, coordinateDatum(ell));
  return [p.xKm, p.yKm, p.zKm];
}
export function bodyFixedToGeodeticRad(point: Vec3, ell: Ellipsoid): { latRad: number; lonRad: number; altKm: number } {
  const p = bodyFixedToGeodetic({ xKm: point[0], yKm: point[1], zKm: point[2] }, coordinateDatum(ell));
  return { latRad: p.latDeg * Math.PI / 180, lonRad: p.lonDeg * Math.PI / 180, altKm: p.heightKm ?? 0 };
}

/**
 * Local East/North/Up at a geodetic position. Defined at the poles too: there
 * the longitude picks which meridian counts as "north", consistently with the
 * heading stored alongside it.
 */
export function localFrame(latRad: number, lonRad: number): LocalFrame {
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad), cosLon = Math.cos(lonRad);
  return {
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
}

/** Unit view direction (body-fixed) for a heading and pitch in a local frame. */
export function viewDirection(frame: LocalFrame, headingRad: number, pitchRad: number): Vec3 {
  const ch = Math.cos(headingRad), sh = Math.sin(headingRad);
  const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = cp * (ch * frame.north[i] + sh * frame.east[i]) + sp * frame.up[i];
  }
  return out;
}

/** Heading/pitch of a body-fixed direction expressed in a local frame. */
export function headingPitchOf(
  dir: Vec3, frame: LocalFrame, fallbackHeadingRad: number,
): { headingRad: number; pitchRad: number } {
  const l = len(dir);
  if (l < 1e-15) return { headingRad: fallbackHeadingRad, pitchRad: 0 };
  const e = dot(dir, frame.east) / l;
  const n = dot(dir, frame.north) / l;
  const u = dot(dir, frame.up) / l;
  const horiz = Math.hypot(e, n);
  return {
    // Straight up/down has no heading; keep the previous one rather than snapping to north.
    headingRad: horiz > 1e-9 ? Math.atan2(e, n) : fallbackHeadingRad,
    pitchRad: Math.atan2(u, horiz),
  };
}

/**
 * Move along the surface by `forwardKm` along the heading and `rightKm` to its
 * right, at constant height above the ellipsoid. The step is taken in the
 * tangent plane at the start point and re-projected; pitch is unchanged and
 * heading is transported into the destination frame.
 */
export function moveAlongSurface(pose: SurfacePose, forwardKm: number, rightKm: number, ell: Ellipsoid): SurfacePose {
  if (forwardKm === 0 && rightKm === 0) return { ...pose };
  const frame = localFrame(pose.latRad, pose.lonRad);
  const fwd = viewDirection(frame, pose.headingRad, 0);
  // right = forward × up
  const right: Vec3 = [
    fwd[1] * frame.up[2] - fwd[2] * frame.up[1],
    fwd[2] * frame.up[0] - fwd[0] * frame.up[2],
    fwd[0] * frame.up[1] - fwd[1] * frame.up[0],
  ];
  const p = geodeticToBodyFixedKm(pose.latRad, pose.lonRad, pose.altKm, ell);
  for (let i = 0; i < 3; i++) p[i] += forwardKm * fwd[i] + rightKm * right[i];
  const g = bodyFixedToGeodeticRad(p, ell);
  // Re-express the heading direction in the destination frame: projecting it
  // onto the new tangent plane parallel-transports it over the short step.
  const nextFrame = localFrame(g.latRad, g.lonRad);
  const { headingRad } = headingPitchOf(fwd, nextFrame, pose.headingRad);
  return { latRad: g.latRad, lonRad: g.lonRad, altKm: pose.altKm, headingRad, pitchRad: pose.pitchRad };
}

/** Terrain height plus clearance at a geodetic point, km above the ellipsoid; null where unknown. */
export type FloorFn = (latRad: number, lonRad: number) => number | null;

/**
 * How far to travel along a body-fixed ray: `stepKm`, shortened if it would
 * end below `floorKm`, so the move stops on the floor. What counts is terrain
 * clearance (height above the floor), not ellipsoid height: a ray that climbs
 * can still run into terrain that climbs faster. A start point already at or
 * below the floor may only move where its clearance improves (otherwise 0),
 * so it can always back out but never dig deeper.
 */
export function clipRayToFloor(start: Vec3, dir: Vec3, stepKm: number, ell: Ellipsoid, floorKm?: FloorFn): number {
  if (stepKm === 0 || !floorKm) return stepKm;
  const clearance = (t: number): number | null => {
    const g = bodyFixedToGeodeticRad([start[0] + t * dir[0], start[1] + t * dir[1], start[2] + t * dir[2]], ell);
    const floor = floorKm(g.latRad, g.lonRad);
    return floor == null ? null : g.altKm - floor;
  };
  const end = clearance(stepKm);
  if (end == null || end >= 0) return stepKm;
  const c0 = clearance(0);
  if (c0 != null && c0 <= 0) return end > c0 ? stepKm : 0;
  // Bisect for the point where the clearance reaches zero (an unknown floor
  // counts as clear, like the start point when it has none).
  let lo = 0, hi = stepKm;
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    const c = clearance(mid);
    if (c == null || c >= 0) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Dolly `stepKm` along the camera's view ray (positive = forward), stopping on
 * `floorKm` as described in {@link clipRayToFloor}.
 */
export function dollyAlongView(pose: SurfacePose, stepKm: number, ell: Ellipsoid, floorKm?: FloorFn): SurfacePose {
  if (stepKm === 0) return { ...pose };
  const frame = localFrame(pose.latRad, pose.lonRad);
  const look = viewDirection(frame, pose.headingRad, pose.pitchRad);
  const start = geodeticToBodyFixedKm(pose.latRad, pose.lonRad, pose.altKm, ell);
  const t = clipRayToFloor(start, look, stepKm, ell, floorKm);
  if (t === 0) return { ...pose };
  const g = bodyFixedToGeodeticRad([start[0] + t * look[0], start[1] + t * look[1], start[2] + t * look[2]], ell);
  const nextFrame = localFrame(g.latRad, g.lonRad);
  const { headingRad, pitchRad } = headingPitchOf(look, nextFrame, pose.headingRad);
  return { latRad: g.latRad, lonRad: g.lonRad, altKm: g.altKm, headingRad, pitchRad };
}
