#!/usr/bin/env node
/**
 * Resample a dense SPK into a compact Type 13 (Hermite) one, keeping its
 * discontinuities, and prove the result against the original.
 *
 * Why: some mission ephemerides are far denser than a viewer needs. Rosetta's
 * comet-phase reconstruction (RORB_DV_257, 182 MB) stores a state roughly every
 * 40 s for 2.7 years; relative to the comet the spacecraft moves at walking
 * pace, so a 10-minute Hermite sampling reproduces it to well under a metre
 * almost everywhere — at 6 MB. The exceptions are the orbit-determination
 * updates, where the reconstruction jumps (up to 168 km on approach). Sampling
 * across a jump would smear it into a fake manoeuvre, so the source's own
 * interval boundaries are read from the file, the ones where the position or
 * velocity actually jumps (a manoeuvre is a velocity step) are kept as segment
 * breaks, and each smooth piece is sampled on its own.
 *
 * The result is checked, not trusted: the output is furnished into a second
 * SPICE instance and compared with the source at random epochs and around every
 * break. The script fails if the worst error exceeds --max-error-m.
 *
 * States are taken relative to --center (not the source's own centre) because
 * that is what the scene draws: resampling Rosetta about 67P keeps the
 * kilometre-scale orbit exact rather than burying it under heliocentric motion.
 *
 * Usage:
 *   node scripts/resample-spk.mjs \
 *     --source RORB.BSP --kernels NAIF0011.TLS,CORB.BSP \
 *     --target=-226 --center=1000012 --frame J2000 \
 *     --step 600 --start 2014-08-01T00:00:00 --stop 2016-09-30T11:00:00 \
 *     --out rorb_resampled.bsp
 *
 * Needs the packages built (npm run build): it runs on cspice-wasm.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { createSpiceBindings } from 'cspice-wasm';

const { values: opt } = parseArgs({
  options: {
    source: { type: 'string' },
    kernels: { type: 'string', default: '' },
    target: { type: 'string' },
    center: { type: 'string' },
    frame: { type: 'string', default: 'J2000' },
    step: { type: 'string', default: '600' },
    degree: { type: 'string', default: '7' },
    'jump-m': { type: 'string', default: '1' },
    'jump-mm-s': { type: 'string', default: '1' },
    start: { type: 'string' },
    stop: { type: 'string' },
    out: { type: 'string' },
    verify: { type: 'string', default: '20000' },
    'max-error-m': { type: 'string', default: '25' },
  },
});
for (const k of ['source', 'target', 'center', 'out']) {
  if (!opt[k]) {
    console.error(`resample-spk: --${k} is required`);
    process.exit(2);
  }
}
const STEP = Number(opt.step);
const DEGREE = Number(opt.degree);
const JUMP_KM = Number(opt['jump-m']) / 1000;
const JUMP_KM_S = Number(opt['jump-mm-s']) / 1e6;
const MAX_ERR_KM = Number(opt['max-error-m']) / 1000;
const EPS = 1e-3; // s: either side of a boundary

// ── DAF reading: just enough to list a Type 19 segment's interval boundaries ──

/** Segment summaries of an SPK: [start, end] ET plus the six integers. */
function spkSegments(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const locfmt = new TextDecoder().decode(bytes.subarray(88, 96));
  if (locfmt !== 'LTL-IEEE') throw new Error(`only little-endian DAFs are read here (${locfmt})`);
  const nd = dv.getInt32(8, true);
  const ni = dv.getInt32(12, true);
  const ss = nd + Math.ceil(ni / 2);
  const segs = [];
  let rec = dv.getInt32(76, true);
  while (rec > 0) {
    const base = (rec - 1) * 1024;
    const next = dv.getFloat64(base, true);
    const nsum = dv.getFloat64(base + 16, true);
    for (let i = 0; i < nsum; i++) {
      const at = base + 24 + i * ss * 8;
      const dc = [dv.getFloat64(at, true), dv.getFloat64(at + 8, true)];
      const ic = [];
      for (let j = 0; j < ni; j++) ic.push(dv.getInt32(at + nd * 8 + j * 4, true));
      segs.push({ start: dc[0], end: dc[1], body: ic[0], center: ic[1], frame: ic[2], type: ic[3], begin: ic[4], stop: ic[5] });
    }
    rec = next;
  }
  return { segs, word: (addr) => dv.getFloat64((addr - 1) * 8, true) };
}

/**
 * The N+1 interval boundaries of a Type 19 segment. Its tail is, from the end:
 * N, the boundary flag, N+1 minisegment pointers, a directory of every 100th
 * boundary, then the N+1 boundaries. The directory length is found rather than
 * assumed: the one that yields increasing boundaries spanning the segment.
 */
function type19Boundaries(seg, word) {
  const n = Math.round(word(seg.stop));
  const ptrEnd = seg.stop - 2;
  const ptrBegin = ptrEnd - n;
  for (const dir of new Set([Math.floor((n - 1) / 100), Math.floor(n / 100), Math.floor((n + 1) / 100)])) {
    const end = ptrBegin - 1 - dir;
    const begin = end - n;
    const b = [];
    for (let a = begin; a <= end; a++) b.push(word(a));
    const increasing = b.every((v, i) => i === 0 || v > b[i - 1]);
    if (increasing && Math.abs(b[0] - seg.start) < 1 && Math.abs(b[n] - seg.end) < 1) return b;
  }
  throw new Error(`could not read the Type 19 interval table of segment ${seg.start}..${seg.end}`);
}

// ── SPICE ──

