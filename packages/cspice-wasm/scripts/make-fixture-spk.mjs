// One-time, reproducible fixture generator.
//
// Subsets NASA/JPL de440s.bsp (the authoritative NAIF planetary ephemeris) to a
// small, redistributable SPK covering the inner solar system plus Saturn over the
// Cassini Saturn-orbit-insertion window, and prints the spkpos reference value the
// cspice-wasm fixture test asserts against. de440s itself is bulk data (32 MB,
// git-ignored); this subset is a few hundred KB and is committed under
// kernels/fixtures so the unit test is deterministic in CI without a download.
//
// Run: node packages/cspice-wasm/scripts/make-fixture-spk.mjs

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import CSpice from '../wasm/cspice.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const lskSrc = resolve(repoRoot, 'vendor/cspice/kernels/lsk/latest_leapseconds.tls');
const spkSrc = resolve(repoRoot, 'vendor/cspice/kernels/spk/de440s.bsp');
const outDir = resolve(repoRoot, 'kernels/fixtures');
const outSpk = resolve(outDir, 'de440s-inner-cassini.bsp');

// Bodies to retain: Sun, the planet barycenters (Saturn = 6), Earth, Moon, EMB.
const KEEP = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 301, 399]);

const mod = await CSpice();
const { FS } = mod;

function cstr(s) {
  const n = mod.lengthBytesUTF8(s) + 1;
  const ptr = mod._malloc(n);
  mod.stringToUTF8(s, ptr, n);
  return ptr;
}
const dbl = (ptr) => mod.getValue(ptr, 'double');
const i32 = (ptr) => mod.getValue(ptr, 'i32');
function call(name, ...args) {
  return mod['_' + name](...args);
}

// Route SPICE errors to return-mode so we can inspect rather than abort.
call('erract_c', cstr('SET'), 0, cstr('RETURN'));
call('errprt_c', cstr('SET'), 0, cstr('NONE'));

// Stage source kernels into the in-memory FS.
FS.writeFile('/latest_leapseconds.tls', new Uint8Array(readFileSync(lskSrc)));
FS.writeFile('/de440s.bsp', new Uint8Array(readFileSync(spkSrc)));

call('furnsh_c', cstr('/latest_leapseconds.tls'));

// Window: 2004-01-01 .. 2005-01-01 (brackets Cassini SOI, 2004-07-01).
function str2et(utc) {
  const p = mod._malloc(8);
  call('str2et_c', cstr(utc), p);
  const et = dbl(p);
  mod._free(p);
  return et;
}
const w0 = str2et('2004-01-01T00:00:00');
const w1 = str2et('2005-01-01T00:00:00');

// Open source DAF and the output SPK.
const hPtr = mod._malloc(4);
call('dafopr_c', cstr('/de440s.bsp'), hPtr);
const srcHan = i32(hPtr);
call('spkopn_c', cstr('/out.bsp'), cstr('BESSEL_FIXTURE'), 0, hPtr);
const outHan = i32(hPtr);

const sumPtr = mod._malloc(5 * 8); // packed descriptor: ND=2 + (NI+1)/2=3 doubles
const dcPtr = mod._malloc(2 * 8);
const icPtr = mod._malloc(6 * 4);
const foundPtr = mod._malloc(4);
const idLen = 41;
const idPtr = mod._malloc(idLen);

call('dafbfs_c', srcHan);
call('daffna_c', foundPtr);
let kept = 0;
while (i32(foundPtr) !== 0) {
  call('dafgs_c', sumPtr);
  call('dafgn_c', idLen, idPtr);
  call('dafus_c', sumPtr, 2, 6, dcPtr, icPtr);
  const segStart = dbl(dcPtr);
  const segStop = dbl(dcPtr + 8);
  const body = i32(icPtr);
  if (KEEP.has(body) && segStop > w0 && segStart < w1) {
    const b = Math.max(segStart, w0);
    const e = Math.min(segStop, w1);
    call('spksub_c', srcHan, sumPtr, idPtr, b, e, outHan);
    kept += 1;
  }
  call('daffna_c', foundPtr);
}
call('spkcls_c', outHan);
call('dafcls_c', srcHan);

if (call('failed_c') !== 0) {
  const msgPtr = mod._malloc(1841);
  call('getmsg_c', cstr('LONG'), 1841, msgPtr);
  throw new Error('SPICE error: ' + mod.UTF8ToString(msgPtr));
}

// Persist the subset.
FS.mkdirTree?.('/');
const out = FS.readFile('/out.bsp');
writeFileSync(outSpk, Buffer.from(out));
console.log(`Wrote ${outSpk} (${out.length} bytes), ${kept} segments kept.`);

// Load the freshly written subset and pin the reference from it. This doubles as a
// validation that the subset is self-consistent and loadable.
call('furnsh_c', cstr('/out.bsp'));
if (call('failed_c') !== 0) throw new Error('subset failed to load');

// Pin the reference: Saturn barycenter (6) relative to Sun (10), J2000, no aberration.
const TEST_UTC = '2004-07-01T00:00:00';
const et = str2et(TEST_UTC);
const posPtr = mod._malloc(3 * 8);
const ltPtr = mod._malloc(8);
call('spkpos_c', cstr('6'), et, cstr('J2000'), cstr('NONE'), cstr('10'), posPtr, ltPtr);
const pos = [0, 1, 2].map((i) => dbl(posPtr + i * 8));
console.log('Reference spkpos(6 wrt 10, J2000, NONE) at', TEST_UTC);
console.log('ET =', et);
console.log('position km =', JSON.stringify(pos));
console.log('light time s =', dbl(ltPtr));
