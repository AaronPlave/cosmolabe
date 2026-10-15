// One-time, reproducible subset of NAIF's reconstructed Cassini SCPSE SPK down
// to the three days the PDS geometry oracle needs (2004 DOY 183–185, Saturn
// orbit insertion), so the oracle can run offline against the same trajectory
// the archive's geometry was computed from.
//
// Why a reconstruction at all: the committed `040629AP_SCPSE_04179_04185.bsp`
// is an *as-planned* predict generated two days before the SOI burn. Every
// archived ISS frame in this window is post-burn, where that predict sits
// 20–900 km from where Cassini actually was. The RMS node computed its
// geometry against `040909R_SCPSE_01066_04199.bsp` (Saturn range agrees to
// 0.45 km with it, vs 509 km with the predict) — the same kernel the viewer's
// cassini-soi.json demo loads for this window. At 36 MB it is too big to
// commit; three days of it are not.
//
// Keeps every segment (spacecraft and the Saturn-system bodies), clipped to the
// window with spksub_c, so the subset is internally consistent with the source.
//
// Run: node scripts/make-cassini-soi-recon-spk.mjs [path/to/040909R_SCPSE_01066_04199.bsp]
//      (fetches the source from NAIF into kernels/data/ when no path is given)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CSpice from '../packages/cspice-wasm/wasm/cspice.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_NAME = '040909R_SCPSE_01066_04199.bsp';
const SOURCE_URL = `https://naif.jpl.nasa.gov/pub/naif/CASSINI/kernels/spk/${SOURCE_NAME}`;
const lsk = resolve(repoRoot, 'packages/spice/test-kernels/naif0012.tls');
const outSpk = resolve(repoRoot, 'packages/spice/test-kernels/cassini/040909R_SCPSE_04183_04185_subset.bsp');
// UTC; the oracle's observations run 2004-183T03:11 → 2004-185T13:28, and
// light time back to Saturn/the moons is under 10 s.
const WINDOW = ['2004-183T00:00:00', '2004-186T00:00:00'];

async function sourcePath() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const dest = resolve(repoRoot, 'kernels/data', SOURCE_NAME);
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    console.log(`fetching ${SOURCE_URL} ...`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`${SOURCE_URL}: HTTP ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  return dest;
}

const mod = await CSpice();
const { FS } = mod;
const cstr = (s) => {
  const n = mod.lengthBytesUTF8(s) + 1;
  const ptr = mod._malloc(n);
  mod.stringToUTF8(s, ptr, n);
  return ptr;
};
const dbl = (p) => mod.getValue(p, 'double');
const i32 = (p) => mod.getValue(p, 'i32');
const call = (name, ...args) => mod[`_${name}`](...args);
const check = (what) => {
  if (call('failed_c') === 0) return;
  const msg = mod._malloc(1841);
  call('getmsg_c', cstr('LONG'), 1841, msg);
  throw new Error(`${what}: ${mod.UTF8ToString(msg)}`);
};

call('erract_c', cstr('SET'), 0, cstr('RETURN'));
call('errprt_c', cstr('SET'), 0, cstr('NONE'));

FS.writeFile('/naif0012.tls', new Uint8Array(readFileSync(lsk)));
FS.writeFile('/src.bsp', new Uint8Array(readFileSync(await sourcePath())));
call('furnsh_c', cstr('/naif0012.tls'));

const etPtr = mod._malloc(8);
const [et0, et1] = WINDOW.map((s) => {
  call('str2et_c', cstr(s), etPtr);
  check(`str2et ${s}`);
  return dbl(etPtr);
});

const hPtr = mod._malloc(4);
call('dafopr_c', cstr('/src.bsp'), hPtr);
check('dafopr');
const srcHan = i32(hPtr);
call('spkopn_c', cstr('/out.bsp'), cstr('COSMOLABE_CASSINI_SOI_RECON'), 0, hPtr);
check('spkopn');
const outHan = i32(hPtr);

const sumPtr = mod._malloc(5 * 8);
const dcPtr = mod._malloc(2 * 8);
const icPtr = mod._malloc(6 * 4);
const foundPtr = mod._malloc(4);
const idPtr = mod._malloc(41);

const kept = [];
call('dafbfs_c', srcHan);
call('daffna_c', foundPtr);
while (i32(foundPtr) !== 0) {
  call('dafgs_c', sumPtr);
  call('dafgn_c', 41, idPtr);
  call('dafus_c', sumPtr, 2, 6, dcPtr, icPtr);
  const [b, e] = [dbl(dcPtr), dbl(dcPtr + 8)];
  const lo = Math.max(b, et0);
  const hi = Math.min(e, et1);
  if (lo < hi) {
    call('spksub_c', srcHan, sumPtr, idPtr, lo, hi, outHan);
    check('spksub');
    kept.push(`${i32(icPtr)} wrt ${i32(icPtr + 4)} (type ${i32(icPtr + 12)})`);
  }
  call('daffna_c', foundPtr);
}
call('spkcls_c', outHan);
call('dafcls_c', srcHan);
check('close');

const out = FS.readFile('/out.bsp');
writeFileSync(outSpk, Buffer.from(out));
console.log(`Wrote ${outSpk} (${out.length} bytes), window ${WINDOW.join(' → ')} UTC.`);
console.log(`${kept.length} segments: ${kept.join(', ')}`);
