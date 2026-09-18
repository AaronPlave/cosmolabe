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
import { gfPassCount } from './bindings.js';
import type { GfReport, SpiceBindings } from './bindings.js';
import { createSpiceWorkerClient, SpiceError, SpiceSearchCancelled } from './index.js';
import { installSpiceWorker, type SpiceWorkerScope } from './worker-core.js';
import type { SpiceWorkerRequest, SpiceWorkerResponse } from './protocol.js';

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
    // Monotonic across the whole call, not merely within a pass. "<" is a
    // two-pass search and CSPICE restarts its reporter at the second, so this
    // only holds because the binding maps each pass into its own slice.
    for (let i = 1; i < seen.length; i++) {
      const prev = seen[i - 1]!;
      const here = seen[i]!;
      expect(here.pass).toBeGreaterThanOrEqual(prev.pass);
      expect(here.fraction).toBeGreaterThanOrEqual(prev.fraction);
    }

    // Both passes are visible, and the second one *starts at the boundary*.
    // This is the assertion that pins the slicing: CSPICE reports 0.0 at the
    // head of every pass, so a binding that forwarded the raw fraction (even
    // clamped to a running maximum, which would still satisfy the monotonicity
    // check above) would report 0 here instead of 0.5.
    const pass2 = seen.find((p) => p.pass === 2);
    expect(pass2).toBeDefined();
    expect(pass2!.fraction).toBe(0.5);

    // Exactly one report says the call is finished, and it is the last one: a
    // 1.0 at the end of every pass would complete the bar and then restart it.
    expect(seen.filter((p) => p.fraction === 1)).toHaveLength(1);
    expect(seen[seen.length - 1]!.fraction).toBe(1);
  });

  it('keeps the first pass inside the first half while it runs', () => {
    // The test above only sees the reports CSPICE makes at the head of each
    // pass, because a six-hour window outruns the reporter's 100 ms throttle.
    // This one searches four days at a ten-second step -- long enough that the
    // throttle actually fires mid-pass -- so there is a fraction from *inside*
    // pass 1 to check, which is where a wrong slice width would show up.
    const long1 = et0 + 4 * 86_400;
    const seen: { fraction: number; pass: number }[] = [];
    spice.gfdistReporting(
      'SATURN', 'NONE', CASSINI, '<', 1.5e6, 10, et0, long1,
      { onProgress: (fraction, pass) => seen.push({ fraction, pass }) },
    );

    const midPass1 = seen.filter((p) => p.pass === 1 && p.fraction > 0);
    expect(midPass1.length).toBeGreaterThan(0);
    for (const { fraction } of midPass1) expect(fraction).toBeLessThan(0.5);
  });

  it('spans the whole bar in one pass when the search only takes one', () => {
    // LOCMIN is a one-pass search, so there is no slicing to do and the raw
    // fraction is already the call's. Pinned because the slice width comes from
    // gfPassCount: get the count wrong here and the bar would stop at 50%.
    const seen: { fraction: number; pass: number }[] = [];
    spice.gfdistReporting(
      'SATURN', 'NONE', CASSINI, 'LOCMIN', 0, STEP, et0, et1,
      { onProgress: (fraction, pass) => seen.push({ fraction, pass }) },
    );

    expect(seen.every((p) => p.pass === 1)).toBe(true);
    expect(seen[0]!.fraction).toBe(0);
    expect(seen[seen.length - 1]!.fraction).toBe(1);
  });

  it('runs an occultation search as a single pass', () => {
    // gfocce_c has one reporter block, unlike the relational entry points, so
    // its progress needs no slicing at all.
    const seen: number[] = [];
    spice.gfocltReporting(
      'ANY', 'SATURN', 'ELLIPSOID', 'IAU_SATURN', 'SUN', 'ELLIPSOID', 'IAU_SUN',
      'NONE', CASSINI, STEP, et0, et1,
      { onProgress: (_fraction, pass) => seen.push(pass) },
    );

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen)).toEqual(new Set([1]));
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

/**
 * The worker protocol end of the same thing.
 *
 * `cancelFlag` only means anything across a thread boundary -- its whole reason
 * for being shared memory is that a worker blocked in a synchronous CSPICE call
 * cannot be reached any other way -- so the path that has to work is the one
 * through `createSpiceWorkerClient`, not the in-process one above. Two things
 * can go wrong there and cannot go wrong in-process: the flag can fail to reach
 * the search, and the error can lose its type on the way back. An interrupted
 * search that rejects with a bare SpiceError is indistinguishable from one that
 * failed, which is exactly the distinction cancellation exists to make.
 */
