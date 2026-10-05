// Reproduce the small LRO SPK used by the offline Horizons validation test.
// Run scripts/fetch-lro-kernels.sh first, then run this generator.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import CSpice from '../wasm/cspice.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = resolve(root, 'apps/viewer/test-catalogs/kernels/lro');
const out = resolve(root, 'packages/spice/test-kernels/lro');
mkdirSync(out, { recursive: true });

const mod = await CSpice();
const { FS } = mod;
const cstr = (value) => {
  const ptr = mod._malloc(mod.lengthBytesUTF8(value) + 1);
  mod.stringToUTF8(value, ptr, mod.lengthBytesUTF8(value) + 1);
  return ptr;
};
const call = (name, ...args) => mod[`_${name}`](...args);
const i32 = (ptr) => mod.getValue(ptr, 'i32');
const dbl = (ptr) => mod.getValue(ptr, 'double');
call('erract_c', cstr('SET'), 0, cstr('RETURN'));
call('errprt_c', cstr('SET'), 0, cstr('NONE'));

FS.writeFile('/naif0012.tls', readFileSync(resolve(root, 'packages/spice/test-kernels/naif0012.tls')));
FS.writeFile('/lro.bsp', gunzipSync(readFileSync(resolve(source, 'lrorg_2024350_2025074_v01.bsp.gz'))));
call('furnsh_c', cstr('/naif0012.tls'));
const et = (utc) => {
  const ptr = mod._malloc(8);
  call('str2et_c', cstr(utc), ptr);
  return dbl(ptr);
};
const start = et('2025-01-14T00:00:00');
const stop = et('2025-01-16T00:00:00');
const handle = mod._malloc(4);
call('dafopr_c', cstr('/lro.bsp'), handle);
const input = i32(handle);
call('spkopn_c', cstr('/lro-fixture.bsp'), cstr('LRO_JAN_2025'), 0, handle);
const output = i32(handle);
const summary = mod._malloc(5 * 8);
const bounds = mod._malloc(2 * 8);
const ints = mod._malloc(6 * 4);
const found = mod._malloc(4);
const name = mod._malloc(41);
let kept = 0;
call('dafbfs_c', input);
call('daffna_c', found);
while (i32(found)) {
  call('dafgs_c', summary);
  call('dafgn_c', 41, name);
  call('dafus_c', summary, 2, 6, bounds, ints);
  const begin = Math.max(start, dbl(bounds));
  const end = Math.min(stop, dbl(bounds + 8));
  if (begin < end) {
    call('spksub_c', input, summary, name, begin, end, output);
    kept++;
  }
  call('daffna_c', found);
}
call('spkcls_c', output);
call('dafcls_c', input);
if (call('failed_c')) {
  const msg = mod._malloc(1841);
  call('getmsg_c', cstr('LONG'), 1841, msg);
  throw new Error(mod.UTF8ToString(msg));
}
if (!kept) throw new Error('LRO source has no coverage for the test epoch');

const subset = FS.readFile('/lro-fixture.bsp');
writeFileSync(resolve(out, 'lro-jan-2025.bsp'), subset);
const frames = gunzipSync(readFileSync(resolve(source, 'lro_frames_2014049_v01.tf.gz')));
const frameText = frames.toString().split(/\r?\n/).map((line) => line.trimEnd()).join('\n').trimEnd();
writeFileSync(resolve(out, 'lro_frames_2014049_v01.tf'), `${frameText}\n`);
console.log(`Wrote LRO fixture: ${subset.length} bytes, ${kept} source segments`);
