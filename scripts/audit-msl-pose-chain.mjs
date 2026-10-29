#!/usr/bin/env node
// Read-only comparison: replay the historical telemetry kernel order, then the
// orbital-localized default. DAF summaries establish which SPK segments win.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createSpiceEngine } from '../packages/cspice-wasm/dist/index.js';

const root = 'apps/viewer/test-catalogs/kernels/';
const catalog = JSON.parse(await readFile('apps/viewer/test-catalogs/msl-dingo-gap.json', 'utf8'));
const localizedKernel = 'kernels/msl/msl_surf_rover_loc_0000_2003_v1.bsp';
if (catalog.spiceKernels.at(-1) !== localizedKernel) throw new Error('Canonical Curiosity must load localized position last');

const original = JSON.parse(await readFile('docs/validation/curiosity-gale/spice-states.json', 'utf8'));
const snapshot = JSON.parse(await readFile('docs/validation/curiosity-gale/evidence/places-control-snapshot.json', 'utf8'));
const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/audit-msl-pose-chain.mjs OUTPUT.json');
function segments(bytes, name) {
  const be = bytes.toString('ascii', 88, 96).trim() === 'BIG-IEEE';
  const int = o => be ? bytes.readInt32BE(o) : bytes.readInt32LE(o);
  const double = o => be ? bytes.readDoubleBE(o) : bytes.readDoubleLE(o);
  if (int(8) !== 2 || int(12) !== 6) throw new Error('Expected SPK DAF summary');
  const rows = [];
  for (let record = int(76); record; ) {
    const start = (record - 1) * 1024, count = double(start + 16);
    for (let i = 0; i < count; i++) {
      const o = start + 24 + i * 40;
      rows.push({ kernel: name, startEt: double(o), endEt: double(o + 8), target: int(o + 16),
        center: int(o + 20), frameId: int(o + 24), type: int(o + 28),
        segmentId: bytes.toString('ascii', start + 1024 + i * 40, start + 1024 + (i + 1) * 40).trim() });
    }
    record = double(start);
  }
  return rows;
}
const engine = await createSpiceEngine(), kernels = [], all = [];
for (const pin of original.kernels) {
  const bytes = await readFile(root + pin.name);
  if (bytes.length !== pin.bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
    throw new Error(`Kernel differs from original audit pin: ${pin.name}`);
  }
  await engine.furnsh(pin.name.split('/').at(-1), bytes);
  kernels.push(pin);
  if (pin.name.endsWith('.bsp')) all.push(...segments(bytes, pin.name));
}
function chain(et, ordered) {
  const result = [];
  for (let target = -76; target !== 499; ) {
    const seg = ordered.findLast(s => s.target === target && s.startEt <= et && et <= s.endEt);
    if (!seg || result.length > 8) throw new Error(`Unresolved SPK chain at ${target}`);
    result.push(seg); target = seg.center;
  }
  return result;
}
const anchor = snapshot.sources.localized_interp.find(r => r.drive === '184');
// MSL clock has 65536 fractional ticks per second, zero offsets, partition start 0.
const anchorEt = await engine.sct2e(-76, Number(anchor.sclk) * 65536);
const times = [...original.rows.map(r => ({ utc: r.utc, et: r.et })),
  { utc: await engine.et2utc(anchorEt, 'ISOC', 3), et: anchorEt, role: 'exact PLACES site26 drive184 SCLK' }];
const rows = [];
for (const t of times) {
  const p = (await engine.spkpos('-76', t.et, 'IAU_MARS', 'NONE', '499')).position;
  rows.push({ ...t, telemetryPositionKm: p, telemetryChain: chain(t.et, all),
    roverToBody: await engine.pxform('MSL_ROVER', 'IAU_MARS', t.et) });
}
// No refit: reload the exact existing NAIF localized product with higher priority.
const loc = 'msl/msl_surf_rover_loc_0000_2003_v1.bsp';
await engine.furnsh(loc.split('/').at(-1), await readFile(root + loc));
const localizedOrder = [...all, ...all.filter(s => s.kernel === loc)];
for (const r of rows) {
  r.localizedPositionKm = (await engine.spkpos('-76', r.et, 'IAU_MARS', 'NONE', '499')).position;
  r.localizedChain = chain(r.et, localizedOrder);
  r.localizedRoverToBody = await engine.pxform('MSL_ROVER', 'IAU_MARS', r.et);
}
await writeFile(output, JSON.stringify({ version: 1, kernels, frame: 'IAU_MARS', center: '499',
  abcorr: 'NONE', originalSelection: 'catalog order: telemetry loaded after localized',
  alternative: 'same existing localized SPK loaded last; separate source solution, no fitted offsets',
  placesAnchor: anchor, rows }, null, 2) + '\n');
