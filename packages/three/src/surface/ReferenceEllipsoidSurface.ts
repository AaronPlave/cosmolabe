import type { BodyFixedCartesian } from '../TerrainSampler.js';
import { normalizedRay, type PhysicalSurface, type PhysicalSurfaceMetadata, type SurfaceAccuracy, type SurfaceIntersection, type SurfaceQueryOptions, type SurfaceRay } from './PhysicalSurface.js';

/**
 * Analytic triaxial reference ellipsoid, body-fixed with semi-axes along X/Y/Z.
 *
 * Exact for the reference shape it names, so it reports a zero mesh-deviation
 * bound; its source kind is 'reference-shape', which consumers must not present
 * as terrain. Nearest-hit semantics match every other PhysicalSurface: the first
 * crossing at or beyond `nearKm`, which for an origin inside the shape is the exit.
 */
export class ReferenceEllipsoidSurface implements PhysicalSurface {
  readonly metadata: PhysicalSurfaceMetadata;
  readonly accuracy: SurfaceAccuracy = { meshDeviationBoundKm: 0 };
  readonly radiiKm: readonly [number, number, number];

  constructor(bodyId: string, frame: string, radiiKm: readonly [number, number, number]) {
    if (!radiiKm.every(r => Number.isFinite(r) && r > 0)) throw new Error('Reference ellipsoid requires positive finite radii');
    this.radiiKm = [radiiKm[0], radiiKm[1], radiiKm[2]];
    const [a, b, c] = this.radiiKm;
    this.metadata = {
      bodyId, frame,
      source: { id: `${bodyId}:reference-ellipsoid`, kind: 'reference-shape' },
      shape: a === b && b === c
        ? { kind: 'globe', datum: { referenceShape: { kind: 'sphere', radiusKm: a }, verticalDatum: 'reference-sphere', heightConvention: 'radial' } }
        : { kind: 'globe', datum: { referenceShape: { kind: 'ellipsoid', radiiKm: this.radiiKm }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' } },
      coverage: 'complete-product',
    };
  }

  /** Largest semi-axis: the radius of a sphere that bounds the whole shape. */
  get boundingRadiusKm(): number { return Math.max(...this.radiiKm); }

  /** True when the point lies strictly inside the ellipsoid. */
  contains(point: BodyFixedCartesian): boolean {
    const [a, b, c] = this.radiiKm;
    return (point.xKm / a) ** 2 + (point.yKm / b) ** 2 + (point.zKm / c) ** 2 < 1;
  }

  intersectRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection {
    const d = normalizedRay(ray, options);
    const [a, b, c] = this.radiiKm;
    const metadata = this.metadata, accuracy = this.accuracy;
    // Scale to the unit sphere; the parameter t stays the distance along the unit ray.
    const ox = ray.origin.xKm / a, oy = ray.origin.yKm / b, oz = ray.origin.zKm / c;
    const dx = d[0] / a, dy = d[1] / b, dz = d[2] / c;
    const qa = dx * dx + dy * dy + dz * dz;
    const qb = 2 * (ox * dx + oy * dy + oz * dz);
    const qc = ox * ox + oy * oy + oz * oz - 1;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return { kind: 'miss', metadata, accuracy, detail: 'sufficient' };
    // Numerically stable roots (avoids cancellation for distant observers).
    const sq = Math.sqrt(disc);
    const q = qb >= 0 ? -0.5 * (qb + sq) : -0.5 * (qb - sq);
    const r0 = q / qa, r1 = q !== 0 ? qc / q : r0;
    const t0 = Math.min(r0, r1), t1 = Math.max(r0, r1);
    const t = t0 >= ray.nearKm ? t0 : t1;
    if (!(t >= ray.nearKm && t <= ray.farKm)) return { kind: 'miss', metadata, accuracy, detail: 'sufficient' };
    const x = ray.origin.xKm + t * d[0], y = ray.origin.yKm + t * d[1], z = ray.origin.zKm + t * d[2];
    const nx = x / (a * a), ny = y / (b * b), nz = z / (c * c);
    const nl = Math.hypot(nx, ny, nz);
    return {
      kind: 'hit', position: { xKm: x, yKm: y, zKm: z }, normal: [nx / nl, ny / nl, nz / nl],
      distanceKm: t, triangleIndex: -1, metadata, accuracy, detail: 'sufficient',
    };
  }
}
