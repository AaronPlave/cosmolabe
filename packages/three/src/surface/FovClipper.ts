/**
 * Sensor FOV clipping against physical surfaces (issue #27). Pure geometry:
 * no Three.js scene, no SPICE, no renderer state.
 *
 * An FOV is a closed perimeter of rays from the instrument origin. Each ray ends
 * at the nearest eligible physical-surface hit, otherwise at the maximum
 * visualization range. The perimeter is sampled at fixed base parameters and
 * then refined adaptively where neighbouring samples disagree (hit vs miss, or
 * different bodies), where a body could cross between two misses, and
 * where a hit-hit chord sags visibly off the surface — instead of raising the
 * global segment count.
 *
 * Surface queries go through `PhysicalSurface` in each body's body-fixed frame,
 * so reference ellipsoids, resident terrain and irregular meshes share one
 * nearest-hit contract. This is renderer clipping, not an observation-footprint
 * oracle: no light time, aberration or DSK certification is implied.
 */
import type { BodyFixedCartesian } from '../TerrainSampler.js';
import type { PhysicalSurface, SurfaceIntersection, SurfaceQueryOptions, SurfaceRay } from './PhysicalSurface.js';
import { ReferenceEllipsoidSurface } from './ReferenceEllipsoidSurface.js';

export type Vec3 = readonly [number, number, number];

/** Instrument-frame FOV boundary: +Z boresight, +X horizontal, +Y vertical. */
export type FovBoundaryShape =
  | { kind: 'elliptical'; tanHalfH: number; tanHalfV: number }
  /** Boundary vertices in order (e.g. SPICE getfov RECTANGLE/POLYGON bounds). Edges are planar faces. */
  | { kind: 'polygon'; vertices: readonly Vec3[] };

export interface FovSurfaceCandidate {
  /** Body identifier reported back on hits. */
  id: string;
  /** Body center, same frame and origin as the ray origin (km). */
  centerKm: Vec3;
  /** Row-major 3×3 rotation taking body-fixed vectors to the ray frame. */
  bodyToWorld: readonly number[];
  /** Sphere around `centerKm` that encloses every surface, for cheap rejection. */
  boundingRadiusKm: number;
  /**
   * Physical surfaces in body-fixed km, most detailed first. A surface that
   * answers 'hit' or 'miss' is authoritative; only 'unavailable' falls through
   * to the next (normally the reference shape) so missing terrain never makes
   * the sensor ignore an explicitly available reference body.
   */
  surfaces: readonly PhysicalSurface[];
}

/** Where a hit came from, so diagnostics never present a reference shape as terrain. */
export type FovSurfaceSource = 'reference' | 'terrain' | 'mesh';

export interface FovRayHit {
  candidateId: string;
  /** Distance to the surface along the unit ray, before any standoff (km). */
  surfaceDistanceKm: number;
  source: FovSurfaceSource;
  detail: 'sufficient' | 'coarse';
  /** True when a more detailed surface was unavailable and a later one answered. */
  fallback: boolean;
}

export interface FovPerimeterSample {
  /** Perimeter parameter in [0, 1). */
  t: number;
  /** Unit direction in the ray frame. */
  direction: Vec3;
  /** Rendered endpoint distance: surface hit less standoff, or the max range (km). */
  distanceKm: number;
  hit: FovRayHit | null;
  /** True for the fixed base samples (stable across frames, e.g. for side lines). */
  base: boolean;
}

export interface FovClipOptions {
  maxRangeKm: number;
  /** Pull surface endpoints toward the sensor by this much (km) to avoid coplanar z-fighting. */
  surfaceStandoffKm?: number;
  /** Bisection cap for hit/miss and body-to-body transitions. */
  maxTransitionDepth?: number;
  /** Bisection cap for hit-hit chord smoothing. */
  maxSmoothDepth?: number;
  /**
   * Hit-hit tolerance: how far the midpoint ray's range may differ from the
   * average of its neighbours', as a fraction of the chord between them. This
   * measures the surface bending away from the chord, not the FOV outline's own
   * curvature, so a flat-on FOV is not subdivided at all.
   */
  smoothTolerance?: number;
  /** Hard cap on perimeter samples, base included. */
  maxSamples?: number;
  surfaceQuery?: SurfaceQueryOptions;
}

