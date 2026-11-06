import { describe, it, expect } from 'vitest';
import {
  ARRAY_JOINTS, TRUSS_JOINTS, arrayNormal, rotateAboutX, sunTrackingAngles, sunTrackingJointAngles, wrapAngle, type Vec3,
} from './joints.js';

const norm = (v: Vec3): Vec3 => { const n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n]; };

describe('sunTrackingAngles', () => {
  it('leaves arrays unrotated when the Sun is on the model zenith axis', () => {
    const a = sunTrackingAngles([0, 1, 0])!;
    expect(a.truss).toBeCloseTo(0, 12);
    expect(a.array).toBeCloseTo(0, 12);
  });

  it('turns the truss a quarter turn to put the array normal on +Z, and +Z to -Y gives half a turn', () => {
    expect(sunTrackingAngles([0, 0, 1])!.truss).toBeCloseTo(Math.PI / 2, 12);
    expect(Math.abs(sunTrackingAngles([0, -1, 0])!.truss)).toBeCloseTo(Math.PI, 12);
    expect(sunTrackingAngles([0, 0, -1])!.truss).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('uses the array (beta) joint for a Sun off the truss plane and the truss for the rest', () => {
    // Sun 30 degrees off the Y-Z plane toward +X, in the Y direction.
    const sun: Vec3 = [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0];
    const a = sunTrackingAngles(sun)!;
    expect(a.truss).toBeCloseTo(0, 12);
    // +Z rotation by -30 deg carries +Y to (+sin30, cos30, 0).
    expect(a.array).toBeCloseTo(-Math.PI / 6, 12);
  });

  it('puts the array normal on the Sun for arbitrary directions (forward-composition check)', () => {
    for (const sun of [[0.3, -0.7, 0.2], [-0.9, 0.1, 0.4], [0.5, 0.5, -0.7], [-0.2, -0.3, -0.9], [1, 0.01, 0.02]] as Vec3[]) {
      const a = sunTrackingAngles(sun)!;
      const n = arrayNormal(a.truss, a.array);
      const s = norm(sun);
      for (let k = 0; k < 3; k++) expect(n[k]).toBeCloseTo(s[k], 12);
    }
  });

  it('is a pure function of the Sun direction (no history, scale-free)', () => {
    const a = sunTrackingAngles([0.2, 0.5, -0.3])!;
    const b = sunTrackingAngles([2, 5, -3])!;
    expect(b.truss).toBeCloseTo(a.truss, 12);
    expect(b.array).toBeCloseTo(a.array, 12);
    expect(sunTrackingAngles([0.2, 0.5, -0.3])).toEqual(a);
  });

  it('reports a zero or non-finite Sun instead of choosing angles', () => {
    expect(sunTrackingAngles([0, 0, 0])).toBeUndefined();
    expect(sunTrackingAngles([NaN, 1, 0])).toBeUndefined();
    expect(sunTrackingJointAngles([0, 0, 0])).toBeUndefined();
  });

  it('keeps angles inside (-pi, pi]', () => {
    for (let i = 0; i < 200; i++) {
      const sun: Vec3 = [Math.sin(i * 1.3), Math.cos(i * 0.7), Math.sin(i * 2.9)];
      const a = sunTrackingAngles(sun)!;
      expect(a.truss).toBeGreaterThan(-Math.PI - 1e-12);
      expect(a.truss).toBeLessThanOrEqual(Math.PI);
      expect(a.array).toBeGreaterThan(-Math.PI - 1e-12);
      expect(a.array).toBeLessThanOrEqual(Math.PI);
    }
  });
});

describe('sunTrackingJointAngles', () => {
  it('addresses every truss and array joint with the shared pair', () => {
    const j = sunTrackingJointAngles([0.3, -0.7, 0.2])!;
    expect(Object.keys(j.truss!).sort()).toEqual([...TRUSS_JOINTS].sort());
    expect(Object.keys(j.arrays!).sort()).toEqual([...ARRAY_JOINTS].sort());
    expect(new Set(Object.values(j.arrays!)).size).toBe(1);
  });
});

describe('helpers', () => {
  it('wrapAngle', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(0.5 + 2 * Math.PI)).toBeCloseTo(0.5, 12);
  });
  it('rotateAboutX carries +Y toward +Z for a positive angle', () => {
    const v = rotateAboutX([0, 1, 0], Math.PI / 2);
    expect(v[1]).toBeCloseTo(0, 12);
    expect(v[2]).toBeCloseTo(1, 12);
  });
});
