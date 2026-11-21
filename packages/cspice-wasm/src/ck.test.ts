// Native CK (C-kernel) read/write round trip through the engine.
//
// Oracle (independent of the binding's own math): a known attitude profile is
// written to a CK Type 3 segment via writeCk03, furnished, then read back two ways:
//   (1) ckgp returns the C-matrix (J2000 -> frame); it must equal q2m(quat) exactly
//       at each sample epoch (q2m is the already-validated CSPICE quaternion convention).
//   (2) pxform(frame, J2000) must equal the transpose of that C-matrix (pxform returns
//       frame -> J2000), so a CK-declared class-3 frame drives the scene's pxform path.
// SCLK and FK are built here as in-memory text kernels and furnished as bytes (the
// engine never reads kernel files itself). (STK_PARITY_SPEC section 4.6 ATT-6/ATT-7.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, type SpiceEngine } from './index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

// A demo spacecraft and a class-3 CK frame tied to it. The CK instrument id and the
// frame id share -999000 (the frame's CLASS_ID is the CK structure id).
const SC = -999;
const CKID = -999000;
const FRAME = 'DEMO_SC_CK';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// Type-1 SCLK: each coarse count has 1000 ticks. The rate is seconds per
// coarse count, with zero encoded ticks at ET 0.
const demoSclk = (id: number, rate: number) => `\\begindata
SCLK_KERNEL_ID           = ( @2026-01-01T00:00:00 )
SCLK_DATA_TYPE_${id}       = ( 1 )
SCLK01_TIME_SYSTEM_${id}   = ( 1 )
SCLK01_N_FIELDS_${id}      = ( 2 )
SCLK01_MODULI_${id}        = ( 1000000000000 1000 )
SCLK01_OFFSETS_${id}       = ( 0 0 )
SCLK01_OUTPUT_DELIM_${id}  = ( 1 )
SCLK_PARTITION_START_${id} = ( 0 )
SCLK_PARTITION_END_${id}   = ( 1.0E+15 )
SCLK01_COEFFICIENTS_${id}  = ( 0 0 ${rate}.0 )
\\begintext
`;

// FK: a class-3 frame whose orientation comes from the CK, tied to the SCLK and SPK.
const demoFk = (frame: string, ckId: number, sc: number) => `\\begindata
FRAME_${frame}            = ${ckId}
FRAME_${ckId}_NAME        = '${frame}'
FRAME_${ckId}_CLASS       = 3
FRAME_${ckId}_CLASS_ID    = ${ckId}
FRAME_${ckId}_CENTER      = ${sc}
CK_${ckId}_SCLK           = ${sc}
CK_${ckId}_SPK            = ${sc}
\\begintext
`;

// Profile: identity, 90 deg about +X, 90 deg about +Z (scalar-first quaternions).
const C = Math.cos(Math.PI / 4);
const S = Math.sin(Math.PI / 4);
const QUATS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 0, 0, 0],
  [C, S, 0, 0],
  [C, 0, 0, S],
];

const transpose3x3 = (m: readonly number[]): number[] => [
  m[0]!, m[3]!, m[6]!,
  m[1]!, m[4]!, m[7]!,
  m[2]!, m[5]!, m[8]!,
];

