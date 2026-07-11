// Validates the two new geometry-finder bindings (gfsep, gfposc) against
// independent per-epoch geometry on the committed Cassini fixtures, mirroring the
// occultation.test.ts approach (gfoclt vs occult). These unblock the az/el-mask and
// sun-exclusion access constraints. Geometry near Saturn Orbit Insertion, 2004-07-01.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, type SpiceEngine, type Vec3 } from './index.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

const CASSINI = '-82';
const STEP = 300; // seconds; shorter than the separation/elevation events sampled

/** Angle (rad) between two vectors, the vsep computation done independently in JS. */
const vsep = (a: Vec3, b: Vec3): number => {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  const na = Math.hypot(a.x, a.y, a.z);
  const nb = Math.hypot(b.x, b.y, b.z);
  // Clamp guards against acos domain error from floating-point overshoot.
  return Math.acos(Math.min(1, Math.max(-1, dot / (na * nb))));
};

describe('cspice-wasm gfsep vs independent vsep', () => {
  let spice: SpiceEngine;
  let et0: number;
  let et1: number;

  beforeAll(async () => {
    spice = await createSpiceEngine();
    for (const k of ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp']) {
      await spice.furnsh(k, fixture(k));
    }
    et0 = await spice.str2et('2004-07-01T00:00:00');
    et1 = await spice.str2et('2004-07-01T06:00:00');
  });

  // Independent angular separation (rad) of the Sun and Saturn directions from
  // Cassini at et, from two spkpos direction vectors.
  const separation = async (et: number): Promise<number> => {
    const sun = await spice.spkpos('SUN', et, 'J2000', 'NONE', CASSINI);
    const sat = await spice.spkpos('SATURN', et, 'J2000', 'NONE', CASSINI);
    return vsep(sun.position, sat.position);
  };

  it('surfaces a SPICE failure as a typed error (fails loud)', async () => {
    // An unresolved body produces an explicit, located SpiceError rather than a
    // silent empty result, mirroring how the bindings surface SPICE failures.
    await expect(
      spice.gfsep('NOSUCHBODY', 'POINT', 'J2000', 'SATURN', 'POINT', 'J2000', 'NONE', CASSINI, '<', 0.5, 0, STEP, et0, et1),
    ).rejects.toThrow();
  });

  it('finds separation-below intervals and the relation holds inside, fails outside', async () => {
    // The Sun-Saturn separation from Cassini falls from ~2.7 to ~0.42 rad and rises
    // again across this window, so it crosses 0.5 rad twice (one below interval).
    const REFVAL = 0.5; // rad (about 28.6 degrees)
    const intervals = await spice.gfsep(
      'SUN', 'POINT', 'J2000',
      'SATURN', 'POINT', 'J2000',
      'NONE', CASSINI,
      '<', REFVAL, 0, STEP, et0, et1,
    );
    expect(intervals.length).toBeGreaterThan(0);

    let prevStop = et0 - 1;
    for (const [s, e] of intervals) {
      expect(s).toBeGreaterThanOrEqual(et0);
      expect(e).toBeLessThanOrEqual(et1);
      expect(e).toBeGreaterThan(s);
      expect(s).toBeGreaterThan(prevStop); // sorted, disjoint
      prevStop = e;
      // Inside the interval the separation is below the reference value.
      expect(await separation((s + e) / 2)).toBeLessThan(REFVAL);
    }
    // In the gaps the separation is at or above the reference value.
    const edges = [et0, ...intervals.flat(), et1];
    for (let i = 0; i < edges.length; i += 2) {
      const gs = edges[i]!;
      const ge = edges[i + 1]!;
      if (ge - gs < 4 * STEP) continue;
      expect(await separation((gs + ge) / 2)).toBeGreaterThanOrEqual(REFVAL);
    }
  });

  it('interval edges are where the separation crosses the reference value', async () => {
    const REFVAL = 0.5;
    const intervals = await spice.gfsep(
      'SUN', 'POINT', 'J2000',
      'SATURN', 'POINT', 'J2000',
      'NONE', CASSINI,
      '<', REFVAL, 0, STEP, et0, et1,
    );
    const [s, e] = intervals[0]!;
    // At each window edge the independent separation equals the reference value
    // (the finder's root); a step inside is below, a step outside is at/above.
    expect(await separation(s)).toBeCloseTo(REFVAL, 4);
    expect(await separation(e)).toBeCloseTo(REFVAL, 4);
    expect(await separation((s + e) / 2)).toBeLessThan(REFVAL);
    if (s - STEP > et0) expect(await separation(s - STEP)).toBeGreaterThan(REFVAL);
  });
});

