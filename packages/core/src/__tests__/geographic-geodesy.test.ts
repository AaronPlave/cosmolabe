import { describe, it, expect } from 'vitest';
import {
  geodesicDirect, geodesicDistanceKm, geographicPathLengthKm, geographicRingAreaKm2, geographicPolygonAreaKm2,
  type TerrainDatum,
} from '../geographic/index.js';

const moon: TerrainDatum = { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' };
const mars: TerrainDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
// WGS84, for checks against published geodesic values.
const earth: TerrainDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [6378.137, 6378.137, 6356.752314245] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };

describe('geodesics on reference shapes', () => {
  it('matches a sphere quarter meridian and great circle', () => {
    expect(geodesicDistanceKm({ latDeg: 0, lonDeg: 0 }, { latDeg: 90, lonDeg: 0 }, moon)).toBeCloseTo(Math.PI / 2 * 1737.4, 6);
    const p = geodesicDirect({ latDeg: 0, lonDeg: 10 }, 90, Math.PI / 2 * 1737.4, moon);
    expect(p.latDeg).toBeCloseTo(0, 9);
    expect(p.lonDeg).toBeCloseTo(100, 9);
  });

  it('reproduces Vincenty’s Flinders Peak to Buninyong distance on WGS84', () => {
    const d = geodesicDistanceKm({ latDeg: -(37 + 57 / 60 + 3.72030 / 3600), lonDeg: 144 + 25 / 60 + 29.52440 / 3600 },
      { latDeg: -(37 + 39 / 60 + 10.15610 / 3600), lonDeg: 143 + 55 / 60 + 35.38390 / 3600 }, earth);
    expect(d).toBeCloseTo(54.972271, 5);
  });

  it('inverts the direct problem on Mars in every direction', () => {
    const from = { latDeg: 18.4, lonDeg: 77.5 };
    for (const azimuth of [0, 37, 90, 145, 180, 271]) {
      for (const km of [0.01, 5, 400]) {
        const to = geodesicDirect(from, azimuth, km, mars);
        expect(geodesicDistanceKm(from, to, mars)).toBeCloseTo(km, 6);
      }
    }
  });

  it('wraps across the seam', () => {
    const p = geodesicDirect({ latDeg: 0, lonDeg: 179.9 }, 90, 20, moon);
    expect(p.lonDeg).toBeLessThan(-179);
  });
});

describe('measurements along drawn edges', () => {
  it('measures an equatorial path the way it is drawn, including across the seam', () => {
    const km = geographicPathLengthKm([{ latDeg: 0, lonDeg: 179 }, { latDeg: 0, lonDeg: -179 }], moon);
    expect(km).toBeCloseTo(2 * Math.PI / 180 * 1737.4, 6);
  });

  it('follows a drawn parallel, which is longer than the shortest path between its ends', () => {
    const ends = [{ latDeg: 60, lonDeg: 0 }, { latDeg: 60, lonDeg: 90 }];
    const drawn = geographicPathLengthKm(ends, moon);
    expect(drawn).toBeCloseTo(Math.PI / 2 * 1737.4 * 0.5, 2);
    expect(drawn).toBeGreaterThan(geodesicDistanceKm(ends[0], ends[1], moon));
  });

  it('measures lon/lat boxes, holes and polar caps', () => {
    const r = 1737.4;
    const box = [{ latDeg: 0, lonDeg: 0 }, { latDeg: 0, lonDeg: 10 }, { latDeg: 10, lonDeg: 10 }, { latDeg: 10, lonDeg: 0 }, { latDeg: 0, lonDeg: 0 }];
    const exact = r * r * (10 * Math.PI / 180) * Math.sin(10 * Math.PI / 180);
    expect(geographicRingAreaKm2(box, moon)).toBeCloseTo(exact, 3);
    expect(geographicRingAreaKm2([...box].reverse(), moon)).toBeCloseTo(exact, 3);
    const hole = [{ latDeg: 2, lonDeg: 2 }, { latDeg: 2, lonDeg: 4 }, { latDeg: 4, lonDeg: 4 }, { latDeg: 4, lonDeg: 2 }, { latDeg: 2, lonDeg: 2 }];
    expect(geographicPolygonAreaKm2([box, hole], moon)).toBeCloseTo(exact - geographicRingAreaKm2(hole, moon), 6);
    for (const sign of [1, -1]) {
      const cap = [-180, -90, 0, 90, 180].map(lon => ({ latDeg: sign * 80, lonDeg: lon === 180 ? -180 : lon }));
      cap[4] = { ...cap[0] };
      const capExact = 2 * Math.PI * r * r * (1 - Math.sin(80 * Math.PI / 180));
      expect(geographicRingAreaKm2(cap, moon)).toBeCloseTo(capExact, 0);
    }
  });

  it('uses equal-area latitude on an ellipsoid: a whole-planet band sums to the ellipsoid’s area', () => {
    const north = [-180, -90, 0, 90, -180].map(lon => ({ latDeg: 0, lonDeg: lon }));
    // Cap from the equator to the north pole is half the ellipsoid's surface.
    const a = 3396.19, c = 3376.2, e = Math.sqrt(1 - c * c / (a * a));
    const surface = 2 * Math.PI * a * a * (1 + (1 - e * e) / e * Math.atanh(e));
    const half = geographicRingAreaKm2(north.map(p => ({ ...p, latDeg: 1e-9 })), mars);
    expect(half / (surface / 2)).toBeCloseTo(1, 6);
  });
});
