import { describe, expect, it } from 'vitest';
import { getAtmospherePreset, resolveAtmosphereParams } from '../AtmosphereMesh.js';
import { extinctionAt, normalizeAtmosphere, profileDensity, raySphereInterval, transmittanceToSpace } from '../AtmosphereModel.js';

const earth = getAtmospherePreset('Earth')!;

describe('atmosphere geometry and normalization', () => {
  it('intersects a sphere from outside, inside, and misses it', () => {
    expect(raySphereInterval([0, 0, 10], [0, 0, -1], 2)).toEqual([8, 12]);
    expect(raySphereInterval([0, 0, 0], [1, 0, 0], 2)).toEqual([0, 2]);
    expect(raySphereInterval([0, 0, 10], [1, 0, 0], 2)).toBeNull();
  });

  it('keeps legacy catalog fields and normalizes RGB coefficients', () => {
    const inline = resolveAtmosphereParams({
      mieCoeff: 0.02, mieScaleHeight: 4, rayleighCoeff: [0.01, 0.02, 0.03],
      absorptionCoeff: [0.001, 0.002, 0.003],
    })!;
    const model = normalizeAtmosphere(inline);
    expect(model.mie.scattering).toEqual([0.02, 0.02, 0.02]);
    expect(model.mie.extinction).toEqual([0.02, 0.02, 0.02]);
    expect(model.rayleigh.scaleHeightKm).toBe(4);
    expect(model.heightKm).toBeCloseTo(-4 * Math.log(0.0005));
    extinctionAt(model, 0).forEach((value, i) =>
      expect(value).toBeCloseTo([0.031, 0.042, 0.053][i]));
  });

  it('supports separate exponential and tent profiles', () => {
    const model = normalizeAtmosphere({
      ...earth, heightKm: 100, rayleighScaleHeightKm: 8,
      mieScaleHeight: 1.2, mieExtinctionCoeff: [0.01, 0.02, 0.03],
      absorptionProfile: { type: 'tent', peakKm: 25, halfWidthKm: 15 },
    });
    expect(model.heightKm).toBe(100);
    expect(model.mie.extinction).toEqual([0.01, 0.02, 0.03]);
    expect(profileDensity(model.absorption.profile, 10)).toBe(0);
    expect(profileDensity(model.absorption.profile, 25)).toBe(1);
    expect(profileDensity(model.absorption.profile, 40)).toBe(0);
    expect(extinctionAt(model, 25)[0]).toBeGreaterThan(model.absorption.extinction[0]);
  });

  it('loads optional normalized fields from inline catalogs without changing legacy fields', () => {
    const inline = resolveAtmosphereParams({
      mieCoeff: [0.01, 0.008, 0.006], mieScaleHeight: 2,
      rayleighCoeff: [0.002, 0.004, 0.008], absorptionCoeff: [0.001, 0.002, 0.003],
      heightKm: 80, rayleighScaleHeightKm: 9,
      mieExtinctionCoeff: [0.02, 0.016, 0.012],
      absorptionProfile: { type: 'tent', peakKm: 20, halfWidthKm: 10 },
      groundAlbedo: [0.1, 0.2, 0.3],
    })!;
    const model = normalizeAtmosphere(inline);
    expect(model.heightKm).toBe(80);
    expect(model.rayleigh.scaleHeightKm).toBe(9);
    expect(model.mie.extinction).toEqual([0.02, 0.016, 0.012]);
    expect(model.absorption.profile).toEqual({ type: 'tent', peakKm: 20, halfWidthKm: 10 });
    expect(model.groundAlbedo).toEqual([0.1, 0.2, 0.3]);
    inline.rayleighCoeff[0] = 1;
    expect(model.rayleigh.scattering[0]).toBe(0.002);
  });
});

describe('direct transmittance reference', () => {
  const model = normalizeAtmosphere({
    ...earth, heightKm: 100, rayleighScaleHeightKm: 8, mieScaleHeight: 1.2,
    absorptionProfile: { type: 'exponential', scaleHeightKm: 1.2 },
  });
  const radius = 6378.1;

  it('matches the independent vertical exponential integral', () => {
    const actual = transmittanceToSpace(model, radius, [radius, 0, 0], [1, 0, 0], 1024);
    const depth = [0, 1, 2].map((i) => {
      const ray = model.rayleigh.scattering[i] * 8 * (1 - Math.exp(-100 / 8));
      const mie = model.mie.extinction[i] * 1.2 * (1 - Math.exp(-100 / 1.2));
      const absorption = model.absorption.extinction[i] * 1.2 * (1 - Math.exp(-100 / 1.2));
      return ray + mie + absorption;
    });
    actual.forEach((value, i) => expect(value).toBeCloseTo(Math.exp(-depth[i]), 3));
  });

  it('dims a grazing sun path and blocks a planet-intersecting path', () => {
    const point: [number, number, number] = [radius + 2, 0, 0];
    const zenith = transmittanceToSpace(model, radius, point, [1, 0, 0]);
    const grazing = transmittanceToSpace(model, radius, point, [0, 1, 0]);
    const blocked = transmittanceToSpace(model, radius, point, [-0.1, Math.sqrt(0.99), 0]);
    zenith.forEach((value, i) => {
      expect(value).toBeGreaterThan(grazing[i]);
      expect(value).toBeLessThanOrEqual(1);
      expect(grazing[i]).toBeGreaterThanOrEqual(0);
    });
    expect(blocked).toEqual([0, 0, 0]);
  });

  it('approaches unit transmittance continuously at the shell', () => {
    const under = transmittanceToSpace(model, radius, [radius + 99.999, 0, 0], [1, 0, 0]);
    const above = transmittanceToSpace(model, radius, [radius + 100.001, 0, 0], [1, 0, 0]);
    above.forEach((value, i) => {
      expect(value).toBe(1);
      expect(Math.abs(under[i] - value)).toBeLessThan(0.0001);
    });
  });

  it('decreases exponential density with altitude', () => {
    const rayleigh = model.rayleigh.scaleHeightKm;
    const profile = { type: 'exponential' as const, scaleHeightKm: rayleigh };
    expect(profileDensity(profile, 0)).toBeGreaterThan(profileDensity(profile, 2));
    expect(profileDensity(profile, 2)).toBeGreaterThan(profileDensity(profile, 20));
  });
});
