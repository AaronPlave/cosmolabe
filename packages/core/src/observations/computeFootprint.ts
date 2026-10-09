/**
 * Sensor footprints: the `sensor` branch of an observation's coverage
 * (issue #28, Phase 2).
 *
 *   getfov boundary → `sideDivisions` rays per side → sincpt per ray → polygon,
 *   and ilumin at the boresight intercept for phase/incidence/emission.
 *
 * Every number comes from CSPICE; this only chooses the rays. It takes an
 * engine through `FootprintGeometryProvider` — a contract owned here, the
 * GeometryFinderProvider pattern — rather than widening core's SpiceInstance,
 * which carries no FOV or surface-intercept routine and does not grow.
 * `@cosmolabe/frames`' heritage adapter and `@cosmolabe/spice` both satisfy it
 * structurally.
 *
 * The intercept `method` is a parameter, not hard-wired to `ELLIPSOID`, so an
 * irregular DSK-backed target (67P) is the same call with
 * `DSK/UNPRIORITIZED` — no target-specific path.
 */
import type { AberrationCorrection, IlluminationAngles, Vec3 } from '../spice-injection.js';
import type { ObservationIllumination } from './Observation.js';

/** The CSPICE surface a footprint needs. */
export interface FootprintGeometryProvider {
  getfov(instId: number, maxBounds?: number): {
    shape: 'POLYGON' | 'RECTANGLE' | 'CIRCLE' | 'ELLIPSE';
    frame: string;
    boresight: Vec3;
    bounds: Vec3[];
  };
  sincpt(
    method: string, target: string, et: number, fixref: string,
    abcorr: AberrationCorrection, observer: string, dref: string, dvec: Vec3,
  ): { point: Vec3; found: boolean; trgepc: number; srfvec: Vec3 };
  ilumin(
    method: string, target: string, et: number, fixref: string,
    abcorr: AberrationCorrection, observer: string, spoint: Vec3,
  ): IlluminationAngles;
}

/** Narrow an injected engine to the footprint capability, or null without it. */
export function footprintGeometryProviderOf(spice: unknown): FootprintGeometryProvider | null {
  const s = spice as Partial<FootprintGeometryProvider> | null | undefined;
  return s != null && typeof s.getfov === 'function' && typeof s.sincpt === 'function' && typeof s.ilumin === 'function'
    ? (s as FootprintGeometryProvider)
    : null;
}

export interface FootprintRequest {
  /** NAIF instrument ID, whose IK defines the FOV. */
  instrumentId: number;
  /** Target body, as SPICE names it. */
  target: string;
  /** Observer (the spacecraft), as SPICE names it. */
  observer: string;
  /** The target's body-fixed frame (`IAU_SATURN`). Footprint points are in it. */
  fixref: string;
  et: number;
  /** Explicit at every call site, as everywhere in core. The PDS oracle
   *  (Phase 1) measured the archives' convention as `LT+S`. */
  abcorr: AberrationCorrection;
  /** Boundary rays per side of the FOV (per quadrant of a circle/ellipse). Default 8. */
  sideDivisions?: number;
  /** sincpt/ilumin shape method. Default `ELLIPSOID`; `DSK/UNPRIORITIZED` for a DSK target. */
  method?: string;
}

export interface Footprint {
  et: number;
  /** Body-fixed (km) intercept per boundary ray, in order around the FOV;
   *  `null` where the ray misses the target (off the limb). */
  boundary: (Vec3 | null)[];
  /** Body-fixed boresight intercept, or null when the boresight misses. */
  boresight: Vec3 | null;
  /** At the boresight intercept, when there is one. */
  illumination?: Required<ObservationIllumination>;
  /** True when every boundary ray hit: the polygon is the whole FOV. */
  complete: boolean;
}

