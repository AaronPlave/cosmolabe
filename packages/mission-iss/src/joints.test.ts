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

  it('puts the array normal on the Sun for arbitrary directions away from the X axis (forward-composition check)', () => {
    for (const sun of [[0.3, -0.7, 0.2], [-0.9, 0.1, 0.4], [0.5, 0.5, -0.7], [-0.2, -0.3, -0.9], [0.9, 0.3, 0.3]] as Vec3[]) {
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

const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b)))));
const deg = (rad: number) => (rad * 180) / Math.PI;

describe('Sun near the model X axis (truss singularity)', () => {
  const off = (sepDeg: number, azimuthRad: number, sign = 1): Vec3 => {
    const s = Math.sin((sepDeg * Math.PI) / 180);
    return [sign * Math.cos((sepDeg * Math.PI) / 180), s * Math.cos(azimuthRad), s * Math.sin(azimuthRad)];
  };

  it('holds the truss steady on the axis instead of snapping by ~180 degrees for a tiny change', () => {
    for (const sign of [1, -1]) {
      const a = sunTrackingAngles(off(0.05, 0, sign))!, b = sunTrackingAngles(off(0.05, Math.PI * 0.99, sign))!;
      // Opposite sides of the axis: the unguarded formula puts the truss ~180 degrees apart.
      expect(Math.abs(a.truss)).toBeLessThan(1e-2);
      expect(Math.abs(b.truss)).toBeLessThan(1e-2);
      expect(Math.abs(sunTrackingAngles(off(0, 0, sign))!.truss)).toBe(0);
    }
  });

  it('is exact outside 8 degrees and within 8 degrees of the Sun inside it', () => {
    for (const sep of [0, 0.5, 1, 2, 4, 6, 7.9, 8.1, 20, 60]) {
      for (let k = 0; k < 12; k++) {
        const sun = off(sep, (k * Math.PI) / 6 + 0.1);
        const a = sunTrackingAngles(sun)!;
        const err = deg(angleBetween(arrayNormal(a.truss, a.array), sun));
        if (sep >= 8.1) expect(err).toBeLessThan(1e-4); else expect(err).toBeLessThanOrEqual(8 + 1e-9);
      }
    }
  });

  it('stays continuous for the Sun passing the axis at any offset, except across the documented cut on the model -Y side', () => {
    // -Y is nadir in this model (cupola side): the Sun is there only in eclipse. A function that tracks the azimuth
    // away from the axis and is steady on it must change pose along one line; this is it.
    const inCut = (y: number, z: number) => Math.hypot(y, z) < 0.15 && y < 0 && Math.abs(Math.atan2(z, y)) > (170 * Math.PI) / 180;
    const step = 0.002; // rad of Sun motion per sample
    for (const closestDeg of [0, 0.3, 1, 2.5, 5, 8, 12]) {
      const d = Math.tan((closestDeg * Math.PI) / 180);
      for (const psi of [0, 0.7, Math.PI / 2, 2.1, Math.PI, 4.0, 5.2]) {
        // A straight run across the tangent plane at +X: along (cos psi, sin psi), offset d to its side.
        let prev: number | undefined, py = 0, pz = 0;
        for (let t = -0.4; t <= 0.4; t += step) {
          const y = t * Math.cos(psi) - d * Math.sin(psi), z = t * Math.sin(psi) + d * Math.cos(psi);
          const truss = sunTrackingAngles([1, y, z])!.truss;
          if (prev !== undefined && !inCut(y, z) && !inCut(py, pz)) expect(Math.abs(wrapAngle(truss - prev))).toBeLessThan(0.15);
          prev = truss; py = y; pz = z;
        }
      }
    }
  });
});

describe('Sun directions an ISS in its normal attitude can see', () => {
  it('the truss turns smoothly through every orbit at every beta angle (no snap, arrays exact)', () => {
    // Local frame: +Z forward, +Y zenith, +X port (the orbit normal is -X). The Sun is at beta from the orbit plane, so its
    // angle from the model X axis is at least 90 - 75 = 15 degrees: well outside the 8 degree fade where the cut lives.
    for (let betaDeg = -75; betaDeg <= 75; betaDeg += 5) {
      const beta = (betaDeg * Math.PI) / 180;
      let prev: number | undefined;
      for (let phase = 0; phase <= 2 * Math.PI; phase += 0.002) {
        const sun: Vec3 = [-Math.sin(beta), Math.cos(beta) * Math.cos(phase), Math.cos(beta) * Math.sin(phase)];
        const a = sunTrackingAngles(sun)!;
        expect(deg(angleBetween(arrayNormal(a.truss, a.array), sun))).toBeLessThan(1e-4);
        if (prev !== undefined) expect(Math.abs(wrapAngle(a.truss - prev))).toBeLessThan(0.1);
        prev = a.truss;
      }
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
