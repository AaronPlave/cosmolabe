// CK coverage (ckcov_c / ckobj_c) through the export allowlist.
//
// The case this file exists for: a CK structure whose spacecraft clock is NOT
// its id divided by 1000. CSPICE resolves the clock with ckmeta_c, which reads
// a `CK_<id>_SCLK` assignment from the kernel pool and only falls back to
// id / 1000 when there is none. Any reimplementation that assumes the fallback
// converts this CK's coverage through a clock that does not exist, and a
// reimplementation that assumed it and got away with it on well-behaved
// kernels would report a plausible but wrong ET window here.
//
// The CK is written by CSPICE itself (ckw03) rather than committed, so the
// bytes come from SPICE and the fixture cannot drift from the reader.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceBindings, SpiceError, type SpiceBindings } from './index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// cassini-demo.tsc carries a synthetic clock for -82. The CK structure id is
// -150000, so the id/1000 fallback would name clock -150, which no kernel
// defines — the pool assignment below is the only thing that resolves.
const CLOCK = -82;
const CKID = -150000;
const WRONG_CLOCK = Math.trunc(CKID / 1000); // -150

const FK = `\\begindata
CK_${CKID}_SCLK = ${CLOCK}
CK_${CKID}_SPK  = ${CLOCK}
\\begintext
`;

describe('ckcov/ckobj over the CSPICE export allowlist', () => {
  let spice: SpiceBindings;
  let ticks: number[];

  beforeAll(async () => {
    spice = await createSpiceBindings();
    spice.furnsh('naif0012.tls', fixture('naif0012.tls'));
    spice.furnsh('cassini-demo.tsc', fixture('cassini-demo.tsc'));
    spice.furnsh('odd-clock.tf', utf8(FK));

    const et0 = spice.str2et('2004-07-01T00:00:00');
    const ets = [et0, et0 + 60, et0 + 120];
    ticks = ets.map((et) => spice.sce2c(CLOCK, et));
    const quats = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    spice.writeCk03(
      'odd-clock.bc', CKID, 'J2000', 'ODD_CLOCK',
      new Float64Array(ticks), quats, null, new Float64Array([ticks[0]!]),
    );
  });

  it('ckobj reports the structure the CK carries', () => {
    expect(spice.ckObjects('odd-clock.bc')).toEqual([CKID]);
  });

  it('converts TDB through the pool-assigned clock, not id / 1000', () => {
    // The fallback clock is genuinely unusable here, which is what makes this
    // a real discriminator rather than a coincidence of rounding.
    expect(WRONG_CLOCK).not.toBe(CLOCK);
    expect(() => spice.sct2e(WRONG_CLOCK, ticks[0]!)).toThrow(SpiceError);

    const inTicks = spice.ckCoverageAll(CKID, { timeSystem: 'SCLK' });
    const inEt = spice.ckCoverageAll(CKID, { timeSystem: 'TDB' });
    expect(inTicks.length).toBe(1);
    expect(inEt.length).toBe(1);
    expect(inTicks[0]![0]).toBeCloseTo(ticks[0]!, 6);
    expect(inTicks[0]![1]).toBeCloseTo(ticks[ticks.length - 1]!, 6);
    // ET endpoints are the tick endpoints through clock -82.
    expect(inEt[0]![0]).toBeCloseTo(spice.sct2e(CLOCK, inTicks[0]![0]), 6);
    expect(inEt[0]![1]).toBeCloseTo(spice.sct2e(CLOCK, inTicks[0]![1]), 6);
  });

  it('finds CKs by kernel kind, not by filename extension', () => {
    // A second segment for the same structure, well clear of the first, in a
    // file whose name is not `.bc`. The gap is in ticks, and this clock runs
    // ~1000 ticks per second, so it has to be wide enough that SPICE does not
    // simply merge the two into one window. A filename-driven scan would miss it entirely;
    // ktotal/kdata over the 'CK' kind does not, and ckcov_c unions the two
    // files into one answer.
    const before = spice.ckCoverageAll(CKID, { timeSystem: 'SCLK' });
    expect(before.length).toBe(1);

    const later = ticks.map((t) => t + 10_000_000);
    const quats = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    spice.writeCk03(
      'attitude.dat', CKID, 'J2000', 'ODD_NAME',
      new Float64Array(later), quats, null, new Float64Array([later[0]!]),
    );
    try {
      expect(spice.ckObjects('attitude.dat')).toEqual([CKID]);
      const after = spice.ckCoverageAll(CKID, { timeSystem: 'SCLK' });
      expect(after.length, 'the oddly named CK contributes a second window').toBe(2);
      expect(after[1]![0]).toBeCloseTo(later[0]!, 6);
    } finally {
      spice.unload('attitude.dat');
    }
  });

  it('reports an unknown id as empty coverage and a bad argument as an error', () => {
    expect(spice.ckCoverageAll(-99000)).toEqual([]);
    expect(() => spice.ckCoverageAll(CKID, { timeSystem: 'NOPE' as never })).toThrow(SpiceError);
    expect(() => spice.ckCoverageAll(CKID, { level: 'NOPE' as never })).toThrow(SpiceError);
  });
});
