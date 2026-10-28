import * as THREE from 'three';
import { bodyFixedToGeodetic, geodeticToBodyFixed, wrapLon, type BodyFixedPosition, type GeographicLayer } from '@cosmolabe/core';

/**
 * Where on screen a group of geographic features can draw, so the vector pass
 * shades only those fragments instead of every visible fragment of the body.
 *
 * The overlay is drawn on proxies of whole surface meshes, and its fragment
 * shader runs wherever they cover the screen, whether or not a feature is
 * near. Edges are drawn linear in longitude and latitude, so every drawn
 * fragment of a feature lies inside the longitude/latitude box of its
 * vertices. Projecting that box at the lowest and highest drawn heights gives
 * a conservative screen rectangle; outside it the pass is scissored away.
 */

/** A seam-aware longitude/latitude box (east may be less than west across the seam), or anywhere. */
export type GeographicFootprint =
  | { kind: 'box'; west: number; east: number; south: number; north: number }
  | { kind: 'global' };

/** Boxes wider or taller than this are treated as global: the screen-space bound of so large a patch is not worth computing. */
const MAX_SPAN_DEG = 60;

/** The box enclosing `positions`, choosing the smaller way round the seam. */
export function geographicFootprint(positions: Iterable<BodyFixedPosition>): GeographicFootprint | null {
  const lons: number[] = [];
  let south = Infinity, north = -Infinity;
  for (const p of positions) {
    lons.push(wrapLon(p.lonDeg));
    south = Math.min(south, p.latDeg); north = Math.max(north, p.latDeg);
  }
  if (!lons.length) return null;
  // Near a pole every longitude is nearby; a box would be wrong there.
  if (north > 89 || south < -89) return { kind: 'global' };
  lons.sort((a, b) => a - b);
  // The largest gap between consecutive longitudes (round the circle) is what the box leaves out.
  let gap = lons[0] + 360 - lons[lons.length - 1], west = lons[0], east = lons[lons.length - 1];
  for (let i = 1; i < lons.length; i++) {
    const g = lons[i] - lons[i - 1];
    if (g > gap) { gap = g; west = lons[i]; east = lons[i - 1]; }
  }
  const span = 360 - gap;
  if (span > MAX_SPAN_DEG || north - south > MAX_SPAN_DEG) return { kind: 'global' };
  return { kind: 'box', west, east, south, north };
}

export function layerFootprint(layers: readonly GeographicLayer[], feature?: { layerId: string; featureId: string }): GeographicFootprint | null {
  function* all(): Generator<BodyFixedPosition> {
    for (const layer of layers) for (const f of layer.features) {
      if (feature && (layer.id !== feature.layerId || f.id !== feature.featureId)) continue;
      yield* geometryPositions(f.geometry);
    }
  }
  return geographicFootprint(all());
}

function geometryPositions(g: GeographicLayer['features'][number]['geometry']): BodyFixedPosition[] {
  switch (g.type) {
    case 'Point': return [g.coordinates];
    case 'MultiPoint': case 'LineString': return g.coordinates;
    case 'MultiLineString': case 'Polygon': return g.coordinates.flat();
    case 'MultiPolygon': return g.coordinates.flat(2);
  }
}

const SAMPLES = 7;
const corners = Array.from({ length: 8 }, () => new THREE.Vector3());

/**
 * The lowest and highest geodetic heights, in km, a surface mesh can draw at,
 * and whether its longitude/latitude extent can touch the footprint. From the
 * mesh's bounding box in body-fixed axes; null when it cannot be bounded
 * usefully (a whole-globe mesh), so its height range must come from elsewhere.
 */