const DEFAULTS = {
  surfaceStandoffKm: 0.001,
  maxTransitionDepth: 12,
  maxSmoothDepth: 4,
  smoothTolerance: 0.01,
  maxSamples: 4096,
  surfaceQuery: { maxMeshErrorKm: 0.001 } as SurfaceQueryOptions,
};

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v: Vec3): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const angleBetween = (a: Vec3, b: Vec3) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

/** Classify a surface for diagnostics. */
export function surfaceSource(surface: PhysicalSurface): FovSurfaceSource {
  if (surface.metadata.source.kind === 'reference-shape') return 'reference';
  return surface.metadata.shape.kind === 'mesh' ? 'mesh' : 'terrain';
}

/** Unit instrument-frame direction at perimeter parameter t ∈ [0, 1). */
export function fovBoundaryDirection(shape: FovBoundaryShape, t: number): [number, number, number] {
  const u = ((t % 1) + 1) % 1;
  if (shape.kind === 'elliptical') {
    const theta = 2 * Math.PI * u;
    return normalize([shape.tanHalfH * Math.cos(theta), shape.tanHalfV * Math.sin(theta), 1]);
  }
  const n = shape.vertices.length;
  const x = u * n, i = Math.min(n - 1, Math.floor(x)), s = x - i;
  const a = normalize(shape.vertices[i]), b = normalize(shape.vertices[(i + 1) % n]);
  // Linear blend of unit vectors stays on the great circle through a and b: the
  // planar face between two boundary vectors, exactly as a pyramid side.
  return normalize([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]);
}

/**
 * Fixed base perimeter parameters. Polygons are sampled along every edge, not
 * only at corners, and always include the corners themselves.
 */
export function fovBaseParams(shape: FovBoundaryShape, segments = 32): number[] {
  if (shape.kind === 'elliptical') return Array.from({ length: Math.max(3, segments) }, (_, i) => i / Math.max(3, segments));
  const n = shape.vertices.length;
  const perEdge = Math.max(1, Math.round(segments / n));
  return Array.from({ length: n * perEdge }, (_, i) => i / (n * perEdge));
}

/** Rectangle corners in instrument frame, counter-clockwise from (-h, -v). */
export function rectangularFov(tanHalfH: number, tanHalfV: number): FovBoundaryShape {
  return { kind: 'polygon', vertices: [[-tanHalfH, -tanHalfV, 1], [tanHalfH, -tanHalfV, 1], [tanHalfH, tanHalfV, 1], [-tanHalfH, tanHalfV, 1]] };
}

function toBodyFixed(m: readonly number[], v: Vec3): BodyFixedCartesian {
  // Transpose of body→world takes world vectors into the body-fixed frame.
  return {
    xKm: m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    yKm: m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    zKm: m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  };
}

/** Bounding-sphere test: can the ray reach the candidate within `farKm`? */
function mayIntersect(origin: Vec3, dir: Vec3, c: FovSurfaceCandidate, farKm: number): boolean {
  const rel: Vec3 = [c.centerKm[0] - origin[0], c.centerKm[1] - origin[1], c.centerKm[2] - origin[2]];
  const r = c.boundingRadiusKm, d2 = dot(rel, rel);
  if (d2 <= r * r) return true;
  const along = dot(rel, dir);
  if (along <= 0) return false;
  if (d2 - along * along > r * r) return false;
  return along - Math.sqrt(Math.max(0, r * r - (d2 - along * along))) <= farKm;
}

