import { geodeticToBodyFixed, bodyFixedToGeodetic, isSupportedGeodeticDatum, wrapLon, type TerrainDatum, type BodyFixedPosition, type BodyFixedCartesian } from './geographic/coordinates.js';
export type ReferenceShape = TerrainDatum['referenceShape'];
/** Latitude per the descriptor, longitude always canonical degrees east. */
export interface SurfaceCoordinates {
  frame: string;
  datum: TerrainDatum;
  latitudeType: 'planetocentric' | 'geodetic';
  /** Presentation only; analytical inputs/outputs remain east-positive. */
  positiveLongitude: 'east' | 'west';
  longitudeDomain: 'signed' | 'unsigned';
}
export const wrapLongitude = wrapLon;
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
  return shape.kind === 'sphere' || shape.radiiKm[0] === shape.radiiKm[1];
}
const DEG = Math.PI / 180;
function requireGeodetic(datum: TerrainDatum): void {
  if (!isSupportedGeodeticDatum(datum)) throw new Error('Unsupported geodetic datum or triaxial reference shape');
}
/** Planetocentric latitude intersects a radial ray with the physical reference shape. */
export function surfacePositionToBodyFixed(position: BodyFixedPosition, coordinates: SurfaceCoordinates): BodyFixedCartesian {
  if (coordinates.latitudeType === 'geodetic') { requireGeodetic(coordinates.datum); return geodeticToBodyFixed(position, coordinates.datum); }
  const lat = position.latDeg * DEG, lon = position.lonDeg * DEG;
  const x = Math.cos(lat) * Math.cos(lon), y = Math.cos(lat) * Math.sin(lon), z = Math.sin(lat);
  const shape = coordinates.datum.referenceShape;
  const r = shape.kind === 'sphere' ? shape.radiusKm : 1 / Math.hypot(x / shape.radiiKm[0], y / shape.radiiKm[1], z / shape.radiiKm[2]);
  const length = r + (position.heightKm ?? 0);
  return { xKm: length * x, yKm: length * y, zKm: length * z };
}
export function bodyFixedToSurfacePosition(point: BodyFixedCartesian, coordinates: SurfaceCoordinates): BodyFixedPosition {
  if (coordinates.latitudeType === 'geodetic') { requireGeodetic(coordinates.datum); return { ...bodyFixedToGeodetic(point, coordinates.datum), lonDeg: wrapLon(Math.atan2(point.yKm, point.xKm) / DEG) }; }
  const latDeg = Math.atan2(point.zKm, Math.hypot(point.xKm, point.yKm)) / DEG;
  const lonDeg = wrapLongitude(Math.atan2(point.yKm, point.xKm) / DEG);
  const reference = surfacePositionToBodyFixed({ latDeg, lonDeg }, coordinates);
  return { latDeg, lonDeg, heightKm: Math.hypot(point.xKm, point.yKm, point.zKm) - Math.hypot(reference.xKm, reference.yKm, reference.zKm) };
}
/** Catalog radii define the reference; display-size fallbacks never qualify. */
export function bodySurfaceCoordinates(body: { name: string; radii?: readonly [number, number, number]; classification?: string; rotation?: { readonly bodyFixedFrame?: string } }): SurfaceCoordinates | null {
  if (!body.radii || !body.radii.every(r => Number.isFinite(r) && r > 0)
    || ['star', 'spacecraft', 'instrument', 'barycenter'].includes(body.classification ?? '')) return null;
  const [a, b, c] = body.radii;
  const referenceShape: ReferenceShape = a === b && a === c ? { kind: 'sphere', radiusKm: a } : { kind: 'ellipsoid', radiiKm: body.radii };
  const latitudeType = supportsGeodetic(referenceShape) ? 'geodetic' : 'planetocentric';
  return { frame: body.rotation?.bodyFixedFrame ?? `BODY_FIXED:${body.name}`, latitudeType, positiveLongitude: 'east', longitudeDomain: 'signed',
    datum: { referenceShape, verticalDatum: referenceShape.kind === 'sphere' ? 'reference-sphere' : 'ellipsoid', heightConvention: latitudeType === 'geodetic' ? 'geodetic-normal' : 'radial' } };
}
