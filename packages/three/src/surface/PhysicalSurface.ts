import type { BodyFixedCartesian, TerrainDatum, TerrainSample, TerrainSourceMetadata } from '../TerrainSampler.js';

export type SurfaceVector = readonly [number, number, number];
export interface SurfaceRay {
  origin: BodyFixedCartesian;
  /** Body-fixed direction; normalized by the query, never a world-space ray. */
  direction: SurfaceVector;
  /** Finite inclusive distance interval, km along the normalized ray. */
  nearKm: number;
  farKm: number;
}
export interface SurfaceQueryOptions {
  /** Requested upper bound on mesh deviation from the canonical source, km. */
  maxMeshErrorKm: number;
}
export interface PhysicalSurfaceMetadata {
  bodyId: string;
  /** Body-centered, right-handed, Z-up target frame (e.g. IAU_MARS). */
  frame: string;
  source: TerrainSourceMetadata;
  shape: { kind: 'globe'; datum: TerrainDatum } | { kind: 'mesh' };
  /** Complete means the whole declared product is resident, not that it covers the whole body. */
  coverage: 'complete-product' | 'partial-product';
}
export interface SurfaceAccuracy {
  /** Validated bound, not source uncertainty or a renderer screen-space error. Null = unknown. */
  meshDeviationBoundKm: number | null;
  sourceUncertaintyKm?: number;
}
export interface SurfaceHit {
  kind: 'hit';
  position: BodyFixedCartesian;
  /** Unit normal from triangle winding; not automatically flipped toward the observer. */
  normal: SurfaceVector;
  distanceKm: number;
  triangleIndex: number;
  tileId?: string;
  metadata: PhysicalSurfaceMetadata;
  accuracy: SurfaceAccuracy;
  /** Partial-product hits are provisional nearest hits; absent data may occlude them. */
  detail: 'sufficient' | 'coarse';
}
export type SurfaceIntersection = SurfaceHit
  | { kind: 'miss'; metadata: PhysicalSurfaceMetadata; accuracy: SurfaceAccuracy; detail: 'sufficient' | 'coarse' }
  | { kind: 'unavailable'; reason: 'not-resident' | 'partial-coverage' | 'budget' | 'unsupported-datum'; metadata: PhysicalSurfaceMetadata };

/** CPU source port: no Three.js scene, body attitude, floating origin or imagery residency. */
export interface PhysicalSurface {
  readonly metadata: PhysicalSurfaceMetadata;
  intersectRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection;
  /** Optional globe capability: degrees north/east, oblate geodetic latitude.
   * Meshes do not invent a latitude/longitude height. */
  sampleElevation?(latDeg: number, lonDeg: number): TerrainSample | null;
}
export interface SurfaceQueryLoader {
  /** Source owns addressing, download/decode, budgets and shared-request reference counts. */
  ensureRayCoverage(ray: SurfaceRay, options: SurfaceQueryOptions, signal: AbortSignal): Promise<void>;
}

/** One bounded load attempt, then requery; never polls or substitutes an ellipsoid. */
export async function requestSurfaceIntersection(
  surface: PhysicalSurface, ray: SurfaceRay, options: SurfaceQueryOptions,
  signal: AbortSignal, loader?: SurfaceQueryLoader,
): Promise<SurfaceIntersection> {
  signal.throwIfAborted();
  const first = surface.intersectRay(ray, options);
  if (!loader || (first.kind !== 'unavailable' && first.detail === 'sufficient')) return first;
  await loader.ensureRayCoverage(ray, options, signal);
  signal.throwIfAborted();
  return surface.intersectRay(ray, options);
}

export function normalizedRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceVector {
  const { xKm, yKm, zKm } = ray.origin;
  const length = Math.hypot(...ray.direction);
  if (![xKm, yKm, zKm, ...ray.direction, ray.nearKm, ray.farKm, options.maxMeshErrorKm].every(Number.isFinite)
    || !Number.isFinite(length) || length === 0 || ray.nearKm < 0 || ray.farKm < ray.nearKm || options.maxMeshErrorKm < 0) {
    throw new Error('Surface query requires finite coordinates, a nonzero direction and nonnegative bounds');
  }
  return ray.direction.map(v => v / length) as [number, number, number];
}
