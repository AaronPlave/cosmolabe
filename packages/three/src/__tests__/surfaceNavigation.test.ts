import { describe, expect, it } from 'vitest';
import {
  bodyFixedToGeodeticRad, dollyAlongView, geodeticToBodyFixedKm, localFrame,
  moveAlongSurface, type Ellipsoid, type SurfacePose,
} from '../controls/surfaceNavigation.js';

const DEG = Math.PI / 180;
const MOON: Ellipsoid = { a: 1737.4, e2: 0 };
const MARS: Ellipsoid = { a: 3396.19, e2: 1 - (3376.2 / 3396.19) ** 2 };
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Straight-line distance between two poses, measured at the first pose's height. */
const chordKm = (p: SurfacePose, q: SurfacePose, ell: Ellipsoid) =>
  dist(geodeticToBodyFixedKm(p.latRad, p.lonRad, p.altKm, ell), geodeticToBodyFixedKm(q.latRad, q.lonRad, p.altKm, ell));

describe('surface geodesy round trips', () => {
  for (const [name, ell] of [['Moon', MOON], ['Mars', MARS]] as const) {
    it(`${name}: geodetic ↔ body-fixed at all latitudes including the poles`, () => {
      for (const latDeg of [-90, -89.99, -89.9, -45, 0, 18.4, 89.9, 90]) {
        for (const alt of [-8, 0, 0.002, 5, 400]) {
          const p = geodeticToBodyFixedKm(latDeg * DEG, 77 * DEG, alt, ell);
          const g = bodyFixedToGeodeticRad(p, ell);
          expect(g.latRad / DEG).toBeCloseTo(latDeg, 9);
          expect(g.altKm).toBeCloseTo(alt, 6);
          expect(dist(geodeticToBodyFixedKm(g.latRad, g.lonRad, g.altKm, ell), p)).toBeLessThan(1e-6);
        }
      }
    });
  }

  it('uses the geodetic (not radial) normal on an oblate body', () => {
    const up = localFrame(45 * DEG, 0).up;
    const radial = geodeticToBodyFixedKm(45 * DEG, 0, 0, MARS);
    const r = Math.hypot(...radial);
    expect(up[2]).toBeCloseTo(Math.sin(45 * DEG), 12);
    expect(radial[2] / r).not.toBeCloseTo(up[2], 4);
  });
});

describe('polar ENU motion', () => {
  const shackleton: SurfacePose = { latRad: -89.9 * DEG, lonRad: 0, altKm: 0.05, headingRad: Math.PI, pitchRad: -0.3 };

  it('a step moves the same ground distance at the equator and next to the pole', () => {
    const eq = { ...shackleton, latRad: 0 };
    for (const heading of [0, Math.PI / 2, Math.PI, 1.1]) {
      for (const start of [eq, shackleton]) {
        const pose = { ...start, headingRad: heading };
        const next = moveAlongSurface(pose, 0.1, 0, MOON);
        expect(chordKm(pose, next, MOON)).toBeCloseTo(0.1, 5);
        expect(next.altKm).toBe(pose.altKm);
      }
    }
  });

  it('walks straight across the south pole and out the other side', () => {
    // Heading south from 89.9°S, lon 0: the pole is ~3.03 km ahead.
    let pose = { ...shackleton };
    const start = geodeticToBodyFixedKm(pose.latRad, pose.lonRad, 0, MOON);
    for (let i = 0; i < 600; i++) pose = moveAlongSurface(pose, 0.01, 0, MOON);
    // 6 km travelled: now ~3 km past the pole on the antimeridian, heading north.
    expect(Math.abs(pose.lonRad)).toBeCloseTo(Math.PI, 3);
    expect(pose.latRad / DEG).toBeCloseTo(-89.9, 2);
    expect(Math.cos(pose.headingRad)).toBeCloseTo(1, 4);
    expect(chordKm({ ...shackleton }, pose, MOON)).toBeCloseTo(6, 1);
    expect(Number.isFinite(dist(start, [0, 0, 0]))).toBe(true);
  });

  it('strafing around the pole at fixed radius does not blow up longitude speed', () => {
    let pose: SurfacePose = { ...shackleton, latRad: -89.999 * DEG, headingRad: 0 };
    for (let i = 0; i < 100; i++) {
      const next = moveAlongSurface(pose, 0, 0.001, MOON);
      expect(chordKm(pose, next, MOON)).toBeCloseTo(0.001, 6);
      pose = next;
    }
  });

  it('is well-defined exactly at the pole', () => {
    const pole: SurfacePose = { latRad: -Math.PI / 2, lonRad: 0, altKm: 0.05, headingRad: 0.7, pitchRad: 0 };
    const next = moveAlongSurface(pole, 0.5, 0, MOON);
    expect(chordKm(pole, next, MOON)).toBeCloseTo(0.5, 5);
    expect(Number.isFinite(next.headingRad)).toBe(true);
  });
});

