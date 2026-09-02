// One-time, reproducible fixture generator for the Cassini Phase 0 demo.
//
// Subsets the Cassini reconstructed SCPSE SPK (fetched by kernels/fetch.sh) down
// to the spacecraft body (-82), producing a small committed SPK under
// kernels/fixtures so the poc-cassini e2e test renders a real trajectory without
// a multi-megabyte download. Prints the spacecraft center and a sample state.
//
// Run: node packages/cspice-wasm/scripts/make-fixture-cassini.mjs

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import CSpice from '../wasm/cspice.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const lsk = resolve(repoRoot, 'kernels/data/naif0012.tls');
const scpse = resolve(repoRoot, 'kernels/data/cassini_scpse_04173_04236.bsp');
const outSpk = resolve(repoRoot, 'kernels/fixtures/cassini-soi.bsp');

const CASSINI = -82;
// Keep the spacecraft plus Saturn (699) so footprint intercepts (sincpt) and
// sub-observer points resolve against a real body with a shape and a frame.
const KEEP = new Set([-82, 699]);

const mod = await CSpice();
const { FS } = mod;

function cstr(s) {
  const n = mod.lengthBytesUTF8(s) + 1;
  const ptr = mod._malloc(n);
  mod.stringToUTF8(s, ptr, n);
  return ptr;
}
const dbl = (p) => mod.getValue(p, 'double');
const i32 = (p) => mod.getValue(p, 'i32');
const call = (name, ...args) => mod[`_${name}`](...args);

call('erract_c', cstr('SET'), 0, cstr('RETURN'));
call('errprt_c', cstr('SET'), 0, cstr('NONE'));

FS.writeFile('/naif0012.tls', new Uint8Array(readFileSync(lsk)));
FS.writeFile('/scpse.bsp', new Uint8Array(readFileSync(scpse)));
call('furnsh_c', cstr('/naif0012.tls'));

const hPtr = mod._malloc(4);
call('dafopr_c', cstr('/scpse.bsp'), hPtr);
const srcHan = i32(hPtr);
call('spkopn_c', cstr('/cassini.bsp'), cstr('BESSEL_CASSINI_FIXTURE'), 0, hPtr);
const outHan = i32(hPtr);

const sumPtr = mod._malloc(5 * 8);
const dcPtr = mod._malloc(2 * 8);
const icPtr = mod._malloc(6 * 4);
const foundPtr = mod._malloc(4);
const idPtr = mod._malloc(41);

let kept = 0;
let center = null;
let cover = null;
call('dafbfs_c', srcHan);
call('daffna_c', foundPtr);
while (i32(foundPtr) !== 0) {
  call('dafgs_c', sumPtr);
  call('dafgn_c', 41, idPtr);
  call('dafus_c', sumPtr, 2, 6, dcPtr, icPtr);
  const body = i32(icPtr);
  if (KEEP.has(body)) {
    if (body === CASSINI) {
      center = i32(icPtr + 4);
      cover = [dbl(dcPtr), dbl(dcPtr + 8)];
    }
    call('spksub_c', srcHan, sumPtr, idPtr, dbl(dcPtr), dbl(dcPtr + 8), outHan);
    kept += 1;
  }
  call('daffna_c', foundPtr);
}
call('spkcls_c', outHan);
call('dafcls_c', srcHan);

if (call('failed_c') !== 0) throw new Error('subset failed');

const out = FS.readFile('/cassini.bsp');
writeFileSync(outSpk, Buffer.from(out));
console.log(`Wrote ${outSpk} (${out.length} bytes), ${kept} segments of body ${CASSINI} kept.`);
console.log('Cassini SPK center body =', center);
console.log('Coverage ET window =', JSON.stringify(cover));

// Sample Cassini relative to Saturn barycenter (6) at SOI, using the committed
// de440s subset for the Saturn chain.
call('furnsh_c', cstr('/cassini.bsp'));
FS.writeFile(
  '/de440s.bsp',
  new Uint8Array(readFileSync(resolve(repoRoot, 'kernels/fixtures/de440s-inner-cassini.bsp'))),
);
call('furnsh_c', cstr('/de440s.bsp'));

const etPtr = mod._malloc(8);
call('str2et_c', cstr('2004-07-01T02:48:00'), etPtr); // SOI burn end, approx
const et = dbl(etPtr);
const pos = mod._malloc(3 * 8);
const lt = mod._malloc(8);
call('spkpos_c', cstr('-82'), et, cstr('J2000'), cstr('NONE'), cstr('6'), pos, lt);
if (call('failed_c') !== 0) {
  console.log('note: sample spkpos failed (center chain), fixture still written');
} else {
  const p = [0, 1, 2].map((i) => dbl(pos + i * 8));
  const dist = Math.hypot(p[0], p[1], p[2]);
  console.log('Cassini wrt Saturn barycenter at ~SOI: km =', JSON.stringify(p));
  console.log('range from Saturn (km) =', dist.toFixed(1));
}
