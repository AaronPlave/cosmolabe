// Conformance tests for the heritage adapter: the SpiceInstance-compatible
// surface the Session 4 re-point injects into cosmolabe. Values are checked
// against an independent cspice-wasm oracle over the same kernel bytes, and
// the deliberate gaps (members without WASM exports) fail loudly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceBindings, SpiceError, type SpiceBindings } from 'cspice-wasm';
import { createHeritageSpice, kernelNameFromUrl, SpiceSearchCancelled, type HeritageSpice } from './index.js';

const fixtureBytes = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))),
  );

// The CK trio (clock, frame kernel, C-kernel) is here so `ckcov` has something
// to answer about: coverage of an orientation is only meaningful once a CK and
// the SCLK that dates it are both furnished.
const FIXTURES = [
  'naif0012.tls',
  'pck00011.tpc',
  'de440s-inner-cassini.bsp',
  'cassini-soi.bsp',
  'cassini-demo.tsc',
  'cassini-demo.tf',
  'cassini-demo.bc',
];

describe('@cosmolabe/frames heritage adapter', () => {
  let spice: HeritageSpice;
  let oracle: SpiceBindings;
  let et0: number;

  beforeAll(async () => {
    spice = await createHeritageSpice();
    oracle = await createSpiceBindings();
    for (const name of FIXTURES) {
      const bytes = fixtureBytes(name);
      await spice.furnish({
        type: 'buffer',
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        filename: name,
      });
      oracle.furnsh(name, bytes);
    }
    et0 = spice.str2et('2004-07-01T02:00:00');
  });

  it('answers time conversions like the oracle', () => {
    expect(et0).toBe(oracle.str2et('2004-07-01T02:00:00'));
    expect(spice.utc2et('2004-07-01T02:00:00')).toBe(oracle.utc2et('2004-07-01T02:00:00'));
    expect(spice.et2utc(et0, 'ISOC', 3).startsWith('2004-07-01T02:00:00')).toBe(true);
    expect(spice.timout(et0, 'YYYY-MM-DD HR:MN:SC ::UTC')).toContain('2004-07-01');
    expect(spice.unitim(et0, 'TDB', 'TDB')).toBe(et0);
  });

  it('returns heritage-shaped states identical to the oracle', () => {
    const { state, lightTime } = spice.spkezr('CASSINI', et0, 'J2000', 'NONE', 'SATURN');
    const ref = oracle.spkezr('CASSINI', et0, 'J2000', 'NONE', 'SATURN');
    expect(state).toEqual([
      ref.position.x, ref.position.y, ref.position.z,
      ref.velocity.x, ref.velocity.y, ref.velocity.z,
    ]);
    expect(lightTime).toBe(ref.lightTime);
    const { position } = spice.spkpos('SUN', et0, 'ECLIPJ2000', 'LT+S', 'CASSINI');
    const refP = oracle.spkpos('SUN', et0, 'ECLIPJ2000', 'LT+S', 'CASSINI');
    expect(position).toEqual([refP.position.x, refP.position.y, refP.position.z]);
  });

  it('returns frames and bodies like the oracle', () => {
    expect(spice.pxform('J2000', 'IAU_SATURN', et0)).toEqual([
      ...oracle.pxform('J2000', 'IAU_SATURN', et0),
    ]);
    expect(spice.sxform('J2000', 'ECLIPJ2000', et0)).toEqual([
      ...oracle.sxform('J2000', 'ECLIPJ2000', et0),
    ]);
    expect(spice.bodn2c('SATURN')).toBe(699);
    expect(spice.bodc2n(699)).toBe('SATURN');
    expect(spice.bodn2c('NOSUCHBODY')).toBeNull();
    expect(spice.bodvcd(699, 'RADII').length).toBe(3);
    expect(spice.frmnam(1)).toBe('J2000');
  });

  it('reconstructs spkobj and spkcov from DAF summaries', () => {
    const bodies = spice.spkobj('cassini-soi.bsp');
    expect(bodies).toContain(-82);
    const windows = spice.spkcov(-82);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]!.start).toBeLessThan(et0);
    expect(windows[windows.length - 1]!.end).toBeGreaterThan(et0);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.start).toBeGreaterThan(windows[i - 1]!.end);
    }
  });

  it('reconstructs ckobj and ckcov from CK DAF summaries', () => {
    const CK_ID = -82000;
    expect(spice.ckobj('cassini-demo.bc')).toContain(CK_ID);

    // Ticks are what the descriptor holds; ET is the default, and the two must
    // describe the same interval through the demo clock.
    const ticks = spice.ckcov(CK_ID, { timeSystem: 'SCLK' });
    const windows = spice.ckcov(CK_ID);
    expect(ticks.length).toBeGreaterThan(0);
    expect(windows.length).toBe(ticks.length);
    for (let i = 0; i < windows.length; i++) {
      expect(windows[i]!.start).toBeCloseTo(oracle.sct2e(-82, ticks[i]!.start), 6);
      expect(windows[i]!.end).toBeCloseTo(oracle.sct2e(-82, ticks[i]!.end), 6);
      expect(windows[i]!.end).toBeGreaterThan(windows[i]!.start);
    }

    // The window is the real one: ckgp answers inside it and not outside.
    const inside = (windows[0]!.start + windows[0]!.end) / 2;
    expect(oracle.ckgp(CK_ID, oracle.sce2c(-82, inside), 0, 'J2000').found).toBe(true);
    const outside = windows[windows.length - 1]!.end + 86400;
    expect(oracle.ckgp(CK_ID, oracle.sce2c(-82, outside), 0, 'J2000').found).toBe(false);

    // Interval level is CSPICE's, not an approximation of it: it reports the
    // interpolation intervals inside each segment, so it can only be a subset
    // of the segment span.
    const intervals = spice.ckcov(CK_ID, { level: 'INTERVAL' });
    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals[0]!.start).toBeGreaterThanOrEqual(windows[0]!.start);
    expect(intervals[intervals.length - 1]!.end).toBeLessThanOrEqual(
      windows[windows.length - 1]!.end,
    );

    // An id no CK carries is empty coverage, not an error.
    expect(spice.ckcov(-99000)).toEqual([]);
    // A bad time system is an error, not an empty window that reads like
    // "no attitude here".
    expect(() => spice.ckcov(CK_ID, { timeSystem: 'NOPE' as never })).toThrow(SpiceError);
    expect(() => spice.ckcov(CK_ID, { level: 'NOPE' as never })).toThrow(SpiceError);
  });

  it('computes sub-points with heritage lat, lon, and altitude semantics', () => {
    const sub = spice.subpnt('NEAR POINT/ELLIPSOID', 'SATURN', et0, 'IAU_SATURN', 'NONE', 'CASSINI');
    const p = sub.point;
    expect(sub.latitude).toBeCloseTo(Math.atan2(p[2], Math.hypot(p[0], p[1])), 12);
    expect(sub.longitude).toBeCloseTo(Math.atan2(p[1], p[0]), 12);
    expect(sub.altitude).toBeGreaterThan(0);
    const slr = spice.subslr('NEAR POINT/ELLIPSOID', 'SATURN', et0, 'IAU_SATURN', 'NONE', 'CASSINI');
    expect(Math.abs(slr.longitude - sub.longitude)).toBeGreaterThan(0); // distinct points
  });

  it('drives the geometry finders over a cnfine window list', () => {
    const windows = spice.gfdist('SUN', 'NONE', 'CASSINI', '<', 2.0e9, 0, 3600, [
      { start: et0, end: et0 + 4 * 3600 },
    ]);
    expect(windows.length).toBe(1);
    expect(windows[0]!.start).toBeCloseTo(et0, 3);
    expect(windows[0]!.end).toBeCloseTo(et0 + 4 * 3600, 3);
    expect(() =>
      spice.gfdist('SUN', 'NONE', 'CASSINI', 'ABSMIN', 0, 1, 3600, [{ start: et0, end: et0 + 60 }]),
    ).toThrow(SpiceError);
  });

  it('matches SPICE vector math semantics', () => {
    expect(spice.vsep([1, 0, 0], [0, 2, 0])).toBeCloseTo(Math.PI / 2, 14);
    expect(spice.vcrss([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(spice.vhat([3, 0, 4])).toEqual([0.6, 0, 0.8]);
    expect(spice.mxv([1, 0, 0, 0, 0, 1, 0, -1, 0], [0, 0, 2])).toEqual([0, 2, 0]);
    expect(spice.mtxv([1, 0, 0, 0, 0, 1, 0, -1, 0], [0, 2, 0])).toEqual([0, 0, 2]);
    const rr = spice.recrad([0, 1, 0]);
    expect(rr.ra).toBeCloseTo(Math.PI / 2, 14);
    expect(rr.dec).toBeCloseTo(0, 14);
  });

  it('exposes the frames tier beneath it for provenance', () => {
    const info = spice.frames.kernels();
    expect(info.count).toBe(FIXTURES.length);
    expect(info.setHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails loudly on the deliberate allowlist gaps and file sources', async () => {
    expect(() => spice.cidfrm(699)).toThrow(SpiceError);
    expect(() =>
      spice.fovray('X', [1, 0, 0], 'J2000', 'NONE', 'CASSINI', et0),
    ).toThrow(SpiceError);
    await expect(spice.furnish({ type: 'file', path: '/nope.bsp' })).rejects.toThrow(SpiceError);
  });

  it('clear() empties the pool and the provenance list', async () => {
    const scratch = await createHeritageSpice();
    await scratch.furnish({
      type: 'buffer',
      data: fixtureBytes('naif0012.tls').buffer,
      filename: 'naif0012.tls',
    });
    expect(scratch.totalLoaded()).toBe(1);
    scratch.clear();
    expect(scratch.totalLoaded()).toBe(0);
    expect(scratch.frames.kernels().count).toBe(0);
  });

  // ── the charter, pinned one row at a time ─────────────────────────────────
  // Every semantic choice enumerated in the heritage-spice.ts charter doc
  // block has exactly one test here. A change to any of these is a change to
  // measured heritage behavior and belongs in a reviewed migration, never in
  // a refactor.

  describe('charter: correction handling', () => {
    it('passes every heritage correction verbatim, including the transmission set', () => {
      const corrections = [
        'NONE', 'LT', 'LT+S', 'CN', 'CN+S', 'XLT', 'XLT+S', 'XCN', 'XCN+S',
      ] as const;
      for (const abcorr of corrections) {
        const a = spice.spkezr('CASSINI', et0, 'J2000', abcorr, 'SATURN');
        const r = oracle.spkezr('CASSINI', et0, 'J2000', abcorr, 'SATURN');
        expect(a.state[0]).toBe(r.position.x);
        expect(a.lightTime).toBe(r.lightTime);
        const p = spice.spkpos('CASSINI', et0, 'J2000', abcorr, 'SATURN');
        expect(p.position[0]).toBe(oracle.spkpos('CASSINI', et0, 'J2000', abcorr, 'SATURN').position.x);
      }
    });
  });

  describe('charter: frame handling', () => {
    it('passes frame strings verbatim with no default frame of its own', () => {
      for (const frame of ['J2000', 'ECLIPJ2000', 'IAU_SATURN']) {
        const a = spice.spkezr('CASSINI', et0, frame, 'NONE', 'SATURN');
        const r = oracle.spkezr('CASSINI', et0, frame, 'NONE', 'SATURN');
        expect(a.state).toEqual([
          r.position.x, r.position.y, r.position.z,
          r.velocity.x, r.velocity.y, r.velocity.z,
        ]);
      }
    });
  });

  describe('charter: epoch parsing', () => {
    it('str2et reads an ISO instant as UTC explicitly, Z or not (issue #8)', () => {
      // The Z-strip is retired: the adapter now hands CSPICE the calendar form
      // with the system token spelled out. Value-identical to the bare ISO form
      // heritage produced, and the designator is no longer load-bearing.
      const bare = oracle.str2et('2004-07-01 02:00:00 UTC');
      expect(spice.str2et('2004-07-01T02:00:00Z')).toBe(bare);
      expect(spice.str2et('2004-07-01T02:00:00')).toBe(bare);
      expect(bare).toBe(oracle.str2et('2004-07-01T02:00:00'));
    });
    it('str2et resolves an ISO offset that heritage rejected outright', () => {
      expect(spice.str2et('2004-07-01T04:00:00+02:00')).toBe(
        oracle.str2et('2004-07-01 02:00:00 UTC'),
      );
      // Heritage stripped only a trailing Z, so str2et_c saw the offset and
      // threw SPICE(UNPARSEDTIME) two frames below the caller.
      expect(() => oracle.str2et('2004-07-01T04:00:00+02:00')).toThrow(SpiceError);
    });
    it('str2et passes non-ISO forms through verbatim, including a system token', () => {
      for (const s of ['2004 JUL 01 02:00:00', '2004-183 // 02:00:00', 'JD 2453187.5']) {
        expect(spice.str2et(s), s).toBe(oracle.str2et(s));
      }
      // What OemAdapter.oemEpochToEt builds for a TDB file: the calendar form
      // with an explicit system. Normalisation must not touch it.
      expect(spice.str2et('1996-12-18 12:00:00.331 TDB')).toBe(
        oracle.str2et('1996-12-18 12:00:00.331 TDB'),
      );
    });
    it('utc2et passes verbatim, so a trailing Z fails loudly as heritage does', () => {
      expect(spice.utc2et('2004-07-01T02:00:00')).toBe(oracle.utc2et('2004-07-01T02:00:00'));
      expect(() => spice.utc2et('2004-07-01T02:00:00Z')).toThrow(SpiceError);
    });
  });

  describe('charter: window semantics', () => {
    it('searches each cnfine window independently and concatenates in order', () => {
      const w1 = { start: et0, end: et0 + 3600 };
      const w2 = { start: et0 + 7200, end: et0 + 10800 };
      const windows = spice.gfdist('SUN', 'NONE', 'CASSINI', '<', 2.0e9, 0, 1800, [w1, w2]);
      expect(windows.length).toBe(2);
      expect(windows[0]!.start).toBeCloseTo(w1.start, 3);
      expect(windows[0]!.end).toBeCloseTo(w1.end, 3);
      expect(windows[1]!.start).toBeCloseTo(w2.start, 3);
      expect(windows[1]!.end).toBeCloseTo(w2.end, 3);
    });
  });

  describe('reporting geometry searches', () => {
    // A report moves the call onto CSPICE's general GF entry points. What the
    // adapter adds on top of them is the confinement window: it runs the finder
    // once per interval, so the per-call fraction each one reports has to be
    // rescaled into the window as a whole before a caller can draw a bar with it.

    const WINDOW = () => {
      const start = spice.str2et('2004-07-01T00:00:00');
      return [
        { start, end: start + 3 * 3600 },
        { start: start + 3 * 3600, end: start + 6 * 3600 },
      ];
    };

    it('returns the same windows with a report as without one', () => {
      const cnfine = WINDOW();
      const plain = spice.gfdist('SATURN', 'NONE', '-82', '<', 1.5e6, 0, 300, cnfine);
      const reported = spice.gfdist('SATURN', 'NONE', '-82', '<', 1.5e6, 0, 300, cnfine, {
        onProgress: () => {},
      });
      expect(reported).toEqual(plain);
      expect(plain.length).toBeGreaterThan(0);
    });

    it('reports one 0..1 sweep across a multi-interval confinement window', () => {
      const seen: number[] = [];
      spice.gfdist('SATURN', 'NONE', '-82', '<', 1.5e6, 0, 300, WINDOW(), {
        onProgress: (fraction) => seen.push(fraction),
      });

      // Two intervals, two CSPICE calls, each reporting 0..1 of *its* interval.
      // Unscaled, a caller would see the bar cross twice.
      expect(seen.length).toBeGreaterThan(0);
      for (const f of seen) {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
      expect(Math.max(...seen)).toBe(1);
      // The first interval is the first half of the window, so nothing it
      // reports may claim more than half of the search is done.
      expect(seen.filter((f) => f === 1)).toHaveLength(1);
      expect(seen.indexOf(0.5)).toBeGreaterThanOrEqual(0);
    });

    it('stops an executing search when the bail-out handler says to', () => {
      expect(() =>
        spice.gfdist('SATURN', 'NONE', '-82', '<', 1.5e6, 0, 300, WINDOW(), {
          shouldBail: () => true,
        }),
      ).toThrow(SpiceSearchCancelled);

      // And the adapter is still usable: a cancelled search that left CSPICE
      // mid-state would poison every search after it.
      expect(spice.gfdist('SATURN', 'NONE', '-82', '<', 1.5e6, 0, 300, WINDOW()).length)
        .toBeGreaterThan(0);
    });
  });

  describe('charter: instrument geometry', () => {
    it('getfov defaults maxBounds to 20, as heritage does', async () => {
      const NAC = -82360;
      const ik = fixtureBytes('cas_iss_v10.ti');
      await spice.furnish({
        type: 'buffer',
        data: ik.buffer.slice(ik.byteOffset, ik.byteOffset + ik.byteLength),
        filename: 'cas_iss_v10.ti',
      });
      oracle.furnsh('cas_iss_v10.ti', ik);
      const fov = spice.getfov(NAC);
      const ref = oracle.getfov(NAC, 20);
      expect(fov.shape).toBe(ref.shape);
      expect(fov.frame).toBe(ref.frame);
      expect(fov.boresight).toEqual([ref.boresight.x, ref.boresight.y, ref.boresight.z]);
      expect(fov.bounds.length).toBe(ref.bounds.length);
    });
  });
});

/**
 * The name a URL-furnished kernel gets.
 *
 * Exported because three layers have to agree on it -- this adapter, the
 * viewer's registry of what is furnished, and the cache worker -- and a
 * disagreement shows up only as an unload that unloads nothing, or a worker
 * holding a kernel its host cannot name.
 */
describe('kernelNameFromUrl', () => {
  it('is the basename', () => {
    expect(kernelNameFromUrl('https://example.test/kernels/de440s.bsp')).toBe('de440s.bsp');
  });

  it('drops .gz, which CSPICE would not recognise a kernel type through', () => {
    expect(kernelNameFromUrl('https://example.test/de440s.bsp.gz')).toBe('de440s.bsp');
  });

  it('drops a query string and fragment', () => {
    // A signed URL is the same kernel as the bare one. Furnishing it under a
    // name carrying the token would make the name neither stable across a
    // re-signing nor the one anything else would think to unload.
    expect(kernelNameFromUrl('https://example.test/de440s.bsp?X-Amz-Signature=abc')).toBe('de440s.bsp');
    expect(kernelNameFromUrl('https://example.test/de440s.bsp.gz?v=2#part')).toBe('de440s.bsp');
  });

  it('handles a relative path, which a catalog may well give', () => {
    expect(kernelNameFromUrl('./kernels/naif0012.tls')).toBe('naif0012.tls');
    expect(kernelNameFromUrl('naif0012.tls')).toBe('naif0012.tls');
  });
});