function fakeWorker(): Worker {
  const listeners = new Set<(ev: MessageEvent<SpiceWorkerResponse>) => void>();
  const scope: SpiceWorkerScope = {
    onmessage: null,
    // Asynchronous in both directions, as a real worker is.
    postMessage: (res) => {
      setTimeout(() => {
        const ev = { data: res } as MessageEvent<SpiceWorkerResponse>;
        for (const l of listeners) l(ev);
      }, 0);
    },
  };
  installSpiceWorker(scope);
  return {
    postMessage: (msg: unknown) =>
      setTimeout(
        () => scope.onmessage?.({ data: msg as SpiceWorkerRequest } as MessageEvent<SpiceWorkerRequest>),
        0,
      ),
    addEventListener: (_t: 'message', h: (ev: MessageEvent<SpiceWorkerResponse>) => void) => listeners.add(h),
    removeEventListener: (_t: 'message', h: (ev: MessageEvent<SpiceWorkerResponse>) => void) => listeners.delete(h),
    terminate: () => listeners.clear(),
  } as unknown as Worker;
}

describe('reporting searches across the worker protocol', () => {
  const engine = createSpiceWorkerClient(fakeWorker());
  let wet0: number;
  let wet1: number;

  beforeAll(async () => {
    for (const k of ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp']) {
      await engine.furnsh(k, fixture(k));
    }
    wet0 = await engine.str2et('2004-07-01T00:00:00');
    wet1 = await engine.str2et('2004-07-01T06:00:00');
  });

  it('carries progress back over the protocol', async () => {
    const seen: { fraction: number; pass: number }[] = [];
    const intervals = await engine.gfdist('SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, wet0, wet1, {
      onProgress: (fraction, pass) => seen.push({ fraction, pass }),
    });

    expect(intervals).toEqual(await engine.gfdist('SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, wet0, wet1));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toEqual({ fraction: 0, pass: 1 });
    expect(seen[seen.length - 1]!.fraction).toBe(1);
  });

  it('reads the shared cancellation flag and rejects with SpiceSearchCancelled', async () => {
    const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(cancelFlag, 0, 1);

    const pending = engine.gfdist('SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, wet0, wet1, { cancelFlag });

    // The type, not just the message. A caller branches on this to decide
    // whether to show a fault, and SpiceError would send it down the wrong path.
    await expect(pending).rejects.toBeInstanceOf(SpiceSearchCancelled);
  });

  it('still reports a genuine SPICE failure as a SpiceError', async () => {
    // The discriminator must not turn every failure into a cancellation.
    const pending = engine.gfdist('NOSUCHBODY', 'NONE', CASSINI, '<', 1.5e6, STEP, wet0, wet1, {
      cancelFlag: new Int32Array(new SharedArrayBuffer(4)),
    });
    await expect(pending).rejects.toBeInstanceOf(SpiceError);
    await expect(pending).rejects.not.toBeInstanceOf(SpiceSearchCancelled);
  });

  it('leaves the worker usable for the next search', async () => {
    // A cancelled search must free the worker, not poison it -- the whole point
    // of interrupting one is that the next search does not queue behind it.
    const intervals = await engine.gfdist('SATURN', 'NONE', CASSINI, '<', 1.5e6, STEP, wet0, wet1);
    expect(intervals.length).toBeGreaterThan(0);
  });
});

/**
 * The pass count the slicing depends on.
 *
 * This is not a guess about CSPICE's behaviour: `gfevnt.c` computes exactly the
 * same thing for its own progress prefixes, in the `npass` assignment quoted in
 * gfPassCount's doc comment. Pinning it here is what makes a CSPICE bump that
 * changes the rule show up as a failing test rather than as a progress bar that
 * silently stops at 50% -- which the reporting tests above would not catch,
 * since a stalled bar is still a monotonic one.
 */
describe('gfPassCount', () => {
  it('gives one pass to a local extremum', () => {
    // Local extrema never need a second sweep, adjusted or not.
    expect(gfPassCount('LOCMIN', 0)).toBe(1);
    expect(gfPassCount('LOCMAX', 0)).toBe(1);
    expect(gfPassCount('LOCMIN', 1e5)).toBe(1);
  });

  it('gives one pass to an unadjusted absolute extremum', () => {
    expect(gfPassCount('ABSMIN', 0)).toBe(1);
    expect(gfPassCount('ABSMAX', 0)).toBe(1);
  });

  it('gives two passes to an adjusted absolute extremum', () => {
    // A nonzero adjustment turns the search into "find the extremum, then find
    // where the quantity is within the adjustment of it" -- a second sweep.
    expect(gfPassCount('ABSMIN', 1e5)).toBe(2);
    expect(gfPassCount('ABSMAX', 1e5)).toBe(2);
  });

  it('gives two passes to every relational operator', () => {
    for (const op of ['<', '>', '=']) expect(gfPassCount(op, 0)).toBe(2);
  });

  it('reads the operator the way CSPICE does', () => {
    // gfevnt left-justifies and upper-cases before comparing, so a caller that
    // passes "locmin" gets a one-pass search and must be sliced as one.
    expect(gfPassCount('locmin', 0)).toBe(1);
    expect(gfPassCount('  ABSMIN  ', 0)).toBe(1);
  });
});
