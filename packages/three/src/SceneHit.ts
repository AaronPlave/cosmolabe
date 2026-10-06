/**
 * One scene hit-test abstraction, several interaction intents (#127).
 *
 * The renderer discovers what is under the pointer one layer at a time —
 * event glyphs, screen-space labels, body meshes, rendered surfaces — and
 * each intent decides which layers it consults and in what order. Normal
 * selection wants a label before the planet behind it; the point probe wants
 * the planet's surface and nothing else. They share discovery and the result
 * model rather than each tool growing its own raycast.
 *
 * Nothing here holds renderer or UI state: a hit is plain data that a host can
 * keep, copy, or hand to another tool (a measurement endpoint, #57).
 */

import type { HeightConvention, TerrainDatum, VerticalDatum } from './TerrainSampler.js';

/** What answered a surface hit. */
export type SurfaceHitSource =
  /** Streamed terrain tiles in the main scene. */
  | 'terrain'
  /** Camera-relative surface tile overlays (drawn over the globe). */
  | 'surface-overlay'
  /** The body's reference globe (sphere or IAU ellipsoid) mesh. */
  | 'ellipsoid'
  /** A shape model. Reserved; not produced yet. */
  | 'mesh'
  /** An irregular-body DSK. Reserved; not produced yet (#107). */
  | 'dsk';

/** The reference surface heights are measured from. */
export interface SurfaceDatum {
  referenceShape: TerrainDatum['referenceShape'];
  verticalDatum: VerticalDatum;
  heightConvention: HeightConvention;
  /**
   * `terrain`: the datum the body's terrain product declares. `body-shape`:
   * no terrain datum, so the body's own reference sphere/ellipsoid.
   */
  origin: 'terrain' | 'body-shape';
}

/**
 * A point on a body's surface as a reusable spatial reference.
 *
 * The rendered intersection and the physical surface are kept apart: the
 * Cartesian position is exactly where the renderer's ray hit (it keeps a
 * marker on what the user clicked), while the altitude says whether it comes
 * from the CPU terrain sampler or only from that rendered hit.
 */
export interface SurfacePoint {
  bodyName: string;
  /** Rendered hit, body-fixed right-handed Z-up (ECEF-style) km. */
  bodyFixedPositionKm: readonly [number, number, number];
  source: SurfaceHitSource;
  /** Degrees north. */
  latDeg: number;
  /** Degrees east, (-180, 180]. */
  lonDeg: number;
  /** Geodetic from a terrain datum; planetocentric from the radial fallback. */
  latitudeKind: 'geodetic' | 'planetocentric';
  altitude: {
    km: number;
    /**
     * `sampled-terrain`: decoded CPU terrain at this location. `rendered-hit`:
     * the rendered intersection's height above the datum (no terrain sample).
     */
    from: 'sampled-terrain' | 'rendered-hit';
    datum: SurfaceDatum;
  };
  /** Height of the rendered hit above the datum, for comparison with a sample. */
  renderedHeightKm: number;
  /** Terrain product that answered the sample, when there was one. */
  terrainSourceId?: string;
  terrainTileId?: string;
}

export type SceneHit =
  | { kind: 'event'; eventId: string; queryId: string; et: number; boundary?: 'start' | 'end' }
  | { kind: 'entity'; bodyName: string; via: 'label' | 'mesh' }
  | {
      kind: 'surface';
      point: SurfacePoint;
      /** Camera-to-point range at hit time, km. Diagnostic, not a property of the point. */
      cameraRangeKm: number;
    };

/**
 * Why the host is asking. Each intent owns its hit precedence:
 * - `select`: event glyph → label → body (normal click selection).
 * - `probe`: rendered surface only (Point Probe).
 * - `endpoint`: a named entity by its label, else a surface point, else the
 *   body (measurement endpoints, #57).
 * - `pivot`: rendered surface only (Surface Explorer orbit pivot).
 */
export type PickIntent = 'select' | 'probe' | 'endpoint' | 'pivot';

/** The discovery layers the renderer can consult. */
export type HitLayer = 'event' | 'label' | 'body' | 'surface';

export const PICK_PRECEDENCE: Readonly<Record<PickIntent, readonly HitLayer[]>> = {
  select: ['event', 'label', 'body'],
  probe: ['surface'],
  endpoint: ['label', 'surface', 'body'],
  pivot: ['surface'],
};

/**
 * First hit in the intent's precedence. Layers are discovered lazily, so an
 * intent never pays for a raycast a higher-priority layer already made moot.
 */
export function resolveSceneHit(
  intent: PickIntent,
  discover: Readonly<Record<HitLayer, () => SceneHit | null>>,
): SceneHit | null {
  for (const layer of PICK_PRECEDENCE[intent]) {
    const hit = discover[layer]();
    if (hit) return hit;
  }
  return null;
}

// ── Presentation helpers (shared by the in-scene callout and host panels) ──

export function formatLatitude(latDeg: number, decimals = 4): string {
  return `${Math.abs(latDeg).toFixed(decimals)}° ${latDeg >= 0 ? 'N' : 'S'}`;
}

export function formatLongitude(lonDeg: number, decimals = 4): string {
  return `${Math.abs(lonDeg).toFixed(decimals)}° ${lonDeg >= 0 ? 'E' : 'W'}`;
}

/** Signed height in metres below 10 km, kilometres above. */
export function formatHeight(km: number): string {
  const sign = km < 0 ? '−' : '+';
  const abs = Math.abs(km);
  return abs < 10 ? `${sign}${(abs * 1000).toFixed(1)} m` : `${sign}${abs.toFixed(3)} km`;
}

/** Short name of the reference surface heights are measured from. */
export function describeDatum(datum: SurfaceDatum): string {
  switch (datum.verticalDatum) {
    case 'areoid': return 'areoid';
    case 'ellipsoid': return 'ellipsoid';
    case 'reference-sphere': {
      const shape = datum.referenceShape;
      return shape.kind === 'sphere' ? `sphere R ${shape.radiusKm.toFixed(1)} km` : 'reference sphere';
    }
    default: return 'unknown datum';
  }
}

export function describeSource(source: SurfaceHitSource): string {
  switch (source) {
    case 'terrain': return 'terrain';
    case 'surface-overlay': return 'surface tiles';
    case 'ellipsoid': return 'reference globe';
    case 'mesh': return 'shape model';
    case 'dsk': return 'DSK';
  }
}

/** One line suitable for the clipboard: body, coordinates, height and datum. */
export function surfacePointToText(point: SurfacePoint): string {
  const lat = point.latDeg.toFixed(6);
  const lon = point.lonDeg.toFixed(6);
  const h = (point.altitude.km * 1000).toFixed(1);
  const kind = point.latitudeKind === 'geodetic' ? 'geodetic' : 'planetocentric';
  return `${point.bodyName} ${lat}, ${lon} (${kind} °N, °E) ${h} m above ${describeDatum(point.altitude.datum)}`;
}
