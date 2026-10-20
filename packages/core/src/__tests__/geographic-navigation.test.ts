import { describe, expect, it } from 'vitest';
import {
  navigationReference, resolveGeographicTarget, surfacePointTarget, surfaceViewPlacement, withTerrainElevation,
  parseLatitudeText, parseLongitudeText, defaultSurfaceRangeKm, GeographicNavigationError, describeNavigationTarget,
  type GeographicCoordinateInput, type NavigationReference,
} from '../geographic/navigation.js';
import { bodyFixedToGeodetic } from '../geographic/coordinates.js';
import type { Vec3 } from '../spice-injection.js';

const ref = (name: string, radii: [number, number, number], extra = {}): NavigationReference => {
  const r = navigationReference({ name, radii, geometryType: 'Globe', ...extra });
  if (!r.ok) throw new Error(r.reason);
  return r.reference;
};
const EARTH = ref('Earth', [6378.137, 6378.137, 6356.752]);
const MARS = ref('Mars', [3396.19, 3396.19, 3376.2]);
const MOON = ref('Moon', [1737.4, 1737.4, 1737.4]);
const input = (bodyName: string, latDeg: number, lonDeg: number, over: Partial<GeographicCoordinateInput> = {}): GeographicCoordinateInput =>
  ({ bodyName, latDeg, lonDeg, latitude: 'planetocentric', longitudeDirection: 'east', ...over });
const len = (v: Vec3) => Math.hypot(...v);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const deg = (rad: number) => rad * 180 / Math.PI;

