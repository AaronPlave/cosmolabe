// Validates the SpiceCell window marshaller and the gfoclt occultation interval
// finder against the independent per-epoch occult routine (the NAIF reference for
// the same triaxial-ellipsoid model). Geometry: the Sun occulted by Saturn as seen
// from Cassini near Saturn Orbit Insertion. (STK_PARITY_SPEC F1/F2, Phase A.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, type SpiceEngine } from './index.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

const CASSINI = '-82';
const STEP = 120; // seconds; shorter than the shadow ingress/egress events

describe('cspice-wasm gfoclt occultation vs occult', () => {
  let spice: SpiceEngine;
  let et0: number;
  let et1: number;
  let intervals: [number, number][];

  // Sun occulted by Saturn from Cassini. occult requires a non-blank frame even for
  // a POINT target (where it is unused), so J2000 is passed for the Sun point.
  const eclipse = (et: number) =>
    spice.occult('SUN', 'POINT', 'J2000', 'SATURN', 'ELLIPSOID', 'IAU_SATURN', 'NONE', CASSINI, et);

  beforeAll(async () => {
    spice = await createSpiceEngine();
    for (const k of [
      'naif0012.tls',
      'pck00011.tpc',
      'de440s-inner-cassini.bsp',
      'cassini-soi.bsp',
    ]) {
      await spice.furnsh(k, fixture(k));
    }
    et0 = await spice.str2et('2004-07-01T00:00:00');
    et1 = await spice.str2et('2004-07-01T06:00:00');
    intervals = await spice.gfoclt(
      'ANY',
      'SATURN',
      'ELLIPSOID',
      'IAU_SATURN',
      'SUN',
      'POINT',
      '',
      'NONE',
      CASSINI,
      STEP,
      et0,
      et1,
    );
  });

  it('finds at least one occultation interval, ordered within the window', () => {
    expect(intervals.length).toBeGreaterThan(0);
    let prevStop = et0 - 1;
    for (const [s, e] of intervals) {
      expect(s).toBeGreaterThanOrEqual(et0);
      expect(e).toBeLessThanOrEqual(et1);
      expect(e).toBeGreaterThan(s); // non-degenerate
      expect(s).toBeGreaterThan(prevStop); // sorted and disjoint
      prevStop = e;
    }
  });

  it('occult confirms the Sun is occulted inside every interval midpoint', async () => {
    for (const [s, e] of intervals) {
      const code = await eclipse((s + e) / 2);
      // Sun (target 1, POINT) behind Saturn (target 2) => negative code.
      expect(code).toBeLessThan(0);
    }
  });

  it('occult confirms no occultation in the gaps between intervals', async () => {
    // Build gap midpoints from the window complement; skip gaps too short to
    // sample clear of the boundaries.
    const edges = [et0, ...intervals.flat(), et1];
    for (let i = 0; i < edges.length; i += 2) {
      const gs = edges[i]!;
      const ge = edges[i + 1]!;
      if (ge - gs < 4 * STEP) continue;
      const code = await eclipse((gs + ge) / 2);
      expect(code).toBe(0);
    }
  });

  it('the interval boundary is where occult flips (validates the found time)', async () => {
    const [s, e] = intervals[0]!;
    // A minute inside the interval the Sun is occulted; a minute before the start
    // (in the preceding gap) it is not.
    expect(await eclipse(s + 60)).toBeLessThan(0);
    expect(await eclipse(e - 60)).toBeLessThan(0);
    if (s - 60 > et0) expect(await eclipse(s - 60)).toBe(0);
  });
});
