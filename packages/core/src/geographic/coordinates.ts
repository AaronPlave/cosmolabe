/** Renderer-independent terrain datum and CPU sampling primitives. All lengths are km. */
export type VerticalDatum = 'ellipsoid' | 'reference-sphere' | 'areoid' | 'unknown';
export type HeightConvention = 'radial' | 'geodetic-normal';

export interface TerrainDatum {
  /** The physical reference shape; this is deliberately never a display radius. */
  referenceShape: { kind: 'sphere'; radiusKm: number } | { kind: 'ellipsoid'; radiiKm: readonly [number, number, number] };
  verticalDatum: VerticalDatum;
  heightConvention: HeightConvention;
}

export interface BodyFixedPosition { latDeg: number; lonDeg: number; heightKm?: number; }
export interface BodyFixedCartesian { xKm: number; yKm: number; zKm: number; }
const DEG = Math.PI / 180;
/** Wrap longitude to [-180, 180); the TerrainSample position convention. */
export const wrapLon = (lon: number) => ((lon + 180) % 360 + 360) % 360 - 180;

/**
 * The geodetic converters below implement spheres and geodetic oblate ellipsoids
 * only. Radial oblate heights, areoid/unknown vertical datums and triaxial shapes
 * must be rejected rather than reinterpreted as a supported datum.
 */
export function isSupportedGeodeticDatum(datum: TerrainDatum): boolean {
  if (datum.verticalDatum !== 'reference-sphere' && datum.verticalDatum !== 'ellipsoid') return false;
  const shape = datum.referenceShape;
  if (shape.kind === 'sphere') return Number.isFinite(shape.radiusKm) && shape.radiusKm > 0;
  const [a, b, c] = shape.radiiKm;
  return datum.heightConvention === 'geodetic-normal' && a === b
    && Number.isFinite(a) && a > 0 && Number.isFinite(c) && c > 0;
}

/** Convert geodetic body-fixed coordinates to conventional Z-up ECEF. */
export function geodeticToBodyFixed(position: BodyFixedPosition, datum: TerrainDatum): BodyFixedCartesian {
  const lat = position.latDeg * DEG, lon = position.lonDeg * DEG, h = position.heightKm ?? 0;
  if (datum.referenceShape.kind === 'sphere') {
    const r = datum.referenceShape.radiusKm + h;
    return { xKm: r * Math.cos(lat) * Math.cos(lon), yKm: r * Math.cos(lat) * Math.sin(lon), zKm: r * Math.sin(lat) };
  }
  const [a,, c] = datum.referenceShape.radiiKm;
  const e2 = 1 - (c * c) / (a * a);
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return { xKm: (n + h) * Math.cos(lat) * Math.cos(lon), yKm: (n + h) * Math.cos(lat) * Math.sin(lon), zKm: (n * (1 - e2) + h) * Math.sin(lat) };
}

/** Convert conventional Z-up ECEF to geodetic body-fixed coordinates. */
export function bodyFixedToGeodetic(point: BodyFixedCartesian, datum: TerrainDatum): BodyFixedPosition {
  const lonDeg = Math.atan2(point.yKm, point.xKm) / DEG;
  const p = Math.hypot(point.xKm, point.yKm);
  if (datum.referenceShape.kind === 'sphere') {
    const r = Math.hypot(p, point.zKm);
    return { latDeg: Math.atan2(point.zKm, p) / DEG, lonDeg, heightKm: r - datum.referenceShape.radiusKm };
  }
  const [a,, c] = datum.referenceShape.radiiKm;
  const e2 = 1 - (c * c) / (a * a);
  let lat = Math.atan2(point.zKm, p * (1 - e2));
  for (let i = 0; i < 128; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const next = Math.atan2(point.zKm + e2 * n * Math.sin(lat), p);
    if (Math.abs(next - lat) < 1e-15) { lat = next; break; }
    lat = next;
  }
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  // `p / cos(lat)` degenerates at the poles, where p → 0 and cos(lat) → 0 and
  // the quotient loses the entire radius. Switch to the z-axis form there.
  const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
  const heightKm = Math.abs(cosLat) > 1e-6
    ? p / cosLat - n
    : Math.abs(point.zKm) / Math.max(Math.abs(sinLat), 1e-12) - n * (1 - e2);
  return { latDeg: lat / DEG, lonDeg, heightKm };
}

