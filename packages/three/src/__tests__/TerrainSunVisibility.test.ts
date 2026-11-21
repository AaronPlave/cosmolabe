import { describe, expect, it } from 'vitest';
import { horizonAlong, occluderRangeKm, solarVisibility, sunFraction, type HeightKm } from '../TerrainSunVisibility.js';

const R = 1737.4; // Moon, km
const DEG = Math.PI / 180;

/** North-south ridge crest `d0Km` east of the receiver, `Hkm` above the sphere; flat (0) elsewhere. */
const ridge = (d0Km: number, Hkm: number, widthKm = 1): HeightKm => (e) => (Math.abs(e - d0Km) <= widthKm / 2 ? Hkm : 0);

/**
 * Independent ground truth: the Sun ray is the line r(φ) = rp·cos(el)/cos(el+φ) in polar coordinates about the
 * body centre (no tangent-plane or curvature approximation shared with the marcher). Shadowed iff the ray is still
 * below the crest at the crest's central angle.
 */
const rayBelowCrest = (elDeg: number, h0: number, dKm: number, Hkm: number) => {
  const el = elDeg * DEG;
  return ((R + h0) * Math.cos(el)) / Math.cos(el + dKm / R) < R + Hkm;
};

describe('terrain solar visibility reference (#205)', () => {
  it('matches the analytic ray test for a synthetic ridge across solar elevations', () => {
    const h0 = 0, d0 = 29.5, H = 1.5; // 1.5 km ridge whose sun-facing edge is 29.5 km east of the receiver
    const g = ridge(30, H); // 1 km wide, centred 30 km east
    for (const el of [0.5, 1, 2, 2.4, 2.6, 3, 5, 8]) {
      // Compare the disk centre, so the penumbra is excluded by testing the horizon directly.
      const horizon = horizonAlong(g, 90, h0, R, 80, 0.25).elevationDeg;
      expect(el < horizon, `el=${el} horizon=${horizon.toFixed(3)}`).toBe(rayBelowCrest(el, h0, d0, H));
    }
  });

  it('moves the shadow edge predictably with azimuth (rotation sweep)', () => {
    const g = ridge(30, 1.5); // north-south wall: along azimuth az it is 30/sin(az) away
    // Distance to the wall along azimuth az is 30/sin(az): a lower crest angle as the Sun swings away from east.
    let previous = Infinity;
    for (const az of [90, 80, 70, 60, 50, 40]) {
      const h = horizonAlong(g, az, 0, R, 150, 0.25).elevationDeg;
      expect(h).toBeLessThan(previous);
      previous = h;
    }
  });

  it('has a penumbra the width of the Sun disk, continuous in time', () => {
    expect(sunFraction(10, 0)).toBe(1);
    expect(sunFraction(-10, 0)).toBe(0);
    expect(sunFraction(0, 0)).toBeCloseTo(0.5, 6);
    const e = 0.2665;
    expect(sunFraction(-e, 0)).toBe(0);
    expect(sunFraction(e, 0)).toBe(1);
  });

  it('is shadowed behind the ridge and lit beyond the occluder range', () => {
    const g = ridge(30, 1.5);
    expect(solarVisibility(g, 90, 1, 0, R, 80, 0.25).state).toBe('shadowed');
    expect(solarVisibility(g, 270, 1, 0, R, 80, 0.25).state).toBe('lit'); // Sun on the open side
    expect(solarVisibility(g, 90, 6, 0, R, 80, 0.25).state).toBe('lit');
  });

  it('never calls terrain with missing source coverage lit or shadowed', () => {
    const partial: HeightKm = (e) => (e < 10 ? 0 : null);
    const v = solarVisibility(partial, 90, 1, 0, R, 80, 0.25);
    expect(v.state).toBe('unknown');
    expect(v.fraction).toBeNull();
    // Already fully shadowed by covered terrain: more terrain can only add shadow, so it is known.
    const wall: HeightKm = (e) => (e < 10 ? (e > 4 ? 3 : 0) : null);
    expect(solarVisibility(wall, 90, 1, 0, R, 80, 0.25).state).toBe('shadowed');
  });

  it('occluderRangeKm bounds where terrain can matter; the marcher agrees at its edge', () => {
    // Shackleton-like: receiver on a crater floor 3 km below the reference sphere, 4 km relief above it, Sun at 1.5°.
    const range = occluderRangeKm(1.5, -3, 1, R);
    // Flat-ground estimate is 4 km / tan(1.5°) = 153 km; curvature lifts the ray over the sphere (+d²/2R) and halves it.
    expect(range).toBeGreaterThan(70);
    expect(range).toBeLessThan(90);
    // Just inside the range a crest of that height still blocks; just outside it cannot.
    expect(rayBelowCrest(1.5, -3, range * 0.98, 1)).toBe(true);
    expect(rayBelowCrest(1.5, -3, range * 1.02, 1)).toBe(false);
    expect(occluderRangeKm(-1, 0, 2, R)).toBe(Infinity);
    expect(occluderRangeKm(5, 0, -1, R)).toBe(0);
  });
});
