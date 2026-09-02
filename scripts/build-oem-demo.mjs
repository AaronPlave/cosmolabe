#!/usr/bin/env node
/**
 * Generate the demo CCSDS OEM for apps/viewer/test-catalogs/oem-ingest.json.
 *
 * Why generate rather than ship a downloaded file: the point of the demo is
 * that an ephemeris delivered as a CCSDS text file renders correctly, and the
 * sharpest way to show that is to put the same spacecraft on screen twice —
 * once straight from the SPICE kernel, once round-tripped through OEM — and
 * see them coincide. That needs both to come from the same source states, so
 * the file is written here from the kernel the demo already loads. No network,
 * and the comparison is exact by construction rather than by trust.
 *
 * It also exercises the writer we harvested (@cosmolabe/interop's writeOem)
 * against real mission states rather than fixtures, and the states come out of
 * cspice-wasm through the frames tier, so this script is a small end-to-end
 * check of the whole harvested stack.
 *
 * Usage:  node scripts/build-oem-demo.mjs
 * Rerun whenever the sampling parameters below change; the output is committed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpiceBindings } from 'cspice-wasm';
import { framesLayerOver } from '@cosmolabe/frames';
import { writeOem } from '@cosmolabe/interop';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL_DIR = join(REPO, 'apps/viewer/test-catalogs/kernels');
const OUT = join(REPO, 'apps/viewer/test-catalogs/ephemerides/cassini-soi.oem');

/** Generic kernels plus the SOI-week reconstructed trajectory. All committed. */
const KERNELS = [
  join(KERNEL_DIR, 'naif0012.tls'),
  join(KERNEL_DIR, 'pck00011.tpc'),
  join(KERNEL_DIR, 'cassini/040629AP_SCPSE_04179_04185.bsp'),
];

/**
 * Sampling. The window sits inside the SOI kernel's coverage (2004 DOY
 * 179-185) and brackets Saturn orbit insertion on 2004-07-01, which is the
 * interesting part of the arc — a tight periapsis pass where a coarse
 * ephemeris would visibly cut the corner.
 *
 * 120 s is deliberately fine. OEM carries position and velocity per sample and
 * the viewer reconstructs with cubic Hermite, so the reconstruction error falls
 * roughly as the fourth power of the step; at 2 minutes through periapsis it is
 * far below a pixel, which is what lets the two rendered arcs overlay exactly.
 * It costs about 1.5 MB of text for the full window, so the window is trimmed
 * to the day around SOI rather than the kernel's whole span.
 */
const START_UTC = '2004-06-30 12:00:00';
const STOP_UTC = '2004-07-02 12:00:00';
const STEP_SEC = 120;

const TARGET = 'CASSINI';
const CENTER = 'SATURN';
/** J2000 equatorial, matching the trajectoryFrame the Saturn catalogs use. */
const FRAME = 'J2000';

const bindings = await createSpiceBindings();
const frames = framesLayerOver(bindings);

for (const path of KERNELS) {
  const bytes = new Uint8Array(readFileSync(path));
  frames.furnish(path.split('/').pop(), bytes);
}

const start = frames.toEt(START_UTC);
const stop = frames.toEt(STOP_UTC);

// One batched query rather than a loop of single calls: this is exactly what
// the StateProvider contract is for, and correction is explicit at the call
// site because the contract requires it. 'NONE' is right here — the file is a
// geometric ephemeris of where the spacecraft was, not what an observer saw.
const batch = await frames.states({
  targets: [TARGET],
  observer: CENTER,
  frame: FRAME,
  correction: 'NONE',
  epochs: { start, end: stop, step: STEP_SEC },
});

const n = batch.epochs.length;
if (n < 2) throw new Error(`expected a sampled arc, got ${n} states`);

const states = [];
for (let i = 0; i < n; i++) {
  states.push({
    // ISOC with 6 decimals: full sub-microsecond fidelity on the epoch, so the
    // ingest side's str2et lands back on the same instant.
    epoch: bindings.et2utc(batch.epochs[i], 'ISOC', 6),
    position: [batch.states[i * 6], batch.states[i * 6 + 1], batch.states[i * 6 + 2]],
    velocity: [batch.states[i * 6 + 3], batch.states[i * 6 + 4], batch.states[i * 6 + 5]],
  });
}

const text = writeOem({
  version: '2.0',
  originator: 'COSMOLABE',
  creationDate: bindings.et2utc(frames.toEt('2000-01-01 12:00:00'), 'ISOC', 0),
  metadata: {
    objectName: 'CASSINI',
    objectId: '1997-061A',
    centerName: 'SATURN',
    refFrame: FRAME,
    timeSystem: 'UTC',
    startTime: states[0].epoch,
    stopTime: states[n - 1].epoch,
  },
  states,
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);

const kb = (text.length / 1024).toFixed(0);
console.log(`wrote ${OUT}`);
console.log(`  ${n} states, ${START_UTC} to ${STOP_UTC} UTC, step ${STEP_SEC}s, ${kb} KB`);
console.log(`  ${TARGET} relative to ${CENTER} in ${FRAME}, correction NONE`);
