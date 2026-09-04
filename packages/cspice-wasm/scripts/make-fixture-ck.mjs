// One-time, reproducible generator for the demo CK attitude fixture.
//
// Writes a small committed CK (binary C-kernel), an SCLK, and an FK under
// kernels/fixtures so the Cassini demo can show a real CK-driven spacecraft
// attitude (not the synthetic UniformRotation spin). The CK is a Type 3 segment
// (discrete quaternions + linear interpolation) written by CSPICE ckw03, so the
// bytes come from SPICE itself, never the editor (the .bc/.tsc/.tf files are
// .claudeignore'd and must be generated, not hand-written).
//
// The attitude profile is a nadir-style sweep: the spacecraft +Z axis tracks
// from one inertial direction to another across the demo span, sampled every
// few minutes and SLERP-interpolated by CK Type 3 between samples. The exact
// profile is arbitrary; what matters is that pxform(frame, J2000) resolves a
// real, time-varying orientation from a furnished CK.
//
// Run: node packages/cspice-wasm/scripts/make-fixture-ck.mjs

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import CSpice from '../wasm/cspice.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const fix = (name) => resolve(repoRoot, 'kernels/fixtures', name);
const lsk = fix('naif0012.tls');

// Cassini spacecraft body, a CK structure id, and a class-3 frame. The synthetic
// SCLK and frame are bundled with the CK so the demo is self-contained (the real
// Cassini SCLK is not redistributed here; the demo only needs a valid clock).
const SC = -82;
const CKID = -82000;
const FRAMEID = -82000;
const FRAME = 'BESSEL_CASSINI_CK';

const mod = await CSpice();
const { FS } = mod;
const cstr = (s) => {
  const n = mod.lengthBytesUTF8(s) + 1;
  const p = mod._malloc(n);
  mod.stringToUTF8(s, p, n);
  return p;
};
const dbl = (p) => mod.getValue(p, 'double');
const i32 = (p) => mod.getValue(p, 'i32');
const setd = (p, v) => mod.setValue(p, v, 'double');
const call = (name, ...a) => mod[`_${name}`](...a);
const fail = (where) => {
  if (call('failed_c') === 0) return;
  const lp = mod._malloc(1841);
  call('getmsg_c', cstr('LONG'), 1841, lp);
  const msg = mod.UTF8ToString(lp);
  mod._free(lp);
  throw new Error(`${where}: ${msg}`);
};

call('erract_c', cstr('SET'), 0, cstr('RETURN'));
call('errprt_c', cstr('SET'), 0, cstr('NONE'));

FS.writeFile('/lsk.tls', new Uint8Array(readFileSync(lsk)));
call('furnsh_c', cstr('/lsk.tls'));

// Synthetic type-1 SCLK for body -82: 1 tick = 1 second from a 2004 epoch.
const SCLK_TEXT = `\\begindata
SCLK_KERNEL_ID           = ( @2004-01-01T00:00:00 )
SCLK_DATA_TYPE_82        = ( 1 )
SCLK01_TIME_SYSTEM_82    = ( 1 )
SCLK01_N_FIELDS_82       = ( 2 )
SCLK01_MODULI_82         = ( 1000000000000 1000 )
SCLK01_OFFSETS_82        = ( 0 0 )
SCLK01_OUTPUT_DELIM_82   = ( 1 )
SCLK_PARTITION_START_82  = ( 0.0000000000000E+00 )
SCLK_PARTITION_END_82    = ( 1.0000000000000E+15 )
SCLK01_COEFFICIENTS_82   = ( 0.0000000000000E+00  0.0000000000000E+00  1.0000000000000E+00 )
\\begintext
`;
FS.writeFile('/cassini-demo.tsc', new TextEncoder().encode(SCLK_TEXT));
writeFileSync(fix('cassini-demo.tsc'), Buffer.from(SCLK_TEXT));
call('furnsh_c', cstr('/cassini-demo.tsc'));
fail('furnsh SCLK');

