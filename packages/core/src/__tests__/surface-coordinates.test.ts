import { describe, expect, it } from 'vitest';
import { bodySurfaceCoordinates, bodyFixedToSurfacePosition, surfacePositionToBodyFixed, canonicalLongitude, displayLongitude, formatSurfaceAngle, geodeticToBodyFixed } from '../surface-coordinates.js';

describe('shared surface coordinates', () => {
  for (const radii of [[1737.4, 1737.4, 1737.4], [6378.137, 6378.137, 6356.752], [20, 15, 10]] as [number, number, number][]) {
    it(`round-trips reference-grid intersections and heights on ${radii}`, () => {
      const coordinates = bodySurfaceCoordinates({ name: 'Fixture', radii })!;
      for (const latDeg of [-90, -60, 0, 45, 89.999, 90]) for (const lonDeg of [-180, -90, 0, 90, 179.99, 360]) {
        const p = surfacePositionToBodyFixed({ latDeg, lonDeg, heightKm: 0.4 }, coordinates);
        const q = bodyFixedToSurfacePosition(p, coordinates);
        expect(q.latDeg).toBeCloseTo(latDeg, 8);
        if (Math.abs(latDeg) < 90) expect(q.lonDeg).toBeCloseTo(canonicalLongitude(lonDeg), 8);
        expect(q.heightKm).toBeCloseTo(0.4, 8);
      }
    });
  }
  it('uses east-positive physical Y, distinct geodetic latitude and explicit triaxial fallback', () => {
    const c = bodySurfaceCoordinates({ name: 'Earth', radii: [6378, 6378, 6357] })!;
    const p = surfacePositionToBodyFixed({ latDeg: 45, lonDeg: 90 }, c);
    expect(p.yKm).toBeGreaterThan(0);
    expect(Math.atan2(p.zKm, Math.hypot(p.xKm, p.yKm)) * 180 / Math.PI).toBeLessThan(45);
    const t = bodySurfaceCoordinates({ name: 'Irregular', radii: [20, 15, 10] })!;
    expect(t.latitudeType).toBe('planetocentric');
    expect(() => geodeticToBodyFixed({ latDeg: 45, lonDeg: 90 }, t.datum)).toThrow(/triaxial/);
  });
  it('normalizes seams and declares display direction', () => {
    expect(canonicalLongitude(90, 'west')).toBe(-90);
    expect(canonicalLongitude(360)).toBe(0);
    expect(canonicalLongitude(180)).toBe(-180);
    expect(displayLongitude(90, { positiveLongitude: 'west', longitudeDomain: 'unsigned' })).toBe(270);
    expect(formatSurfaceAngle(360, 'longitude')).toBe('0°');
    expect(formatSurfaceAngle(180, 'longitude')).toBe('180°W');
    expect(formatSurfaceAngle(-90, 'longitude')).toBe('90°W');
    expect(formatSurfaceAngle(90, 'longitude')).toBe('90°E');
    expect(formatSurfaceAngle(0.1, 'latitude', 0.1)).toBe('0.1°N');
  });
  it('preserves an explicitly declared target frame rather than inferring an IAU name', () => {
    const coordinates = bodySurfaceCoordinates({ name: 'Mars', radii: [3396.19, 3396.19, 3376.2], rotation: { targetFrame: 'IAU_MARS' } });
    expect(coordinates?.frame).toBe('IAU_MARS');
  });
  it('does not invent physical coordinates for placeholders or spacecraft', () => {
    expect(bodySurfaceCoordinates({ name: 'Placeholder' })).toBeNull();
    expect(bodySurfaceCoordinates({ name: 'Craft', radii: [1, 1, 1], classification: 'spacecraft' })).toBeNull();
    expect(bodySurfaceCoordinates({ name: 'Invalid', radii: [1, NaN, 1] })).toBeNull();
  });
});
