import { wrapLon, type BodyFixedPosition, type TerrainDatum } from './coordinates.js';
import { geographicProjection } from './projection.js';

/**
 * Geodesics and measurements on a layer's reference shape (sphere or oblate
 * ellipsoid), for authored shapes and edit readouts. Lengths and areas follow
 * the **drawn** edges, which are linear in longitude/latitude (projection.ts),
 * not shortest paths, so a measurement describes exactly the line on screen,
 * minus terrain relief: these are reference-shape values, not terrain
 * measurements. Positions are geodetic, east-positive degrees.
 */
const DEG = Math.PI / 180;

function radii(datum: TerrainDatum): { a: number; b: number; f: number } {
  const s = datum.referenceShape;
  if (s.kind === 'sphere') return { a: s.radiusKm, b: s.radiusKm, f: 0 };
  return { a: s.radiiKm[0], b: s.radiiKm[2], f: 1 - s.radiiKm[2] / s.radiiKm[0] };
}

/** The point `distanceKm` along the geodesic leaving `from` at `azimuthDeg` (clockwise from north). Vincenty's direct formula. */
export function geodesicDirect(from: BodyFixedPosition, azimuthDeg: number, distanceKm: number, datum: TerrainDatum): BodyFixedPosition {
  const { a, b, f } = radii(datum);
  const alpha1 = azimuthDeg * DEG, s = distanceKm;
  if (f === 0) {
    const lat1 = from.latDeg * DEG, d = s / a;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(alpha1));
    const lon2 = from.lonDeg * DEG + Math.atan2(Math.sin(alpha1) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { latDeg: lat2 / DEG, lonDeg: wrapLon(lon2 / DEG) };
  }
  const sinA1 = Math.sin(alpha1), cosA1 = Math.cos(alpha1);
  const tanU1 = (1 - f) * Math.tan(from.latDeg * DEG), cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosA1);
  const sinAlpha = cosU1 * sinA1, cos2Alpha = 1 - sinAlpha * sinAlpha;
  const u2 = cos2Alpha * (a * a - b * b) / (b * b);
  const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  let sigma = s / (b * A), sigmaP = 2 * Math.PI, cos2SigmaM = 0, sinSigma = 0, cosSigma = 0;
  for (let i = 0; i < 200 && Math.abs(sigma - sigmaP) > 1e-12; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma); cosSigma = Math.cos(sigma);
    const deltaSigma = B * sinSigma * (cos2SigmaM + B / 4 * (cosSigma * (-1 + 2 * cos2SigmaM ** 2)
      - B / 6 * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
    sigmaP = sigma; sigma = s / (b * A) + deltaSigma;
  }
  cos2SigmaM = Math.cos(2 * sigma1 + sigma); sinSigma = Math.sin(sigma); cosSigma = Math.cos(sigma);
  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosA1;
  const lat2 = Math.atan2(sinU1 * cosSigma + cosU1 * sinSigma * cosA1, (1 - f) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp));
  const lambda = Math.atan2(sinSigma * sinA1, cosU1 * cosSigma - sinU1 * sinSigma * cosA1);
  const C = f / 16 * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
  const L = lambda - (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  return { latDeg: lat2 / DEG, lonDeg: wrapLon(from.lonDeg + L / DEG) };
}

/**
 * Shortest-path distance (km) between two positions. Vincenty's inverse
 * formula on an ellipsoid; where it does not converge (nearly antipodal
 * points), the sphere of the mean radius.
 */
