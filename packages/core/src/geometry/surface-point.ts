import type { TerrainDatum, VerticalDatum, HeightConvention } from '../geographic/coordinates.js';

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
  /** An irregular-body DSK plate mesh. */
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
export interface SurfacePoint {
  bodyName: string;
  /** Explicit physical frame. Omitted only by legacy snapshots. */
  frame?: string;
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
  /** Height above a defined datum; both null for a DSK with no altitude datum. */
  hit: { heightKm: number | null; datum: SurfaceDatum | null };
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
   * Unit normal of the rendered surface at the hit, body-fixed (same frame as
   * `bodyFixedPositionKm`). Absent when the hit had no face to take it from.
   */
  surfaceNormal?: readonly [number, number, number];
  /**
   * The height to present for this point: the terrain sample when it
   * describes the hit surface, otherwise the hit's own height. Null when no
   * scientifically defined altitude datum exists (DSK plate surfaces).
   */
  altitude: {
    km: number | null;
    from: 'terrain-sample' | 'rendered-hit' | 'unavailable';
    datum: SurfaceDatum | null;
  };
}

/** Durable semantic snapshot. Pointer footprint, face normal and derived display altitude are not persisted.
 * The captured rendered position is the anchor; authoritative analysis uses the physical-surface contract (#148).
 */
export type SurfacePointAnchor = Omit<SurfacePoint, 'resolution' | 'surfaceNormal' | 'altitude'>;
export interface SurfacePointEndpoint {
  kind: 'surface-point';
  version: 1;
  point: SurfacePointAnchor;
  label?: string;
}
/** Copy the semantic snapshot so probe re-seating or clearing cannot change an endpoint. */
export function surfacePointEndpoint(point: SurfacePointAnchor, label?: string): SurfacePointEndpoint {
  const datum = (d: SurfaceDatum): SurfaceDatum => ({ ...d, referenceShape: d.referenceShape.kind === 'sphere'
    ? { ...d.referenceShape } : { ...d.referenceShape, radiiKm: [...d.referenceShape.radiiKm] } });
  return { kind: 'surface-point', version: 1, ...(label === undefined ? {} : { label }), point: {
    bodyName: point.bodyName, ...(point.frame ? { frame: point.frame } : {}), bodyFixedPositionKm: [...point.bodyFixedPositionKm], source: point.source,
    latDeg: point.latDeg, lonDeg: point.lonDeg, latitudeKind: point.latitudeKind,
    hit: { heightKm: point.hit.heightKm, datum: point.hit.datum && datum(point.hit.datum) },
    ...(point.terrainSample ? { terrainSample: { ...point.terrainSample, datum: datum(point.terrainSample.datum) } } : {}),
  } };
}