describe('dolly along the view ray', () => {
  const pose: SurfacePose = { latRad: -89.5 * DEG, lonRad: 30 * DEG, altKm: 1, headingRad: 2, pitchRad: -0.4 };

  it('moves exactly along the ray', () => {
    const next = dollyAlongView(pose, 0.25, MOON);
    const a = geodeticToBodyFixedKm(pose.latRad, pose.lonRad, pose.altKm, MOON);
    const b = geodeticToBodyFixedKm(next.latRad, next.lonRad, next.altKm, MOON);
    expect(dist(a, b)).toBeCloseTo(0.25, 9);
    expect(next.altKm).toBeLessThan(pose.altKm);
    // Same ray: dolly back returns to the start.
    const back = dollyAlongView(next, -0.25, MOON);
    expect(dist(geodeticToBodyFixedKm(back.latRad, back.lonRad, back.altKm, MOON), a)).toBeLessThan(1e-9);
  });

  it('stops at the terrain clearance floor instead of tunnelling', () => {
    const floor = () => 0.8;
    const next = dollyAlongView(pose, 5, MOON, floor);
    expect(next.altKm).toBeGreaterThanOrEqual(0.8);
    expect(next.altKm).toBeCloseTo(0.8, 4);
  });

  it('stops on rising terrain even when ellipsoid height climbs', () => {
    // Level ray from the equator heading north; terrain climbs 0.2 km per km northward,
    // faster than the ray gains height over the curve.
    const level: SurfacePose = { latRad: 0, lonRad: 0, altKm: 0.05, headingRad: 0, pitchRad: 0 };
    const uphill = (latRad: number) => 0.002 + Math.max(0, latRad * MOON.a) * 0.2;
    const next = dollyAlongView(level, 0.5, MOON, uphill);
    expect(next.altKm).toBeGreaterThan(level.altKm);
    expect(next.altKm - uphill(next.latRad)).toBeGreaterThanOrEqual(-1e-6);
    expect(next.altKm - uphill(next.latRad)).toBeLessThan(1e-3);
  });

  it('keeps a buried camera from moving to worse clearance, even while climbing', () => {
    // Below a floor that rises northward faster than the ray climbs: going on loses clearance.
    const buried: SurfacePose = { latRad: 0.001, lonRad: 0, altKm: 0.1, headingRad: 0, pitchRad: 0.05 };
    const floor = (latRad: number) => 1 + latRad * MOON.a * 0.5;
    expect(dollyAlongView(buried, 0.2, MOON, floor)).toEqual(buried);
    // Backing out toward lower ground improves clearance and is allowed.
    expect(dollyAlongView(buried, -0.2, MOON, floor).latRad).toBeLessThan(buried.latRad);
  });

  it('lets a camera below the floor back out but not go deeper', () => {
    const buried = { ...pose, altKm: 0.5 };
    expect(dollyAlongView(buried, 0.1, MOON, () => 0.8)).toEqual(buried);
    expect(dollyAlongView(buried, -0.1, MOON, () => 0.8).altKm).toBeGreaterThan(0.5);
  });
});
