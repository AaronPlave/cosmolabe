import { describe, it, expect } from 'vitest';
import {
  eclipticToEquatorial,
  equatorialToEcliptic,
  positionForCesium,
  geodeticToCartesian,
  quaternionEclipticToEquatorial,
} from '../CoordinateTransforms.js';

describe('CoordinateTransforms', () => {
  describe('eclipticToEquatorial', () => {
    it('preserves X axis (vernal equinox direction)', () => {
      const result = eclipticToEquatorial([1, 0, 0]);
      expect(result[0]).toBeCloseTo(1000, 1); // 1 km → 1000 m
      expect(result[1]).toBeCloseTo(0, 1);
      expect(result[2]).toBeCloseTo(0, 1);
    });

    it('rotates ecliptic Z (north pole) into equatorial Y/Z', () => {
      // Ecliptic Z points toward ecliptic north pole.
      // In equatorial, this is tilted by obliquity (23.44°):
      //   y_eq = -sin(ε) * z_ecl, z_eq = cos(ε) * z_ecl
      const result = eclipticToEquatorial([0, 0, 1]);
      expect(result[0]).toBeCloseTo(0, 1);
      // y_eq = -sin(23.44°) * 1000 ≈ -397.8
      expect(result[1]).toBeCloseTo(-397.8, 0);
      // z_eq = cos(23.44°) * 1000 ≈ 917.5
      expect(result[2]).toBeCloseTo(917.5, 0);
    });

    it('converts km to meters', () => {
      const result = eclipticToEquatorial([100, 0, 0]);
      expect(result[0]).toBeCloseTo(100000, 1); // 100 km = 100,000 m
    });
  });

  describe('equatorialToEcliptic', () => {
    it('roundtrips with eclipticToEquatorial', () => {
      const original: [number, number, number] = [150000, -80000, 42000]; // km
      const equatorial = eclipticToEquatorial(original);
      const recovered = equatorialToEcliptic(equatorial);
      expect(recovered[0]).toBeCloseTo(original[0], 3);
      expect(recovered[1]).toBeCloseTo(original[1], 3);
      expect(recovered[2]).toBeCloseTo(original[2], 3);
    });
  });

  describe('positionForCesium', () => {
    it('is an alias for eclipticToEquatorial', () => {
      const pos: [number, number, number] = [100, 200, 300];
      const a = eclipticToEquatorial(pos);
      const b = positionForCesium(pos);
      expect(a).toEqual(b);
    });
  });

  describe('geodeticToCartesian', () => {
    it('equator + prime meridian → X axis', () => {
      const result = geodeticToCartesian(0, 0, 0, 6371);
      expect(result[0]).toBeCloseTo(6371000, 0);
      expect(result[1]).toBeCloseTo(0, 0);
      expect(result[2]).toBeCloseTo(0, 0);
    });

    it('north pole → Z axis', () => {
      const result = geodeticToCartesian(90, 0, 0, 6371);
      expect(result[0]).toBeCloseTo(0, 0);
      expect(result[1]).toBeCloseTo(0, 0);
      expect(result[2]).toBeCloseTo(6371000, 0);
    });

    it('accounts for height above surface', () => {
      const result = geodeticToCartesian(0, 0, 100, 6371);
      expect(result[0]).toBeCloseTo(6471000, 0); // 6371 + 100 = 6471 km
    });
  });

  describe('quaternionEclipticToEquatorial', () => {
    it('identity quaternion rotates only by obliquity', () => {
      const result = quaternionEclipticToEquatorial([1, 0, 0, 0]);
      // Should be the obliquity rotation: (cos(ε/2), sin(ε/2), 0, 0)
      const halfObl = 23.4392911 * Math.PI / 360;
      expect(result[0]).toBeCloseTo(Math.cos(halfObl), 6);
      expect(result[1]).toBeCloseTo(Math.sin(halfObl), 6);
      expect(result[2]).toBeCloseTo(0, 6);
      expect(result[3]).toBeCloseTo(0, 6);
    });

    it('produces unit quaternion', () => {
      const q: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5]; // unit quaternion
      const result = quaternionEclipticToEquatorial(q);
      const norm = Math.sqrt(result[0] ** 2 + result[1] ** 2 + result[2] ** 2 + result[3] ** 2);
      expect(norm).toBeCloseTo(1, 6);
    });
  });
});
