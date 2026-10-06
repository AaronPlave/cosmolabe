/** Physical body-fixed coordinates: right-handed Z-up, lengths in km. */
export type ReferenceShape = { kind: 'sphere'; radiusKm: number }
  | { kind: 'ellipsoid'; radiiKm: readonly [number, number, number] };
export type VerticalDatum = 'ellipsoid' | 'reference-sphere' | 'areoid' | 'unknown';
export type HeightConvention = 'radial' | 'geodetic-normal';
export interface TerrainDatum {
  referenceShape: ReferenceShape;
  verticalDatum: VerticalDatum;
  heightConvention: HeightConvention;
}
/** Latitude per the descriptor, longitude always canonical degrees east. */
export interface BodyFixedPosition { latDeg: number; lonDeg: number; heightKm?: number; }
export interface BodyFixedCartesian { xKm: number; yKm: number; zKm: number; }
export interface SurfaceCoordinates {
  frame: string;
  datum: TerrainDatum;
  latitudeType: 'planetocentric' | 'geodetic';
  /** Presentation only; analytical inputs/outputs remain east-positive. */
  positiveLongitude: 'east' | 'west';
  longitudeDomain: 'signed' | 'unsigned';
}
export const wrapLongitude = (lon: number): number => ((lon + 180) % 360 + 360) % 360 - 180;
export function displayLongitude(eastDeg: number, coordinates: Pick<SurfaceCoordinates, 'positiveLongitude' | 'longitudeDomain'>): number {
  const lon = coordinates.positiveLongitude === 'west' ? -eastDeg : eastDeg;
  return coordinates.longitudeDomain === 'signed' ? wrapLongitude(lon) : ((lon % 360) + 360) % 360;
}
export function canonicalLongitude(displayDeg: number, direction: 'east' | 'west' = 'east'): number {
  return wrapLongitude(direction === 'west' ? -displayDeg : displayDeg);
}
export function formatSurfaceAngle(value: number, axis: 'latitude' | 'longitude', stepDeg = 1): string {
  const v = axis === 'longitude' ? wrapLongitude(value) : value;
  const precision = Math.min(6, Math.max(0, Math.ceil(-Math.log10(stepDeg))));
  const rounded = Number(Math.abs(v).toFixed(precision));
  const suffix = rounded === 0 ? '' : axis === 'latitude' ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E');
  return `${rounded.toFixed(precision)}°${suffix}`;
}
export function supportsGeodetic(shape: ReferenceShape): boolean {
  return shape.kind === 'sphere' || Math.abs(shape.radiiKm[0] - shape.radiiKm[1]) <= shape.radiiKm[0] * 1e-12;
}
function requireGeodetic(shape: ReferenceShape): void {
  if (!supportsGeodetic(shape)) throw new Error('Geodetic coordinates on a triaxial ellipsoid are unavailable; use planetocentric coordinates');
}
const DEG = Math.PI / 180;
export function geodeticToBodyFixed(position: BodyFixedPosition, datum: TerrainDatum): BodyFixedCartesian {
  requireGeodetic(datum.referenceShape);
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
export function bodyFixedToGeodetic(point: BodyFixedCartesian, datum: TerrainDatum): BodyFixedPosition {
  requireGeodetic(datum.referenceShape);
  const lonDeg = wrapLongitude(Math.atan2(point.yKm, point.xKm) / DEG);
  const p = Math.hypot(point.xKm, point.yKm);
  if (datum.referenceShape.kind === 'sphere') {
    return { latDeg: Math.atan2(point.zKm, p) / DEG, lonDeg, heightKm: Math.hypot(p, point.zKm) - datum.referenceShape.radiusKm };
  }
  const [a,, c] = datum.referenceShape.radiiKm;
  const e2 = 1 - (c * c) / (a * a);
  let lat = Math.atan2(point.zKm, p * (1 - e2));
  for (let i = 0; i < 8; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(point.zKm + e2 * n * Math.sin(lat), p);
  }
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
  const heightKm = Math.abs(cosLat) > 1e-6 ? p / cosLat - n : Math.abs(point.zKm) / Math.max(Math.abs(sinLat), 1e-12) - n * (1 - e2);
  return { latDeg: lat / DEG, lonDeg, heightKm };
}
/** Planetocentric latitude intersects a radial ray with the physical reference shape. */
export function surfacePositionToBodyFixed(position: BodyFixedPosition, coordinates: SurfaceCoordinates): BodyFixedCartesian {
  if (coordinates.latitudeType === 'geodetic') return geodeticToBodyFixed(position, coordinates.datum);
  const lat = position.latDeg * DEG, lon = position.lonDeg * DEG;
  const x = Math.cos(lat) * Math.cos(lon), y = Math.cos(lat) * Math.sin(lon), z = Math.sin(lat);
  const shape = coordinates.datum.referenceShape;
  const r = shape.kind === 'sphere' ? shape.radiusKm : 1 / Math.hypot(x / shape.radiiKm[0], y / shape.radiiKm[1], z / shape.radiiKm[2]);
  const length = r + (position.heightKm ?? 0);
  return { xKm: length * x, yKm: length * y, zKm: length * z };
}
export function bodyFixedToSurfacePosition(point: BodyFixedCartesian, coordinates: SurfaceCoordinates): BodyFixedPosition {
  if (coordinates.latitudeType === 'geodetic') return bodyFixedToGeodetic(point, coordinates.datum);
  const latDeg = Math.atan2(point.zKm, Math.hypot(point.xKm, point.yKm)) / DEG;
  const lonDeg = wrapLongitude(Math.atan2(point.yKm, point.xKm) / DEG);
  const reference = surfacePositionToBodyFixed({ latDeg, lonDeg }, coordinates);
  return { latDeg, lonDeg, heightKm: Math.hypot(point.xKm, point.yKm, point.zKm) - Math.hypot(reference.xKm, reference.yKm, reference.zKm) };
}
/** Catalog radii define the reference; display-size fallbacks never qualify. */
export function bodySurfaceCoordinates(body: { name: string; radii?: readonly [number, number, number]; classification?: string; rotation?: { readonly targetFrame?: string } }): SurfaceCoordinates | null {
  if (!body.radii || !body.radii.every(r => Number.isFinite(r) && r > 0)
    || ['star', 'spacecraft', 'instrument', 'barycenter'].includes(body.classification ?? '')) return null;
  const [a, b, c] = body.radii;
  const referenceShape: ReferenceShape = a === b && a === c ? { kind: 'sphere', radiusKm: a } : { kind: 'ellipsoid', radiiKm: body.radii };
  const latitudeType = supportsGeodetic(referenceShape) ? 'geodetic' : 'planetocentric';
  return { frame: body.rotation?.targetFrame ?? `BODY_FIXED:${body.name}`, latitudeType, positiveLongitude: 'east', longitudeDomain: 'signed',
    datum: { referenceShape, verticalDatum: referenceShape.kind === 'sphere' ? 'reference-sphere' : 'ellipsoid', heightConvention: latitudeType === 'geodetic' ? 'geodetic-normal' : 'radial' } };
}