export function meshHeightRange(geometry: THREE.BufferGeometry, localToBody: THREE.Matrix4, datum: GeographicLayer['datum'],
  footprint: GeographicFootprint): { touches: boolean; low: number; high: number } | null {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  let low = Infinity, high = -Infinity;
  const at: BodyFixedPosition[] = [];
  const bounds = new THREE.Box3();
  for (let i = 0; i < 8; i++) {
    const c = corners[i].set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(localToBody);
    bounds.expandByPoint(c);
    const g = bodyFixedToGeodetic({ xKm: c.x, yKm: c.y, zKm: c.z }, datum);
    low = Math.min(low, g.heightKm ?? 0); high = Math.max(high, g.heightKm ?? 0);
    at.push(g);
  }
  const shape = datum.referenceShape;
  const radius = shape.kind === 'sphere' ? shape.radiusKm : shape.radiiKm[0];
  // A mesh this large (a whole globe or hemisphere): its box's corners say nothing about the surface.
  const size = bounds.getSize(new THREE.Vector3());
  if (Math.max(size.x, size.y, size.z) > 0.25 * radius || high - low > 0.25 * radius) return null;
  // The box's corners are off the surface (above and below it); the surface lies between.
  if (footprint.kind !== 'box') return { touches: true, low, high };
  // The corners' box can only overstate the mesh's extent, so this never rejects a mesh that touches.
  const extent = geographicFootprint(at);
  const touches = !extent || extent.kind === 'global' || (overlapsLat(extent, footprint) && overlapsLon(extent, footprint));
  return { touches, low, high };
}

const overlapsLat = (a: { south: number; north: number }, b: { south: number; north: number }) => a.south <= b.north && b.south <= a.north;
function overlapsLon(a: { west: number; east: number }, b: { west: number; east: number }): boolean {
  const width = (x: { west: number; east: number }) => (x.east - x.west + 360) % 360;
  const inside = (lon: number, x: { west: number; east: number }) => (lon - x.west + 360) % 360 <= width(x);
  return inside(a.west, b) || inside(b.west, a);
}

/**
 * The screen rectangle, in the current viewport's CSS pixels from its bottom
 * left, that the footprint covers between two heights, padded by `paddingPx`;
 * 'empty' when it is off screen or wholly behind the camera, null when it
 * cannot be bounded (partly behind the camera, or a global footprint).
 */
export function footprintScreenRect(footprint: GeographicFootprint, low: number, high: number, datum: GeographicLayer['datum'],
  bodyToWorld: THREE.Matrix4, camera: THREE.Camera, viewport: THREE.Vector4, paddingPx: number): THREE.Vector4 | 'empty' | null {
  if (footprint.kind !== 'box') return null;
  const width = (footprint.east - footprint.west + 360) % 360;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = 0, total = 0;
  const v = new THREE.Vector4(), m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(bodyToWorld);
  for (let i = 0; i < SAMPLES; i++) for (let j = 0; j < SAMPLES; j++) for (const heightKm of [low, high]) {
    const lonDeg = footprint.west + width * i / (SAMPLES - 1);
    const latDeg = footprint.south + (footprint.north - footprint.south) * j / (SAMPLES - 1);
    const p = geodeticToBodyFixed({ latDeg, lonDeg, heightKm }, datum);
    v.set(p.xKm, p.yKm, p.zKm, 1).applyMatrix4(m);
    total++;
    if (v.w <= 1e-9) { behind++; continue; }
    const x = v.x / v.w, y = v.y / v.w;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  // Wholly behind the camera: nothing to draw. Partly behind: the projection is unbounded.
  if (behind === total) return 'empty';
  if (behind) return null;
  // NDC to viewport pixels, padded for marks drawn beyond their geometry.
  const left = Math.max(0, (x0 + 1) / 2 * viewport.z - paddingPx), right = Math.min(viewport.z, (x1 + 1) / 2 * viewport.z + paddingPx);
  const bottom = Math.max(0, (y0 + 1) / 2 * viewport.w - paddingPx), top = Math.min(viewport.w, (y1 + 1) / 2 * viewport.w + paddingPx);
  if (right <= left || top <= bottom) return 'empty';
  return new THREE.Vector4(viewport.x + Math.floor(left), viewport.y + Math.floor(bottom), Math.ceil(right - left) + 1, Math.ceil(top - bottom) + 1);
}