/** Nearest eligible physical-surface hit along one ray, or null. */
export function resolveFovRay(
  originKm: Vec3, direction: Vec3, candidates: readonly FovSurfaceCandidate[],
  maxRangeKm: number, query: SurfaceQueryOptions = DEFAULTS.surfaceQuery,
): FovRayHit | null {
  const dir = normalize(direction);
  let best: FovRayHit | null = null;
  for (const c of candidates) {
    const farKm: number = best ? best.surfaceDistanceKm : maxRangeKm;
    if (!mayIntersect(originKm, dir, c, farKm)) continue;
    const m = c.bodyToWorld;
    const origin = toBodyFixed(m, [originKm[0] - c.centerKm[0], originKm[1] - c.centerKm[1], originKm[2] - c.centerKm[2]]);
    const bf = toBodyFixed(m, dir);
    const ray: SurfaceRay = { origin, direction: [bf.xKm, bf.yKm, bf.zKm], nearKm: 0, farKm };
    let fellBack = false;
    for (const surface of c.surfaces) {
      // An observer inside a reference shape (e.g. a rover below the datum) is
      // not occluded by it; that ray's exit point is not a physical surface.
      if (surface instanceof ReferenceEllipsoidSurface && surface.contains(origin)) break;
      const result: SurfaceIntersection = surface.intersectRay(ray, query);
      if (result.kind === 'unavailable') { fellBack = true; continue; }
      if (result.kind === 'hit' && result.distanceKm <= farKm) {
        best = { candidateId: c.id, surfaceDistanceKm: result.distanceKm, source: surfaceSource(surface), detail: result.detail, fallback: fellBack };
      }
      break;
    }
  }
  return best;
}

/** Smallest angle from unit `p` to the great-circle arc a→b (shorter arc). */
function angleToArc(p: Vec3, a: Vec3, b: Vec3): number {
  const n = cross(a, b), nl = Math.hypot(...n);
  if (nl < 1e-15) return angleBetween(p, a);
  const nn: Vec3 = [n[0] / nl, n[1] / nl, n[2] / nl];
  const pn = dot(p, nn);
  const proj: Vec3 = [p[0] - pn * nn[0], p[1] - pn * nn[1], p[2] - pn * nn[2]];
  if (dot(cross(a, proj), nn) >= 0 && dot(cross(proj, b), nn) >= 0 && Math.hypot(...proj) > 0) {
    return Math.asin(Math.min(1, Math.abs(pn)));
  }
  return Math.min(angleBetween(p, a), angleBetween(p, b));
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * Where, strictly inside (ta, tb), could a candidate's surface cross the
 * perimeter even though both endpoints miss? Returns the parameter of closest
 * approach for the first candidate whose shape that approach enters, or null.
 *
 * The test is made in the candidate's reference-ellipsoid space (body-fixed,
 * divided by the radii), where the shape is a unit sphere: a ray hits it iff
 * its angle to the scaled center is below asin(1 / |center|). The angle along
 * one perimeter interval is unimodal, so its minimum (golden-section search)
 * is the ray most likely to hit. That makes the probe exact for reference
 * shapes regardless of how short the interval is, and costs one ray per
 * interval per candidate. Terrain/mesh candidates use the same search with the
 * shape inflated to their bounding radius, so a probe is only a best guess there.
 */
function probeParam(
  origin: Vec3, directionAt: (t: number) => Vec3, ta: number, tb: number, a: Vec3, b: Vec3,
  candidates: readonly FovSurfaceCandidate[], maxRangeKm: number,
): number | null {
  for (const c of candidates) {
    const rel: Vec3 = [c.centerKm[0] - origin[0], c.centerKm[1] - origin[1], c.centerKm[2] - origin[2]];
    const dist = Math.hypot(...rel);
    if (dist <= c.boundingRadiusKm || dist - c.boundingRadiusKm > maxRangeKm) continue;
    // Cheap conservative reject: bounding cone vs the chord arc, with slack for
    // perimeters (ellipses) that bow slightly off the great circle between samples.
    const slack = 0.05 * angleBetween(a, b);
    if (angleToArc(normalize(rel), a, b) >= Math.asin(c.boundingRadiusKm / dist) + slack) continue;

    const reference = c.surfaces.find((s): s is ReferenceEllipsoidSurface => s instanceof ReferenceEllipsoidSurface);
    const radii = reference?.radiiKm ?? [c.boundingRadiusKm, c.boundingRadiusKm, c.boundingRadiusKm];
    const inflate = reference ? c.boundingRadiusKm / reference.boundingRadiusKm : 1;
    const m = c.bodyToWorld;
    const scaled = (v: Vec3): Vec3 => {
      const bf = toBodyFixed(m, v);
      return [bf.xKm / radii[0], bf.yKm / radii[1], bf.zKm / radii[2]];
    };
    const center = scaled(rel);
    const centerLen = Math.hypot(...center);
    if (centerLen <= inflate) continue; // origin inside the (inflated) shape: nothing to probe
    const threshold = Math.asin(inflate / centerLen);
    const centerDir = normalize(center);
    const angleAt = (t: number) => angleBetween(normalize(scaled(directionAt(((t % 1) + 1) % 1))), centerDir);

    let lo = ta, hi = tb;
    let x1 = hi - GOLDEN * (hi - lo), x2 = lo + GOLDEN * (hi - lo);
    let f1 = angleAt(x1), f2 = angleAt(x2);
    for (let i = 0; i < 48 && hi - lo > 1e-12; i++) {
      if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - GOLDEN * (hi - lo); f1 = angleAt(x1); }
      else { lo = x1; x1 = x2; f1 = f2; x2 = lo + GOLDEN * (hi - lo); f2 = angleAt(x2); }
    }
    const t = (lo + hi) / 2;
    // A minimum at an endpoint means that (missing) endpoint was the best chance.
    const edge = 1e-6 * (tb - ta);
    if (t - ta <= edge || tb - t <= edge) continue;
    if (angleAt(t) < threshold) return t;
  }
  return null;
}