describe('cspice-wasm gfposc latitudinal latitude vs independent elevation', () => {
  let spice: SpiceEngine;
  let et0: number;
  let et1: number;

  beforeAll(async () => {
    spice = await createSpiceEngine();
    for (const k of ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp']) {
      await spice.furnsh(k, fixture(k));
    }
    et0 = await spice.str2et('2004-07-01T00:00:00');
    et1 = await spice.str2et('2004-07-01T06:00:00');
  });

  // Independent "elevation": the latitude (rad) of the Cassini direction in the
  // Saturn body-fixed frame as seen from Saturn, i.e. asin(z / |r|) of the
  // observer-to-target vector expressed in IAU_SATURN. This is exactly the
  // LATITUDINAL LATITUDE coordinate gfposc roots on (the local-up elevation the
  // az/el-mask constraint will use with a topocentric frame).
  const elevation = async (et: number): Promise<number> => {
    const p = await spice.spkpos('CASSINI', et, 'IAU_SATURN', 'NONE', 'SATURN');
    const r = Math.hypot(p.position.x, p.position.y, p.position.z);
    return Math.asin(p.position.z / r);
  };

  it('finds elevation-above intervals; the relation holds inside, fails outside', async () => {
    // Cassini's latitude in IAU_SATURN climbs to ~0.30 rad then falls below zero
    // across this window, so it crosses 0.2 rad twice (one above interval).
    const REFVAL = 0.2; // rad (about 11.5 degrees) latitude
    const intervals = await spice.gfposc(
      'CASSINI', 'IAU_SATURN', 'NONE', 'SATURN',
      'LATITUDINAL', 'LATITUDE',
      '>', REFVAL, 0, STEP, et0, et1,
    );
    expect(intervals.length).toBeGreaterThan(0);

    let prevStop = et0 - 1;
    for (const [s, e] of intervals) {
      expect(s).toBeGreaterThanOrEqual(et0);
      expect(e).toBeLessThanOrEqual(et1);
      expect(e).toBeGreaterThan(s);
      expect(s).toBeGreaterThan(prevStop);
      prevStop = e;
      expect(await elevation((s + e) / 2)).toBeGreaterThan(REFVAL);
    }
    const edges = [et0, ...intervals.flat(), et1];
    for (let i = 0; i < edges.length; i += 2) {
      const gs = edges[i]!;
      const ge = edges[i + 1]!;
      if (ge - gs < 4 * STEP) continue;
      expect(await elevation((gs + ge) / 2)).toBeLessThanOrEqual(REFVAL);
    }
  });

  it('interval edges are where the elevation crosses the reference value', async () => {
    const REFVAL = 0.2;
    const intervals = await spice.gfposc(
      'CASSINI', 'IAU_SATURN', 'NONE', 'SATURN',
      'LATITUDINAL', 'LATITUDE',
      '>', REFVAL, 0, STEP, et0, et1,
    );
    const [s, e] = intervals[0]!;
    expect(await elevation(s)).toBeCloseTo(REFVAL, 4);
    expect(await elevation(e)).toBeCloseTo(REFVAL, 4);
    expect(await elevation((s + e) / 2)).toBeGreaterThan(REFVAL);
  });
});
