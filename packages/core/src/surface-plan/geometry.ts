import clipping, { type MultiPolygon, type Pair } from 'polygon-clipping';
import { geographicProjection } from '../geographic/projection.js';
import { wrapLon } from '../geographic/coordinates.js';
import type { GeographicCoordinates, GeographicFeature, GeographicGeometry, GeoPosition } from '../geographic/model.js';
import { planFail } from './model.js';

const DEG = Math.PI / 180;
const WORLD: MultiPolygon = [[[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]]];

/** Rendering supports polar charts; this estimator's clipping/area model does not. */
export function assertSurfacePlanProjection(feature: GeographicFeature): void {
  const g = feature.geometry;
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  if (polygons.some(p => geographicProjection(p[0]) !== 'longitude-latitude')) {
    planFail('unsupported-shape', feature.id, 'Pole-enclosing polygons are unsupported by the surface-plan estimator; split the region into non-polar pieces');
  }
}

/** Clip in the shared source longitude/latitude plane, not a second geometry model. */
export function surfaceFeatureGeometry(feature: GeographicFeature, coordinates: GeographicCoordinates): MultiPolygon {
  assertSurfacePlanProjection(feature);
  const g = feature.original.geometry as unknown as GeographicGeometry<GeoPosition>;
  if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return planFail('unsupported-shape', feature.id, 'Expected Polygon or MultiPolygon');
  const polygons: GeoPosition[][][] = g.type === 'Polygon' ? [g.coordinates as GeoPosition[][]] : g.coordinates as GeoPosition[][][];
  const result: MultiPolygon[] = [];
  for (const polygon of polygons) {
    let anchor: number | undefined;
    const unwrapped = polygon.map(ring => {
      const points: Pair[] = [];
      for (const p of ring) {
        const lon = p[0] * (coordinates.longitudeDirection === 'east' ? 1 : -1);
        const previous = points.at(-1)?.[0] ?? anchor ?? wrapLon(lon);
        points.push([previous + wrapLon(lon - previous), p[1]]);
      }
      anchor ??= points[0][0];
      return points;
    });
    const xs = unwrapped[0].map(p => p[0]);
    if (Math.max(...xs) - Math.min(...xs) >= 180) planFail('ambiguous-global-region', feature.id, 'Split regions spanning 180 degrees or more of longitude');
    for (const shift of [-360, 0, 360]) {
      const shifted = unwrapped.map(ring => ring.map(([x, y]): Pair => [x + shift, y]));
      const part = clipping.intersection([shifted], WORLD);
      if (part.length) result.push(part);
    }
  }
  return unionGeometry(result);
}
export function unionGeometry(geometries: MultiPolygon[]): MultiPolygon {
  const nonempty = geometries.filter(g => g.length);
  return nonempty.length ? clipping.union(nonempty[0], ...nonempty.slice(1)) : [];
}
export const intersectGeometry = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => a.length && b.length ? clipping.intersection(a, b) : [];
export const subtractGeometry = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => a.length && b.length ? clipping.difference(a, b) : a;

/** Integral of surface area per radian of longitude from equator to latitude. Units m². */
function stripArea(latitude: number, c: GeographicCoordinates): number {
  const shape = c.referenceShape;
  if (shape.kind === 'sphere') return (shape.radiusKm * 1000) ** 2 * Math.sin(latitude * DEG);
  const a = shape.radiiKm[0] * 1000, b = shape.radiiKm[2] * 1000;
  const theta = latitude * DEG;
  const phi = c.latitude === 'planetocentric' ? Math.atan2(a * a * Math.sin(theta), b * b * Math.cos(theta)) : theta;
  const s = Math.sin(phi), e2 = 1 - (b / a) ** 2;
  if (e2 < 1e-14) return a * a * s;
  const e = Math.sqrt(e2);
  return a * a * (1 - e2) / 2 * (s / (1 - e2 * s * s) + Math.atanh(e * s) / e);
}
/** Longitude/latitude edges are linear as in #196. Simpson quadrature, 32 subintervals per edge. */
export function surfaceAreaM2(geometry: MultiPolygon, c: GeographicCoordinates): number {
  let total = 0;
  for (const polygon of geometry) for (const [index, ring] of polygon.entries()) {
    let integral = 0;
    for (let j = 1; j < ring.length; j++) {
      const [x0, y0] = ring[j - 1], [x1, y1] = ring[j];
      if (x0 === x1) continue;
      let sum = stripArea(y0, c) + stripArea(y1, c);
      for (let k = 1; k < 32; k++) sum += (k % 2 ? 4 : 2) * stripArea(y0 + (y1 - y0) * k / 32, c);
      integral += (x1 - x0) * DEG * sum / 96;
    }
    total += (index === 0 ? 1 : -1) * Math.abs(integral);
  }
  if (!Number.isFinite(total) || total < -1e-4) planFail('impossible-area', '$.coordinates', 'Area is not finite/positive at this scale');
  return Math.max(0, total);
}
/** Conservative planning proxy for boundary tile overhead, not a measured tiler traversal. */
export function surfacePerimeterM(geometry: MultiPolygon, c: GeographicCoordinates): number {
  const shape = c.referenceShape;
  const radius = (shape.kind === 'sphere' ? shape.radiusKm : shape.radiiKm[0] ** 2 / shape.radiiKm[2]) * 1000;
  let length = 0;
  for (const polygon of geometry) for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    length += radius * DEG * Math.hypot(b[1] - a[1], (b[0] - a[0]) * Math.cos((a[1] + b[1]) * DEG / 2));
  }
  return length;
}
