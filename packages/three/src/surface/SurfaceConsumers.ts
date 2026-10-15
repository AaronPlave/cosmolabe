import type { BodyFixedCartesian } from '../TerrainSampler.js';
import { normalizedRay, type PhysicalSurface, type SurfaceIntersection, type SurfaceQueryOptions, type SurfaceRay } from './PhysicalSurface.js';

/** Caller transforms a screen ray to the surface frame; the result retains availability and quality. */
export function pickPhysicalSurface(surface: PhysicalSurface, ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection {
  return surface.intersectRay(ray, options);
}

/**
 * Camera placement proof: move to a picked surface plus outward-normal clearance.
 * A provisional hit requires explicit opt-in; unavailable/miss never produce a camera position.
 * This does not claim swept-volume collision safety or an irregular-body ENU walk.
 */
export function cameraPositionFromSurfacePick(
  result: SurfaceIntersection, clearanceKm: number, allowCoarse = false,
): BodyFixedCartesian | null {
  if (!Number.isFinite(clearanceKm) || clearanceKm < 0) throw new Error('Invalid surface clearance');
  if (result.kind !== 'hit' || (result.detail === 'coarse' && !allowCoarse)) return null;
  return {
    xKm: result.position.xKm + result.normal[0] * clearanceKm,
    yKm: result.position.yKm + result.normal[1] * clearanceKm,
    zKm: result.position.zKm + result.normal[2] * clearanceKm,
  };
}

/** Body-fixed unit ray helper for picking/camera adapters; no world transform is hidden here. */
export function surfaceRayBetween(start: BodyFixedCartesian, end: BodyFixedCartesian): SurfaceRay {
  const direction = [end.xKm - start.xKm, end.yKm - start.yKm, end.zKm - start.zKm] as const;
  const ray = { origin: start, direction, nearKm: 0, farKm: Math.hypot(...direction) };
  normalizedRay(ray, { maxMeshErrorKm: 0 });
  return ray;
}