describe('native CK write/read round trip (ckw03 -> ckgp/pxform)', () => {
  let spice: SpiceEngine;
  let ets: number[];

  beforeAll(async () => {
    spice = await createSpiceEngine();
    await spice.furnsh('naif0012.tls', fixture('naif0012.tls'));
    await spice.furnsh('demo.tsc', utf8(demoSclk(-SC, 1)));
    await spice.furnsh('demo.tf', utf8(demoFk(FRAME, CKID, SC)));

    const et0 = await spice.str2et('2026-06-15T00:00:00');
    ets = [et0, et0 + 60, et0 + 120];

    // Encode each epoch to SCLK ticks and write the CK Type 3 segment.
    const sclk = new Float64Array(ets.length);
    for (let k = 0; k < ets.length; k++) sclk[k] = await spice.sce2c(SC, ets[k]!);
    const quats = new Float64Array(QUATS.flat());
    const starts = new Float64Array([sclk[0]!]); // one interpolation interval
    await spice.writeCk03('demo.bc', CKID, 'J2000', 'BESSEL_DEMO_SEG', sclk, quats, null, starts);
  });

  it('sce2c and sct2e invert each other for the demo clock', async () => {
    const ticks = await spice.sce2c(SC, ets[1]!);
    const back = await spice.sct2e(SC, ticks);
    expect(back).toBeCloseTo(ets[1]!, 6);
  });

  it('ckgp returns the C-matrix equal to q2m(quat) at each sample epoch', async () => {
    for (let k = 0; k < ets.length; k++) {
      const ticks = await spice.sce2c(SC, ets[k]!);
      const got = await spice.ckgp(CKID, ticks, 0, 'J2000');
      expect(got.found).toBe(true);
      const ref = await spice.q2m(QUATS[k]! as unknown as number[]);
      for (let i = 0; i < 9; i++) expect(got.cmat[i]!).toBeCloseTo(ref[i]!, 9);
    }
  });

  it('pxform(frame, J2000) equals the transpose of q2m(quat) (drives the scene path)', async () => {
    for (let k = 0; k < ets.length; k++) {
      const rot = await spice.pxform(FRAME, 'J2000', ets[k]!);
      const ref = transpose3x3(await spice.q2m(QUATS[k]! as unknown as number[]));
      for (let i = 0; i < 9; i++) expect(rot[i]!).toBeCloseTo(ref[i]!, 9);
    }
  });

  it('ckgp reports not found outside the segment coverage', async () => {
    const ticksBefore = await spice.sce2c(SC, ets[0]! - 3600);
    const got = await spice.ckgp(CKID, ticksBefore, 0, 'J2000');
    expect(got.found).toBe(false);
  });

  it('keeps interleaved CK clocks distinct and uses the switch frame fallback outside primary coverage', async () => {
    const fallbackSc = -998;
    const fallbackId = -998000;
    const fallbackFrame = 'DEMO_FALLBACK_CK';
    await spice.furnsh('fallback.tsc', utf8(demoSclk(-fallbackSc, 2)));
    await spice.furnsh('fallback.tf', utf8(demoFk(fallbackFrame, fallbackId, fallbackSc)));
    await spice.furnsh('switch.tf', utf8(`\\begindata
FRAME_DEMO_SWITCH          = -999001
FRAME_-999001_NAME         = 'DEMO_SWITCH'
FRAME_-999001_CLASS        = 6
FRAME_-999001_CLASS_ID     = -999001
FRAME_-999001_CENTER       = -999
FRAME_-999001_ALIGNED_WITH = ( '${fallbackFrame}', '${FRAME}' )
\\begintext
`));

    const inside = ets[1]!;
    const outside = ets[2]! + 60;
    const start = await spice.sce2c(fallbackSc, inside);
    const end = await spice.sce2c(fallbackSc, outside);
    await spice.writeCk03('fallback.bc', fallbackId, 'J2000', 'FALLBACK', new Float64Array([start, end]),
      new Float64Array([1, 0, 0, 0, 1, 0, 0, 0]), null, new Float64Array([start]));

    for (const et of [inside, outside, inside]) {
      const primaryTicks = await spice.sce2c(SC, et);
      const fallbackTicks = await spice.sce2c(fallbackSc, et);
      expect(fallbackTicks * 2).toBeCloseTo(primaryTicks, 3);
      expect(await spice.sct2e(SC, primaryTicks)).toBeCloseTo(et, 6);
      expect(await spice.sct2e(fallbackSc, fallbackTicks)).toBeCloseTo(et, 6);
      expect((await spice.ckgp(CKID, primaryTicks, 0, 'J2000')).found).toBe(et === inside);
      expect((await spice.ckgp(fallbackId, fallbackTicks, 0, 'J2000')).found).toBe(true);
      const expected = await spice.pxform(et === inside ? FRAME : fallbackFrame, 'J2000', et);
      const actual = await spice.pxform('DEMO_SWITCH', 'J2000', et);
      actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 12));
    }
  });
});
