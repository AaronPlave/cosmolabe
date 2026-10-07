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
 * The surface that was hit and the physical terrain product are separate
 * records. `bodyFixedPositionKm` and `hit` always describe the rendered
 * surface the ray struck (they keep a marker on what the user clicked). A
 * terrain sample at the same latitude/longitude is kept apart in
 * `terrainSample`, with its own datum and provenance, because it may describe
 * a different surface: a photogrammetry overlay hit sits over the global
 * terrain product, not on it. `altitude` promotes the sample only when it
 * describes the hit surface.
 */
/**
 * What one screen pixel can span at a hit: the worst direction along the
 * surface, and that span in each coordinate. An upper bound, not a
 * measurement of the pick's accuracy.
 */
export interface PointerResolution {
  /** Km along the surface, corrected for the angle the view ray meets it at. */
  surfaceKm: number;
  /** Degrees of latitude that span covers. */
  latDeg: number;
  /** Degrees of longitude it covers; grows toward the poles as meridians converge. */
  lonDeg: number;
}

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
  /**
   * How finely the pointer could place this point, from a one-pixel step on
   * screen at the hit (`pointerResolution`). Coordinates are shown to this
   * resolution (`coordinateDecimals`) and never finer.
   */
  resolution: PointerResolution;
  /** The hit itself: the height of `bodyFixedPositionKm` above `datum`. */
  hit: { heightKm: number; datum: SurfaceDatum };
  /**
   * The body's terrain product sampled at this latitude/longitude, when it has
   * decoded coverage there. `describesHit` is true only when that product is
   * the surface that was hit (`source === 'terrain'`); otherwise it is a
   * different surface at the same place, never this point's elevation.
   */
  terrainSample?: {
    elevationKm: number;
    datum: SurfaceDatum;
    sourceId: string;
    tileId?: string;
    describesHit: boolean;
  };
  /**
   * The height to present for this point: the terrain sample when it
   * describes the hit surface, otherwise the hit's own height.
   */
  altitude: {
    km: number;
    from: 'terrain-sample' | 'rendered-hit';
    datum: SurfaceDatum;
  };
}

/**
 * Attach a terrain sample to a hit and choose the altitude to present. The
 * sample describes the hit only when the terrain product is what was hit;
 * over any other surface (an overlay, the reference globe) it stays a
 * separate record and the hit keeps its own height.
 */
export function resolveSurfaceAltitude(
  source: SurfaceHitSource,
  hit: SurfacePoint['hit'],
  sample?: Omit<NonNullable<SurfacePoint['terrainSample']>, 'describesHit'>,
): Pick<SurfacePoint, 'altitude' | 'terrainSample'> {
  if (!sample) return { altitude: { km: hit.heightKm, from: 'rendered-hit', datum: hit.datum } };
  const terrainSample = { ...sample, describesHit: source === 'terrain' };
  return {
    terrainSample,
    altitude: terrainSample.describesHit
      ? { km: sample.elevationKm, from: 'terrain-sample', datum: sample.datum }
      : { km: hit.heightKm, from: 'rendered-hit', datum: hit.datum },
  };
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

/** Below this incidence cosine (about 89.9°) a pixel's span is treated as this stretched. */
const MIN_INCIDENCE_COS = 1e-3;

/**
 * What a one-pixel step on screen can cover at a hit. `pixelSpanKm` is the
 * pixel's width across the view ray at the hit's range; `incidenceCos` is
 * |cos| of the angle between the view ray and the surface normal there. A
 * pixel's footprint stretches by 1/cos along the tilt, without bound toward
 * the horizon, so a grazing view resolves little. Longitude degrees shrink
 * with cos(latitude), so the same span is more degrees of longitude toward a
 * pole.
 */
export function pointerResolution(
  pixelSpanKm: number, incidenceCos: number, radiusKm: number, latDeg: number,
): PointerResolution {
  const surfaceKm = pixelSpanKm / Math.max(MIN_INCIDENCE_COS, Math.abs(incidenceCos));
  const kmPerDegree = radiusKm * Math.PI / 180;
  const meridianScale = Math.max(1e-9, Math.cos(latDeg * Math.PI / 180));
  return {
    surfaceKm,
    latDeg: surfaceKm / kmPerDegree,
    lonDeg: surfaceKm / (kmPerDegree * meridianScale),
  };
}

/** Decimal places that resolve `degPerPixel`, and no more; clamped to 0–8. */
function decimalsFor(degPerPixel: number): number {
  if (!(degPerPixel > 0) || !Number.isFinite(degPerPixel)) return 0;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(degPerPixel))));
}

/**
 * Decimal places for each coordinate: enough that neighbouring pixels read
 * differently, no more. Separate because longitude's resolution falls off
 * toward the poles.
 */
export function coordinateDecimals(point: Pick<SurfacePoint, 'resolution'>): { lat: number; lon: number } {
  return { lat: decimalsFor(point.resolution.latDeg), lon: decimalsFor(point.resolution.lonDeg) };
}

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
  // A reference to paste elsewhere keeps at least six decimals.
  const decimals = coordinateDecimals(point);
  const lat = point.latDeg.toFixed(Math.max(6, decimals.lat));
  const lon = point.lonDeg.toFixed(Math.max(6, decimals.lon));
  const h = (point.altitude.km * 1000).toFixed(1);
  const kind = point.latitudeKind === 'geodetic' ? 'geodetic' : 'planetocentric';
  return `${point.bodyName} ${lat}, ${lon} (${kind} °N, °E) ${h} m above ${describeDatum(point.altitude.datum)}`;
}
