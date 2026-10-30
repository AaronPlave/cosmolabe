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

import type { SurfaceHitSource, SurfacePoint, SurfaceDatum, PointerResolution } from '@cosmolabe/core';
import type { GeographicFeatureRef } from './geographic/GeographicIndex.js';
export type { SurfaceHitSource, SurfacePoint, SurfaceDatum, PointerResolution } from '@cosmolabe/core';

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
  if (source === 'dsk') return { altitude: { km: null, from: 'unavailable', datum: null } };
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
  | ({ kind: 'geographic-feature' } & GeographicFeatureRef)
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
 * - `select`: event glyph → label → geographic feature → body.
 * - `probe`: rendered surface only (Point Probe).
 * - `endpoint`: a named entity by its label, else a surface point, else the
 *   body (measurement endpoints, #57).
 * - `pivot`: rendered surface only (Surface Explorer orbit pivot).
 */
export type PickIntent = 'select' | 'probe' | 'endpoint' | 'pivot';

/** The discovery layers the renderer can consult. */
export type HitLayer = 'event' | 'label' | 'geographic-feature' | 'body' | 'surface';

export const PICK_PRECEDENCE: Readonly<Record<PickIntent, readonly HitLayer[]>> = {
  select: ['event', 'label', 'geographic-feature', 'body'],
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
  const h = point.altitude.km == null ? null : (point.altitude.km * 1000).toFixed(1);
  const kind = point.latitudeKind === 'geodetic' ? 'geodetic' : 'planetocentric';
  const position = `${point.bodyName} ${lat}, ${lon} (${kind} °N, °E)`;
  return h !== null && point.altitude.datum
    ? `${position} ${h} m above ${describeDatum(point.altitude.datum)}`
    : `${position}; radial distance from center ${Math.hypot(...point.bodyFixedPositionKm).toFixed(6)} km; altitude unavailable (no defined datum)`;
}
