import { geodeticToBodyFixed, geographicAbsolutePosition, isSupportedGeodeticDatum,
  type BodyFixedPosition, type BodyFixedCartesian, type GeographicLayer } from '@cosmolabe/core';
import type { PhysicalSurface } from './PhysicalSurface.js';

/** Resolves imported data against physical coordinates only. No mesh exaggeration, scene scale or fallback heights. */
export function geographicPositionOnSurface(
  layer: GeographicLayer, position: BodyFixedPosition, surface?: PhysicalSurface,
): BodyFixedCartesian | null {
  const absolute = geographicAbsolutePosition(position, layer.datum);
  if (absolute) return absolute;
  if (!surface || surface.metadata.bodyId !== layer.body || surface.metadata.frame !== layer.frame) return null;
  const sample = surface.sampleElevation?.(position.latDeg, position.lonDeg);
  if (!sample || !isSupportedGeodeticDatum(sample.datum)) return null;
  const a = sample.datum.referenceShape, b = layer.datum.referenceShape;
  if (a.kind !== b.kind) return null;
  if (a.kind === 'sphere' && b.kind === 'sphere' && a.radiusKm !== b.radiusKm) return null;
  if (a.kind === 'ellipsoid' && b.kind === 'ellipsoid' && a.radiiKm.some((radius, index) => radius !== b.radiiKm[index])) return null;
  return geodeticToBodyFixed({ ...position, heightKm: sample.elevationKm }, sample.datum);
}
