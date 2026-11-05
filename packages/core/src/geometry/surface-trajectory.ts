import type { TerrainDatum } from '../geographic/coordinates.js';
import type { FrameRegistry } from '../frames/FrameRegistry.js';

/** Provenance for supplied absolute positions. It describes input coordinates;
 * it never requests terrain correction, resampling or a vertical offset. */
export interface SurfaceTrajectoryProvenance {
  frame: string;
  positionUnits: 'km';
  datum: TerrainDatum;
  /** Omit when no terrain product was used during planning. */
  terrainRevision?: string;
  purpose: 'supplied' | 'synthetic-demo';
}
export interface SurfaceTrajectoryDiagnostic {
  code: 'missing-transform' | 'frame-disagreement' | 'datum-disagreement' | 'terrain-revision-disagreement';
  message: string;
}
export interface SurfaceTrajectoryAvailability {
  kind: 'available' | 'unavailable';
  diagnostics: SurfaceTrajectoryDiagnostic[];
}

/** A compatible placement needs a transform, not equal frame names. Datum or
 * planning revision disagreements remain diagnostics: absolute positions stay
 * supplied positions even when they lie below the current terrain. */
export function surfaceTrajectoryAvailability(
  provenance: SurfaceTrajectoryProvenance,
  context: { frame: string; datum: TerrainDatum; terrainRevision?: string },
  frames: FrameRegistry, et: number,
): SurfaceTrajectoryAvailability {
  const diagnostics: SurfaceTrajectoryDiagnostic[] = [];
  let available = false;
  try {
    // Even identical names require orientation coverage for absolute placement.
    available = !!frames.rotation(provenance.frame, context.frame, et) && frames.isResolvable(context.frame, et);
  } catch { /* Missing coverage is an availability result, not an identity. */ }
  if (!available) diagnostics.push({ code: 'missing-transform', message: `Orientation unavailable: ${provenance.frame} -> ${context.frame} at ET ${et}` });
  if (!frames.sameFrame(provenance.frame, context.frame)) diagnostics.push({ code: 'frame-disagreement', message: `Input frame ${provenance.frame}; surface frame ${context.frame}. Supplied positions require a frame transform.` });
  const a = provenance.datum, b = context.datum;
  const radii = (datum: TerrainDatum) => datum.referenceShape.kind === 'sphere'
    ? [datum.referenceShape.radiusKm, datum.referenceShape.radiusKm, datum.referenceShape.radiusKm] : datum.referenceShape.radiiKm;
  if (a.verticalDatum === 'unknown' || b.verticalDatum === 'unknown' || a.verticalDatum !== b.verticalDatum || a.heightConvention !== b.heightConvention || a.referenceShape.kind !== b.referenceShape.kind ||
      radii(a).some((r, i) => r !== radii(b)[i])) {
    diagnostics.push({ code: 'datum-disagreement', message: 'Input and surface reference shape or vertical datum differ. No vertical correction is applied.' });
  }
  if (provenance.terrainRevision !== undefined && provenance.terrainRevision !== context.terrainRevision) diagnostics.push({
    code: 'terrain-revision-disagreement', message: `Planned on ${provenance.terrainRevision}; current terrain ${context.terrainRevision ?? 'unknown'}. No terrain adjustment is applied.`,
  });
  return { kind: available ? 'available' : 'unavailable', diagnostics };
}

export function validateSurfaceTrajectoryProvenance(value: SurfaceTrajectoryProvenance): void {
  const shape = value?.datum?.referenceShape;
  const radii = shape?.kind === 'sphere' ? [shape.radiusKm] : shape?.kind === 'ellipsoid' ? shape.radiiKm : [];
  if (!value || typeof value.frame !== 'string' || !value.frame.trim() || value.positionUnits !== 'km' ||
      !['supplied', 'synthetic-demo'].includes(value.purpose) || (shape?.kind === 'ellipsoid' && radii.length !== 3) || !radii.length || radii.some(r => !Number.isFinite(r) || r <= 0) ||
      !['reference-sphere', 'ellipsoid', 'areoid', 'unknown'].includes(value.datum.verticalDatum) ||
      !['radial', 'geodetic-normal'].includes(value.datum.heightConvention) ||
      (value.terrainRevision !== undefined && (typeof value.terrainRevision !== 'string' || !value.terrainRevision.trim()))) {
    throw new Error('surfaceTrajectory requires an explicit frame, km positions, physical datum, purpose and optional nonempty terrainRevision');
  }
}