export function geodesicDistanceKm(p: BodyFixedPosition, q: BodyFixedPosition, datum: TerrainDatum): number {
  const { a, b, f } = radii(datum);
  const haversine = (r: number) => {
    const dLat = (q.latDeg - p.latDeg) * DEG, dLon = wrapLon(q.lonDeg - p.lonDeg) * DEG;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.latDeg * DEG) * Math.cos(q.latDeg * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  if (f === 0) return haversine(a);
  const L = wrapLon(q.lonDeg - p.lonDeg) * DEG;
  const U1 = Math.atan((1 - f) * Math.tan(p.latDeg * DEG)), U2 = Math.atan((1 - f) * Math.tan(q.latDeg * DEG));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L, lambdaP = 0, iter = 0;
  let sinSigma = 0, cosSigma = 0, sigma = 0, cos2Alpha = 0, cos2SigmaM = 0;
  do {
    const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - 2 * sinU1 * sinU2 / cos2Alpha : 0;
    const C = f / 16 * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    lambdaP = lambda;
    lambda = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  } while (Math.abs(lambda - lambdaP) > 1e-12 && ++iter < 200);
  if (iter >= 200) return haversine((2 * a + b) / 3);
  const u2 = cos2Alpha * (a * a - b * b) / (b * b);
  const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const deltaSigma = B * sinSigma * (cos2SigmaM + B / 4 * (cosSigma * (-1 + 2 * cos2SigmaM ** 2)
    - B / 6 * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return b * A * (sigma - deltaSigma);
}

/** Drawn edges are followed in steps of at most this many degrees (and at least 8 per edge). */
const EDGE_STEP_DEG = 0.25;

/** Points along a drawn edge: linear in unwrapped longitude and latitude, the short way. */
function edgeSamples(p: BodyFixedPosition, q: BodyFixedPosition): BodyFixedPosition[] {
  const dLon = wrapLon(q.lonDeg - p.lonDeg), dLat = q.latDeg - p.latDeg;
  const steps = Math.min(1440, Math.max(8, Math.ceil(Math.max(Math.abs(dLon), Math.abs(dLat)) / EDGE_STEP_DEG)));
  return Array.from({ length: steps + 1 }, (_, i) => ({ latDeg: p.latDeg + dLat * i / steps, lonDeg: wrapLon(p.lonDeg + dLon * i / steps) }));
}

/** Length (km) along a drawn path on the reference shape. Terrain relief is not included. */
export function geographicPathLengthKm(positions: readonly BodyFixedPosition[], datum: TerrainDatum): number {
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    const samples = edgeSamples(positions[i - 1], positions[i]);
    for (let j = 1; j < samples.length; j++) total += geodesicDistanceKm(samples[j - 1], samples[j], datum);
  }
  return total;
}

/** Authalic (equal-area) radius and latitude, so areas on the sphere equal areas on the ellipsoid. */
function authalic(datum: TerrainDatum): { radius: number; latitude: (latDeg: number) => number } {
  const { a, b } = radii(datum);
  if (a === b) return { radius: a, latitude: lat => lat * DEG };
  const e = Math.sqrt(1 - (b * b) / (a * a));
  const q = (phi: number) => {
    const s = Math.sin(phi);
    return (1 - e * e) * (s / (1 - e * e * s * s) - 1 / (2 * e) * Math.log((1 - e * s) / (1 + e * s)));
  };
  const qp = q(Math.PI / 2);
  return { radius: a * Math.sqrt(qp / 2), latitude: lat => Math.asin(Math.max(-1, Math.min(1, q(lat * DEG) / qp))) };
}

/**
 * Area (km²) enclosed by a closed ring with drawn (longitude/latitude-linear)
 * edges, on the reference shape. A ring winding once around a pole encloses
 * the cap on that pole's side, as import and drawing interpret it.
 */
export function geographicRingAreaKm2(ring: readonly BodyFixedPosition[], datum: TerrainDatum): number {
  const { radius, latitude } = authalic(datum);
  // Green's theorem: area = R² ∮ sin β dλ, integrated along each drawn edge.
  let s = 0, winding = 0;
  for (let i = 1; i < ring.length; i++) {
    const samples = edgeSamples(ring[i - 1], ring[i]);
    for (let j = 1; j < samples.length; j++) {
      const dLon = wrapLon(samples[j].lonDeg - samples[j - 1].lonDeg) * DEG;
      s += dLon * (Math.sin(latitude(samples[j].latDeg)) + Math.sin(latitude(samples[j - 1].latDeg))) / 2;
      winding += dLon;
    }
  }
  const projection = geographicProjection(ring as BodyFixedPosition[]);
  if (projection === 'longitude-latitude') return radius * radius * Math.abs(s);
  return radius * radius * Math.abs(projection === 'north-polar' ? winding - s : winding + s);
}

/** Area (km²) of a polygon (exterior minus holes) on the reference shape. */
export function geographicPolygonAreaKm2(rings: readonly (readonly BodyFixedPosition[])[], datum: TerrainDatum): number {
  return rings.reduce((total, ring, i) => total + (i === 0 ? 1 : -1) * geographicRingAreaKm2(ring, datum), 0);
}