/**
 * Clip a closed FOV perimeter. `directionAt(t)` returns the boundary direction
 * in the ray frame; `baseParams` are sorted parameters in [0, 1). Returns the
 * perimeter in order, base samples plus any refinements.
 */
export function clipFovPerimeter(
  originKm: Vec3,
  directionAt: (t: number) => Vec3,
  baseParams: readonly number[],
  candidates: readonly FovSurfaceCandidate[],
  options: FovClipOptions,
): FovPerimeterSample[] {
  const o = { ...DEFAULTS, ...options };
  const maxRange = o.maxRangeKm;
  let budget = o.maxSamples;
  const sample = (t: number, base: boolean): FovPerimeterSample => {
    budget--;
    const direction = normalize(directionAt(((t % 1) + 1) % 1));
    const hit = candidates.length ? resolveFovRay(originKm, direction, candidates, maxRange, o.surfaceQuery) : null;
    const distanceKm = hit ? Math.max(0, hit.surfaceDistanceKm - o.surfaceStandoffKm) : maxRange;
    return { t: ((t % 1) + 1) % 1, direction, distanceKm, hit, base };
  };
  const endpoint = (s: FovPerimeterSample): Vec3 => [s.direction[0] * s.distanceKm, s.direction[1] * s.distanceKm, s.direction[2] * s.distanceKm];
  const sameState = (a: FovPerimeterSample, b: FovPerimeterSample) => (a.hit?.candidateId ?? null) === (b.hit?.candidateId ?? null);

  const out: FovPerimeterSample[] = [];
  const refine = (a: FovPerimeterSample, ta: number, b: FovPerimeterSample, tb: number, depth: number) => {
    if (budget <= 0) return;
    const transition = !sameState(a, b);
    const smooth = !transition && a.hit != null;
    const probe = !transition && !smooth && candidates.length > 0
      ? probeParam(originKm, directionAt, ta, tb, a.direction, b.direction, candidates, maxRange)
      : null;
    if (!transition && !smooth && probe == null) return;
    if (depth >= (smooth ? o.maxSmoothDepth : o.maxTransitionDepth)) return;
    const tm = probe ?? (ta + tb) / 2;
    const m = sample(tm, false);
    if (smooth && sameState(a, m)) {
      const pa = endpoint(a), pb = endpoint(b);
      const rangeError = Math.abs(m.distanceKm - (a.distanceKm + b.distanceKm) / 2);
      if (rangeError <= o.smoothTolerance * Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2])) return;
    }
    refine(a, ta, m, tm, depth + 1);
    out.push(m);
    refine(m, tm, b, tb, depth + 1);
  };

  const base = baseParams.map(t => sample(t, true));
  for (let i = 0; i < base.length; i++) {
    const a = base[i], b = base[(i + 1) % base.length];
    const ta = baseParams[i], tb = i + 1 < base.length ? baseParams[i + 1] : baseParams[0] + 1;
    out.push(a);
    refine(a, ta, b, tb, 0);
  }
  return out;
}