const DEG = 180 / Math.PI;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (s: number, a: Vec3): Vec3 => [s * a[0], s * a[1], s * a[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(1 / norm(a), a);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * The boundary ray directions of an IK field of view, in the instrument frame,
 * ordered around the FOV and not closed (the first ray is not repeated).
 *
 * Polygons and rectangles: each edge between consecutive corner vectors is cut
 * into `sideDivisions` steps (interpolated on the boresight-normal plane, so
 * rays stay on the true edge of the pyramid). Circles and ellipses:
 * `4 × sideDivisions` rays around the cone, from the IK's reference vector
 * (and, for an ellipse, its second semi-axis vector).
 */
export function fovBoundaryRays(
  fov: ReturnType<FootprintGeometryProvider['getfov']>,
  sideDivisions = 8,
): Vec3[] {
  const n = Math.max(1, Math.floor(sideDivisions));
  const b = unit(fov.boresight);
  // Each bound vector, scaled to meet the plane one unit along the boresight.
  const onPlane = (v: Vec3): Vec3 => scale(1 / dot(v, b), v);
  if (fov.shape === 'CIRCLE' || fov.shape === 'ELLIPSE') {
    const a1 = sub(onPlane(fov.bounds[0]!), b);
    let a2: Vec3;
    if (fov.shape === 'ELLIPSE') {
      a2 = sub(onPlane(fov.bounds[1]!), b);
    } else {
      const dir = unit(cross(b, a1));
      a2 = scale(norm(a1), dir);
    }
    const m = 4 * n;
    const rays: Vec3[] = [];
    for (let i = 0; i < m; i++) {
      const th = (2 * Math.PI * i) / m;
      rays.push(add(b, add(scale(Math.cos(th), a1), scale(Math.sin(th), a2))));
    }
    return rays;
  }
  const corners = fov.bounds.map(onPlane);
  const rays: Vec3[] = [];
  for (let c = 0; c < corners.length; c++) {
    const p = corners[c]!;
    const q = corners[(c + 1) % corners.length]!;
    for (let k = 0; k < n; k++) rays.push(add(p, scale(k / n, sub(q, p))));
  }
  return rays;
}

/** One footprint: the FOV intersected with the target at `req.et`. */
export function computeFootprint(provider: FootprintGeometryProvider, req: FootprintRequest): Footprint {
  const fov = provider.getfov(req.instrumentId);
  return footprintFromFov(provider, fov, req);
}

/** `computeFootprint` with the FOV already read — the per-sample path, so a
 *  swath reads the IK once rather than once per instant. */
export function footprintFromFov(
  provider: FootprintGeometryProvider,
  fov: ReturnType<FootprintGeometryProvider['getfov']>,
  req: FootprintRequest,
): Footprint {
  const method = req.method ?? 'ELLIPSOID';
  const hit = (dir: Vec3): Vec3 | null => {
    const r = provider.sincpt(method, req.target, req.et, req.fixref, req.abcorr, req.observer, fov.frame, dir);
    return r.found ? r.point : null;
  };
  const boundary = fovBoundaryRays(fov, req.sideDivisions).map(hit);
  const boresight = hit(fov.boresight);
  const out: Footprint = {
    et: req.et,
    boundary,
    boresight,
    complete: boundary.every((p) => p !== null),
  };
  if (boresight) {
    const a = provider.ilumin(method, req.target, req.et, req.fixref, req.abcorr, req.observer, boresight);
    out.illumination = {
      phaseDeg: a.phaseAngle * DEG,
      incidenceDeg: a.solarIncidence * DEG,
      emissionDeg: a.emission * DEG,
    };
  }
  return out;
}

/** Planetocentric `[longitude east, latitude]` (degrees) of a body-fixed point. */
export function bodyFixedToLonLat(p: Vec3): [number, number] {
  return [Math.atan2(p[1], p[0]) * DEG, Math.atan2(p[2], Math.hypot(p[0], p[1])) * DEG];
}

/**
 * The surface point (body-fixed km) of the reference ellipsoid at a
 * planetocentric longitude east / latitude — where a given (ODE) footprint
 * vertex sits. Planetocentric: the point is along the direction from the
 * centre, not the ellipsoid normal.
 */
export function lonLatToBodyFixed(lonDeg: number, latDeg: number, radii: Vec3): Vec3 {
  const lon = lonDeg / DEG;
  const lat = latDeg / DEG;
  const d: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const r = 1 / Math.sqrt((d[0] / radii[0]) ** 2 + (d[1] / radii[1]) ** 2 + (d[2] / radii[2]) ** 2);
  return scale(r, d);
}