// FK: class-3 frame BESSEL_CASSINI_CK driven by the CK, tied to the SCLK and SPK.
const FK_TEXT = `\\begindata
FRAME_${FRAME}            = ${FRAMEID}
FRAME_${FRAMEID}_NAME     = '${FRAME}'
FRAME_${FRAMEID}_CLASS    = 3
FRAME_${FRAMEID}_CLASS_ID = ${CKID}
FRAME_${FRAMEID}_CENTER   = ${SC}
CK_${CKID}_SCLK           = ${SC}
CK_${CKID}_SPK            = ${SC}
\\begintext
`;
FS.writeFile('/cassini-demo.tf', new TextEncoder().encode(FK_TEXT));
writeFileSync(fix('cassini-demo.tf'), Buffer.from(FK_TEXT));
call('furnsh_c', cstr('/cassini-demo.tf'));
fail('furnsh FK');

// Build a smooth attitude profile across the demo span. Sample every 6 hours and
// roll the spacecraft about +Z so the orientation is visibly time-varying.
const etPtr = mod._malloc(8);
call('str2et_c', cstr('2004-06-22T00:00:00'), etPtr);
const etStart = dbl(etPtr);
call('str2et_c', cstr('2004-08-22T00:00:00'), etPtr);
const etStop = dbl(etPtr);
const SAMPLES = 60;
const ets = [];
for (let k = 0; k <= SAMPLES; k++) ets.push(etStart + ((etStop - etStart) * k) / SAMPLES);

// q(t): rotate about +Z by an angle ramping 0 -> 2*pi across the span (scalar-first).
const quats = ets.map((et) => {
  const frac = (et - etStart) / (etStop - etStart);
  const half = (frac * 2 * Math.PI) / 2;
  return [Math.cos(half), 0, 0, Math.sin(half)];
});

// Encode SCLK and write the CK Type 3 segment.
const tickPtr = mod._malloc(8);
const sclk = ets.map((et) => {
  call('sce2c_c', SC, et, tickPtr);
  return dbl(tickPtr);
});
fail('sce2c');

const n = ets.length;
const hPtr = mod._malloc(4);
call('ckopn_c', cstr('/cassini-demo.bc'), cstr('BESSEL_CASSINI_DEMO_CK'), 0, hPtr);
const handle = i32(hPtr);
const sclkBuf = mod._malloc(n * 8);
sclk.forEach((v, k) => setd(sclkBuf + k * 8, v));
const quatBuf = mod._malloc(n * 4 * 8);
quats.flat().forEach((v, i) => setd(quatBuf + i * 8, v));
const avBuf = mod._malloc(n * 3 * 8);
for (let i = 0; i < n * 3; i++) setd(avBuf + i * 8, 0);
const startBuf = mod._malloc(8);
setd(startBuf, sclk[0]); // one interpolation interval spanning the whole segment
call(
  'ckw03_c',
  handle,
  sclk[0],
  sclk[n - 1],
  CKID,
  cstr('J2000'),
  0,
  cstr('BESSEL_CASSINI_DEMO_SEG'),
  n,
  sclkBuf,
  quatBuf,
  avBuf,
  1,
  startBuf,
);
fail('ckw03');
call('ckcls_c', handle);
fail('ckcls');

const ck = FS.readFile('/cassini-demo.bc');
writeFileSync(fix('cassini-demo.bc'), Buffer.from(ck));

// Verify the round trip: pxform(frame, J2000) at a mid epoch should be a pure +Z
// rotation matching q2m of the interpolated profile.
call('furnsh_c', cstr('/cassini-demo.bc'));
fail('furnsh CK');
const etMid = etStart + (etStop - etStart) / 2;
const rot = mod._malloc(72);
call('pxform_c', cstr(FRAME), cstr('J2000'), etMid, rot);
fail('pxform');
const m = [];
for (let i = 0; i < 9; i++) m.push(dbl(rot + i * 8));

console.log(`Wrote ${fix('cassini-demo.bc')} (${ck.length} bytes), ${n} records.`);
console.log(`Wrote ${fix('cassini-demo.tsc')} and ${fix('cassini-demo.tf')} (frame ${FRAME}).`);
console.log('pxform(%s, J2000) at mid-span =', FRAME);
console.log('  [', m.slice(0, 3).map((x) => x.toFixed(4)).join(', '), ']');
console.log('  [', m.slice(3, 6).map((x) => x.toFixed(4)).join(', '), ']');
console.log('  [', m.slice(6, 9).map((x) => x.toFixed(4)).join(', '), ']');
