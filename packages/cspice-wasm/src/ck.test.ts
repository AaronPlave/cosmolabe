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
import { createSpiceEngine, type SpiceEngine } from './index.ts';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

// A demo spacecraft and a class-3 CK frame tied to it. The CK instrument id and the
// frame id share -999000 (the frame's CLASS_ID is the CK structure id).
const SC = -999;
const CKID = -999000;
const FRAMEID = -999000;
const FRAME = 'DEMO_SC_CK';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// Type-1 SCLK: 1 tick = 1 second from a 2026 epoch (enough to encode the demo span).
const SCLK = `\\begindata
SCLK_KERNEL_ID           = ( @2026-01-01T00:00:00 )
SCLK_DATA_TYPE_999       = ( 1 )
SCLK01_TIME_SYSTEM_999   = ( 1 )
SCLK01_N_FIELDS_999      = ( 2 )
SCLK01_MODULI_999        = ( 1000000000000 1000 )
SCLK01_OFFSETS_999       = ( 0 0 )
SCLK01_OUTPUT_DELIM_999  = ( 1 )
SCLK_PARTITION_START_999 = ( 0.0000000000000E+00 )
SCLK_PARTITION_END_999   = ( 1.0000000000000E+15 )
SCLK01_COEFFICIENTS_999  = ( 0.0000000000000E+00  0.0000000000000E+00  1.0000000000000E+00 )
\\begintext
`;

// FK: a class-3 frame whose orientation comes from the CK, tied to the SCLK and SPK.
const FK = `\\begindata
FRAME_${FRAME}            = ${FRAMEID}
FRAME_${FRAMEID}_NAME     = '${FRAME}'
FRAME_${FRAMEID}_CLASS    = 3
FRAME_${FRAMEID}_CLASS_ID = ${CKID}
FRAME_${FRAMEID}_CENTER   = ${SC}
CK_${CKID}_SCLK           = ${SC}
CK_${CKID}_SPK            = ${SC}
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
    await spice.furnsh('demo.tsc', utf8(SCLK));
    await spice.furnsh('demo.tf', utf8(FK));

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
});