const spice = await createSpiceBindings();
const furnish = (path) => spice.furnsh(basename(path), new Uint8Array(readFileSync(path)));
for (const k of opt.kernels.split(',').filter(Boolean)) furnish(k);
furnish(opt.source);

const state = (et) => {
  const s = spice.spkezr(opt.target, et, opt.frame, 'NONE', opt.center);
  return [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z];
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const srcBytes = new Uint8Array(readFileSync(opt.source));
const { segs, word } = spkSegments(srcBytes);
const targetId = spice.bodn2c(opt.target) ?? Number(opt.target);
const mine = segs.filter((s) => s.body === targetId);
if (mine.length === 0) throw new Error(`${opt.source} has no segment for ${opt.target}`);

const start = opt.start ? spice.str2et(opt.start) : Math.min(...mine.map((s) => s.start));
const stop = opt.stop ? spice.str2et(opt.stop) : Math.max(...mine.map((s) => s.end));

// Candidate breaks: every Type 19 interval boundary, and every segment edge.
const candidates = new Set();
for (const s of mine) {
  candidates.add(s.start);
  candidates.add(s.end);
  if (s.type === 19) for (const b of type19Boundaries(s, word)) candidates.add(b);
}
const inside = [...candidates].filter((t) => t > start + EPS && t < stop - EPS).sort((a, b) => a - b);
// A break is a jump in position (an orbit-determination update) or in velocity
// (an impulsive manoeuvre): Hermite interpolation would smooth either into
// motion that never happened.
const dvel = (a, b) => Math.hypot(a[3] - b[3], a[4] - b[4], a[5] - b[5]);
// The state just before is carried across the 2·EPS gap by its own velocity
// first: heliocentric motion alone covers ~60 m in 2 ms, which is not a jump.
const jumps = inside.filter((t) => {
  const a = state(t - EPS);
  const b = state(t + EPS);
  const carried = [a[0] + a[3] * 2 * EPS, a[1] + a[4] * 2 * EPS, a[2] + a[5] * 2 * EPS];
  return dist(carried, b) > JUMP_KM || dvel(a, b) > JUMP_KM_S;
});
console.log(
  `resample-spk: ${inside.length} source boundaries in the window; ${jumps.length} are breaks ` +
    `(position > ${opt['jump-m']} m or velocity > ${opt['jump-mm-s']} mm/s)`,
);

// ── Sample each smooth piece ──

const edges = [start, ...jumps, stop];
const epochs = [];
const states = [];
const breaks = [];
for (let i = 0; i + 1 < edges.length; i++) {
  const a = edges[i];
  const b = edges[i + 1];
  if (i > 0) breaks.push(epochs.length);
  const count = Math.max(2, Math.ceil((b - a) / STEP) + 1);
  for (let k = 0; k < count; k++) {
    const t = k === count - 1 ? b : a + ((b - a) * k) / (count - 1);
    // The last sample of a piece is the state just before its closing jump,
    // carried to the jump epoch; the first of the next piece is just after.
    let s;
    if (k === count - 1 && i + 1 < edges.length - 1) {
      const before = state(t - EPS);
      s = [before[0] + before[3] * EPS, before[1] + before[4] * EPS, before[2] + before[5] * EPS, before[3], before[4], before[5]];
    } else {
      s = state(t);
    }
    epochs.push(t);
    states.push(...s);
  }
}
const centerId = spice.bodn2c(opt.center) ?? Number(opt.center);
const outName = basename(opt.out);
spice.writeSpkType13(
  outName, targetId, centerId, opt.frame, `RESAMPLED ${basename(opt.source)}`.slice(0, 40), DEGREE,
  new Float64Array(epochs), new Float64Array(states), breaks,
);
const outBytes = spice.readKernelBytes(outName);
// writeSpkType13 furnishes what it wrote; the source instance must answer from
// the source alone, or the check below compares the output with itself.
spice.unload(outName);
writeFileSync(opt.out, outBytes);
console.log(`resample-spk: ${epochs.length} samples in ${breaks.length + 1} segments -> ${opt.out} (${(outBytes.length / 1e6).toFixed(1)} MB)`);

// ── Verify against the source in an independent instance ──

const check = await createSpiceBindings();
for (const k of opt.kernels.split(',').filter(Boolean)) check.furnsh(basename(k), new Uint8Array(readFileSync(k)));
check.furnsh(outName, outBytes);
const resampled = (et) => {
  const p = check.spkpos(opt.target, et, opt.frame, 'NONE', opt.center).position;
  return [p.x, p.y, p.z];
};
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const probes = [];
for (let i = 0; i < Number(opt.verify); i++) probes.push(start + rand() * (stop - start));
for (const j of jumps) probes.push(j - 30, j - 2 * EPS, j + 2 * EPS, j + 30);
let worst = 0;
let worstAt = start;
const errs = [];
for (const t of probes) {
  if (t <= start || t >= stop) continue;
  const e = dist(state(t), resampled(t));
  errs.push(e);
  if (e > worst) { worst = e; worstAt = t; }
}
errs.sort((a, b) => a - b);
const pct = (p) => (errs[Math.floor(p * (errs.length - 1))] * 1000).toFixed(3);
console.log(
  `resample-spk: verified at ${errs.length} epochs: median ${pct(0.5)} m, p99 ${pct(0.99)} m, ` +
    `max ${(worst * 1000).toFixed(2)} m at ${spice.et2utc(worstAt, 'ISOC', 0)}`,
);
if (worst > MAX_ERR_KM) {
  console.error(`resample-spk: worst error exceeds --max-error-m ${opt['max-error-m']}; not using the result`);
  process.exit(1);
}
