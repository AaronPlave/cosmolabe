// The general GF entry points against the simplified wrappers they replace.
//
// gfdist_c, gfsep_c, gfposc_c and gfoclt_c are thin layers over gfevnt_c and
// gfocce_c: they build the same parameter arrays, set the same step size and
// tolerance, and then hand the search over with progress reporting and bail-out
// switched off. native/gf-report.c reproduces that setup and switches both on.
//
// So the two tiers *should* return the same windows. This file is what makes
// that a checked claim: every search below runs both ways over the same kernels
// and the windows must agree interval for interval, endpoint for endpoint. A
// determinate progress bar and a search that can actually be stopped are not
// worth having if they come with different answers.
//
// Also covered here, because they are the reason for moving tiers at all: that
// progress is reported while the search runs, and that a bail-out handler
// asking the search to stop actually stops it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceBindings } from './engine.js';
import type { GfReport, SpiceBindings } from './bindings.js';
import { SpiceSearchCancelled } from './index.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

const CASSINI = '-82';
const STEP = 300; // seconds

/** No reporting and no interruption: the general path, run like the simple one. */
const SILENT = {};

describe('general GF entry points vs the simplified wrappers', () => {
  let spice: SpiceBindings;
  let et0: number;
  let et1: number;

  beforeAll(async () => {
    spice = await createSpiceBindings();
    for (const k of ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp']) {
      spice.furnsh(k, fixture(k));
    }
    et0 = spice.str2et('2004-07-01T00:00:00');
    et1 = spice.str2et('2004-07-01T06:00:00');
  });

  /**
   * Interval-for-interval equality.
   *
   * Exact, not approximate. Both tiers run the same solver with the same
   * convergence tolerance over the same kernels, so the endpoints are the same
   * doubles; a tolerance here would hide precisely the divergence this file
   * exists to catch.
   */
  const same = (general: [number, number][], simple: [number, number][]): void => {
    expect(general).toEqual(simple);
    // Guards the comparison itself: two empty windows agree trivially, which
    // would make a broken general entry point look correct.
    expect(simple.length).toBeGreaterThan(0);
  };

  it('gfdist: the same distance-below window', () => {
    // Cassini's range to Saturn falls through 1.5e6 km during SOI approach.
    const args = ['SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1] as const;
    same(
      spice.gfdistReporting(...args, SILENT),
      spice.gfdist(...args),
    );
  });

  it('gfdist: the same window for a local-minimum search', () => {
    // ABSMIN/LOCMIN take a different path through the solver than a relational
    // search does, so "same answers" has to be shown for both.
    const args = ['SATURN', 'NONE', CASSINI, 'ABSMIN', 0, STEP, et0, et1] as const;
    same(
      spice.gfdistReporting(...args, SILENT),
      spice.gfdist(...args),
    );
  });

  it('gfsep: the same angular-separation window', () => {
    const args = [
      'SUN', 'POINT', 'J2000',
      'SATURN', 'POINT', 'J2000',
      'NONE', CASSINI,
      '<', 0.5, 0, STEP, et0, et1,
    ] as const;
    same(
      spice.gfsepReporting(...args, SILENT),
      spice.gfsep(...args),
    );
  });

  it('gfposc: the same coordinate window', () => {
    // Declination of Saturn as seen from Cassini, in RA/DEC on J2000.
    const args = [
      'SATURN', 'J2000', 'NONE', CASSINI,
      'RA/DEC', 'DECLINATION', '>', 0, 0, STEP, et0, et1,
    ] as const;
    same(
      spice.gfposcReporting(...args, SILENT),
      spice.gfposc(...args),
    );
  });

  it('gfoclt: the same occultation window', () => {
    const args = [
      'ANY',
      'SATURN', 'ELLIPSOID', 'IAU_SATURN',
      'SUN', 'ELLIPSOID', 'IAU_SUN',
      'NONE', CASSINI,
      STEP, et0, et1,
    ] as const;
    same(
      spice.gfocltReporting(...args, SILENT),
      spice.gfoclt(...args),
    );
  });

  it('reports progress from inside the running search', () => {
    const seen: { fraction: number; pass: number }[] = [];
    const intervals = spice.gfdistReporting(
      'SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1,
      { onProgress: (fraction, pass) => seen.push({ fraction, pass }) },
    );

    expect(intervals).toEqual(spice.gfdist('SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1));
    // The reporter fires when a pass starts whatever the search costs, and the
    // binding reports the closing 1.0, so those are guaranteed; the updates in
    // between are throttled by wall clock and a fixture-sized search outruns
    // them.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toEqual({ fraction: 0, pass: 1 });

    for (const { fraction, pass } of seen) {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
      expect(pass).toBeGreaterThanOrEqual(1);
    }
    // Passes only ever advance, and within one pass the fraction never goes
    // backwards -- a bar that regresses mid-pass is worse than no bar.
    for (let i = 1; i < seen.length; i++) {
      const prev = seen[i - 1]!;
      const here = seen[i]!;
      expect(here.pass).toBeGreaterThanOrEqual(prev.pass);
      if (here.pass === prev.pass) expect(here.fraction).toBeGreaterThanOrEqual(prev.fraction);
    }

    // Exactly one report says the call is finished, and it is the last one: a
    // 1.0 at the end of every pass would complete the bar and then restart it.
    expect(seen.filter((p) => p.fraction === 1)).toHaveLength(1);
    expect(seen[seen.length - 1]!.fraction).toBe(1);
  });

  it('stops the executing search when the bail-out handler says to', () => {
    expect(() =>
      spice.gfdistReporting(
        'SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1,
        { shouldBail: () => true },
      ),
    ).toThrow(SpiceSearchCancelled);
  });

  it('abandons the work, not just the answer', () => {
    // The point of the bail-out handler, and the reason the general entry
    // points are worth reaching for at all. Throwing proves the caller was told;
    // it does not prove CSPICE stopped. A search big enough to take real time
    // does: run it to completion, then run it again and stop it at the first
    // poll, and compare what each cost.
    const long0 = spice.str2et('2004-07-01T00:00:00');
    const long1 = spice.str2et('2004-07-05T00:00:00');
    const occultation = (report: GfReport) =>
      spice.gfocltReporting(
        'ANY', 'SATURN', 'ELLIPSOID', 'IAU_SATURN', 'SUN', 'ELLIPSOID', 'IAU_SUN',
        'NONE', CASSINI, 10, long0, long1, report,
      );

    let fullPolls = 0;
    const started = performance.now();
    occultation({ shouldBail: () => { fullPolls += 1; return false; } });
    const fullMs = performance.now() - started;

    let bailedPolls = 0;
    const interrupted = performance.now();
    expect(() => occultation({ shouldBail: () => { bailedPolls += 1; return true; } }))
      .toThrow(SpiceSearchCancelled);
    const bailedMs = performance.now() - interrupted;

    // One poll: the search gave up the first time it asked, rather than running
    // on and being discarded at the end.
    expect(bailedPolls).toBe(1);
    // The uninterrupted search polls repeatedly, so the handler is reached from
    // inside the search and not once on the way in.
    expect(fullPolls).toBeGreaterThan(1);
    // Measured at roughly 374 ms against 0.3 ms; a tenth is slack enough for a
    // loaded CI runner while still failing if the search ran to completion.
    expect(bailedMs).toBeLessThan(fullMs / 10);
  });

  it('runs to completion when the bail-out handler says not to', () => {
    // The bail-out path must not cost the answer when nobody asked to stop.
    const polled: boolean[] = [];
    const intervals = spice.gfdistReporting(
      'SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1,
      { shouldBail: () => { polled.push(false); return false; } },
    );
    expect(intervals).toEqual(spice.gfdist('SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1));
  });

  it('leaves the engine usable after a bail-out', () => {
    // A cancelled search that left CSPICE mid-state would poison every search
    // after it, which on the worker path is every search in the session.
    expect(() =>
      spice.gfdistReporting(
        'SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1,
        { shouldBail: () => true },
      ),
    ).toThrow(SpiceSearchCancelled);

    const args = ['SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1] as const;
    same(spice.gfdistReporting(...args, SILENT), spice.gfdist(...args));
  });

  it('surfaces a SPICE failure as a typed error, like the simplified call', () => {
    expect(() =>
      spice.gfdistReporting('NOSUCHBODY', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1, SILENT),
    ).toThrow(/NOSUCHBODY|SPICE/);
  });

  it('re-throws a reporter that throws, rather than burying it', () => {
    const boom = new Error('reporter exploded');
    expect(() =>
      spice.gfdistReporting(
        'SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, et0, et1,
        { onProgress: () => { throw boom; } },
      ),
    ).toThrow(boom);
  });
});
