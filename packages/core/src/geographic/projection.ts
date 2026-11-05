import { wrapLon, type BodyFixedPosition } from './coordinates.js';

/** A source-coordinate plane, also used by import topology and surface drawing.
 * Ordinary edges are linear in unwrapped longitude/latitude. A ring that winds
 * around a pole uses a polar azimuthal equidistant plane instead. */
export type GeographicProjection = 'longitude-latitude' | 'north-polar' | 'south-polar';
export type GeographicXY = readonly [number, number];

export function geographicProjection(ring: readonly BodyFixedPosition[]): GeographicProjection {
  let winding = 0;
  for (let i = 1; i < ring.length; i++) winding += wrapLon(ring[i].lonDeg - ring[i - 1].lonDeg);
  if (Math.abs(winding) < 180) return 'longitude-latitude';
  return ring.reduce((n, p) => n + p.latDeg, 0) >= 0 ? 'north-polar' : 'south-polar';
}

export function projectGeographic(p: BodyFixedPosition, projection: GeographicProjection, anchor = p.lonDeg): GeographicXY {
  if (projection === 'longitude-latitude') return [anchor + wrapLon(p.lonDeg - anchor), p.latDeg];
  const r = 90 - (projection === 'north-polar' ? p.latDeg : -p.latDeg);
  const lon = p.lonDeg * Math.PI / 180;
  return [r * Math.cos(lon), r * Math.sin(lon)];
}

export function projectGeographicRings(rings: readonly (readonly BodyFixedPosition[])[], projection = geographicProjection(rings[0])): GeographicXY[][] {
  let anchor = rings[0][0].lonDeg;
  return rings.map((ring, ringIndex) => {
    let previous = anchor;
    const projected = ring.map(p => {
      const xy = projectGeographic(p, projection, previous);
      previous = xy[0];
      return xy;
    });
    if (ringIndex === 0 && projection === 'longitude-latitude') {
      anchor = (Math.min(...projected.map(p => p[0])) + Math.max(...projected.map(p => p[0]))) / 2;
    }
    return projected;
  });
}