describe('navigationReference', () => {
  it('uses declared radii and never a display radius', () => {
    expect(EARTH.shape).toBe('oblate');
    expect(MOON.shape).toBe('sphere');
    expect(MOON.datum.origin).toBe('body-shape');
    expect(navigationReference({ name: 'Rock', geometryType: 'Globe' })).toEqual({ ok: false, reason: expect.stringContaining('no physical radii') });
  });
  it('prefers a terrain datum', () => {
    const r = navigationReference({
      name: 'Mars', radii: [3396.19, 3396.19, 3376.2],
      terrainDatum: { referenceShape: { kind: 'sphere', radiusKm: 3396.19 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    });
    expect(r.ok && r.reference.datum.origin).toBe('terrain');
  });
  it('gates irregular and non-globe bodies', () => {
    expect(navigationReference({ name: 'Bennu', radii: [0.29, 0.28, 0.25], irregular: true }).ok).toBe(false);
    expect(navigationReference({ name: 'Cassini', radii: [0.01, 0.01, 0.01], geometryType: 'Mesh' }).ok).toBe(false);
  });
});

describe('resolveGeographicTarget', () => {
  it('places Earth equator, mid and high latitudes geodetically', () => {
    for (const lat of [0, 45, 80]) {
      const t = resolveGeographicTarget(input('Earth', lat, -30, { latitude: 'planetographic' }), EARTH);
      const g = bodyFixedToGeodetic({ xKm: t.positionKm[0], yKm: t.positionKm[1], zKm: t.positionKm[2] },
        { referenceShape: EARTH.datum.referenceShape, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' });
      expect(g.latDeg).toBeCloseTo(lat, 9);
      expect(g.lonDeg).toBeCloseTo(-30, 9);
      expect(g.heightKm).toBeCloseTo(0, 6);
      expect(t.latGraphicDeg).toBeCloseTo(lat, 9);
    }
  });

  it('keeps planetocentric and planetographic distinct on an oblate body', () => {
    const c = resolveGeographicTarget(input('Mars', 18.4447, 77.4508), MARS); // Jezero
    const g = resolveGeographicTarget(input('Mars', 18.4447, 77.4508, { latitude: 'planetographic' }), MARS);
    expect(c.latCentricDeg).toBeCloseTo(18.4447, 9);
    expect(g.latGraphicDeg).toBeCloseTo(18.4447, 9);
    expect(c.latGraphicDeg).toBeGreaterThan(c.latCentricDeg); // graphic > centric in the north
    // On the ellipsoid, not a sphere: radius between polar and equatorial.
    expect(len(c.positionKm)).toBeLessThan(3396.19);
    expect(len(c.positionKm)).toBeGreaterThan(3376.2);
    expect(deg(Math.atan2(c.positionKm[1], c.positionKm[0]))).toBeCloseTo(77.4508, 9);
  });

  it('handles Shackleton near the south pole and the pole itself without NaN', () => {
    const t = resolveGeographicTarget(input('Moon', -89.9, 0), MOON);
    expect(t.positionKm[2]).toBeLessThan(-1737);
    const pole = resolveGeographicTarget(input('Moon', -90, 123), MOON);
    for (const v of [pole.positionKm, pole.up, pole.east, pole.north]) expect(v.every(Number.isFinite)).toBe(true);
    expect(Math.abs(dot(pole.east, pole.up))).toBeLessThan(1e-12);
    expect(pole.notes.join()).toMatch(/pole/);
  });

  it('agrees across the longitude seam and conventions', () => {
    const a = resolveGeographicTarget(input('Moon', 10, 180), MOON);
    const b = resolveGeographicTarget(input('Moon', 10, -180), MOON);
    const c = resolveGeographicTarget(input('Moon', 10, 270), MOON);
    const d = resolveGeographicTarget(input('Moon', 10, 90, { longitudeDirection: 'west' }), MOON);
    expect(a.lonEastDeg).toBe(180);
    expect(b.lonEastDeg).toBe(180);
    for (let i = 0; i < 3; i++) {
      expect(a.positionKm[i]).toBeCloseTo(b.positionKm[i], 9);
      expect(c.positionKm[i]).toBeCloseTo(d.positionKm[i], 9);
    }
    expect(c.lonEastDeg).toBeCloseTo(-90, 12);
  });

  it('rejects malformed input and unsupported conventions', () => {
    expect(() => resolveGeographicTarget(input('Moon', 91, 0), MOON)).toThrow(GeographicNavigationError);
    expect(() => resolveGeographicTarget(input('Moon', NaN, 0), MOON)).toThrow(/number/);
    expect(() => resolveGeographicTarget(input('Mars', 0, 0), MOON)).toThrow(/Moon/);
    const phobos = ref('Phobos', [13.0, 11.4, 9.1]);
    expect(() => resolveGeographicTarget(input('Phobos', 0, 0, { latitude: 'planetographic' }), phobos)).toThrow(/triaxial/);
    const t = resolveGeographicTarget(input('Phobos', 0, 90), phobos);
    expect(t.positionKm[1]).toBeCloseTo(11.4, 9);
  });

  it('raises onto negative terrain only for a terrain datum', () => {
    const terrain = ref('Mars', [3396.19, 3396.19, 3376.2], {
      terrainDatum: { referenceShape: { kind: 'sphere', radiusKm: 3396.19 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    });
    const t = resolveGeographicTarget(input('Mars', 18.4447, 77.4508), terrain);
    const low = withTerrainElevation(t, -2.6, 'mola');
    expect(len(low.positionKm)).toBeCloseTo(3396.19 - 2.6, 9);
    expect(low.height).toEqual({ from: 'terrain-sample', km: -2.6, sourceId: 'mola' });
    expect(withTerrainElevation(resolveGeographicTarget(input('Mars', 0, 0), MARS), 1, 'x').height.from).toBe('reference-surface');
  });
});

describe('surfacePointTarget', () => {
  it('keeps the exact picked position and its provenance', () => {
    const p: [number, number, number] = [1000.123456789, 1200.5, 700.25];
    const t = surfacePointTarget({
      bodyName: 'Moon', bodyFixedPositionKm: p, source: 'terrain', latDeg: 20, lonDeg: 50.19, latitudeKind: 'planetocentric',
      hit: { heightKm: -0.4, datum: { ...MOON.datum, origin: 'terrain' } }, surfaceNormal: [0, 0, 1],
    });
    expect(t.positionKm).toEqual(p);
    expect(t.origin).toEqual({ kind: 'surface-point', source: 'terrain', latDeg: 20, lonDeg: 50.19, latitudeKind: 'planetocentric' });
    expect(describeNavigationTarget(t, { lat: 1, lon: 2 })).toBe('20.0° N, 50.19° E');
    expect(t.height.km).toBe(-0.4);
    // A normal far from vertical (a crater wall) falls back to the datum's.
    expect(dot(t.up, [p[0] / len(p), p[1] / len(p), p[2] / len(p)])).toBeCloseTo(1, 9);
  });
});

describe('surfaceViewPlacement', () => {
  const t = resolveGeographicTarget(input('Mars', 18.4447, 77.4508), MARS);
  it('gives distinct presets looking at the target', () => {
    const o = surfaceViewPlacement(t, 'overhead');
    const q = surfaceViewPlacement(t, 'oblique');
    const s = surfaceViewPlacement(t, 'surface');
    const toEye = (pl: typeof o) => { const d: Vec3 = [pl.eyeKm[0] - t.positionKm[0], pl.eyeKm[1] - t.positionKm[1], pl.eyeKm[2] - t.positionKm[2]]; return dot(d, t.up) / len(d); };
    expect(toEye(o)).toBeCloseTo(1, 9);
    expect(toEye(q)).toBeCloseTo(Math.cos(50 * Math.PI / 180), 9);
    expect(toEye(s)).toBeLessThan(0.2);
    expect(o.rangeKm).toBeCloseTo(defaultSurfaceRangeKm('overhead', t.scaleKm), 9);
    expect(s.rangeKm).toBeLessThan(q.rangeKm);
    expect(q.rangeKm).toBeLessThan(o.rangeKm);
    expect(o.viewpoint).toMatchObject({ center: 'Mars', frame: 'BodyFixed', target: t.positionKm });
  });
  it('lifts the eye above known terrain', () => {
    const s = surfaceViewPlacement(t, 'surface', { groundRadiusAt: () => 3500, clearanceKm: 0.01 });
    expect(len(s.eyeKm)).toBeCloseTo(3500.01, 9);
    expect(s.liftedKm).toBeGreaterThan(0);
  });
  it('rejects a non-positive range', () => {
    expect(() => surfaceViewPlacement(t, 'overhead', { rangeKm: 0 })).toThrow(/positive/);
  });
});

describe('coordinate text', () => {
  it('parses signs and hemisphere letters', () => {
    expect(parseLatitudeText('18.44 N')).toEqual({ ok: true, deg: 18.44 });
    expect(parseLatitudeText('89.9°S')).toEqual({ ok: true, deg: -89.9 });
    expect(parseLatitudeText('-12')).toEqual({ ok: true, deg: -12 });
    expect(parseLatitudeText('95').ok).toBe(false);
    expect(parseLatitudeText('-5 S').ok).toBe(false);
    expect(parseLatitudeText('abc').ok).toBe(false);
    expect(parseLatitudeText('5 E').ok).toBe(false);
  });
  it('converts lettered longitudes into the chosen direction', () => {
    expect(parseLongitudeText('77.45 E', 'east')).toEqual({ ok: true, deg: 77.45 });
    expect(parseLongitudeText('77.45 W', 'east')).toEqual({ ok: true, deg: -77.45 });
    expect(parseLongitudeText('77.45 W', 'west')).toEqual({ ok: true, deg: 77.45 });
    expect(parseLongitudeText('282.55', 'west')).toEqual({ ok: true, deg: 282.55 });
    expect(parseLongitudeText('400', 'east').ok).toBe(false);
  });
});

describe('placement as a semantic viewpoint', () => {
  it('keeps the geographic target as the body turns', async () => {
    const { Universe } = await import('../Universe.js');
    const { resolveViewpoint } = await import('../viewpoint.js');
    const { resolveSpatialEndpoint } = await import('../geometry/spatial-relationships.js');
    const u = new Universe();
    u.loadCatalog({
      name: 'nav', items: [
        { name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
        { name: 'Mars', center: 'Sun', trajectory: { type: 'FixedPoint', position: [1e8, 0, 0] },
          rotationModel: { type: 'Uniform', period: 1, meridianAngle: 10, ascension: 40, declination: 70 } },
      ],
    } as never);
    const t = resolveGeographicTarget(input('Mars', 18.4447, 77.4508), MARS);
    const vp = surfaceViewPlacement(t, 'oblique').viewpoint;
    for (const et of [0, 3 * 3600, 7.7 * 3600]) {
      const r = resolveViewpoint(u, vp, et);
      const target = resolveSpatialEndpoint(u, { kind: 'body-fixed', bodyName: 'Mars', positionKm: t.positionKm }, et)!;
      const mars = u.absolutePositionOf('Mars', et);
      for (let i = 0; i < 3; i++) expect(r.target[i] + mars[i]).toBeCloseTo(target[i], 6);
    }
  });
});
