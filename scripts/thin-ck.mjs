#!/usr/bin/env node
/**
 * Thin an attitude history into a compact CK Type 3, to a stated angular
 * tolerance, and prove the result against the source.
 *
 * Why: mission CKs are written for science, at a rate a viewer does not need.
 * Rosetta's solar-array CKs are ~250 MB for the mission, yet each array is a
 * single gimbal angle that mostly sits still between slews; its HGA is two such
 * angles. A CK Type 3 interpolates between records at a constant rate (a slerp),
 * so any stretch the attitude follows that closely enough needs only its two
 * ends. Sampling the source densely and keeping only the records a slerp cannot
 * skip reproduces it to the tolerance at a small fraction of the size — the same
 * idea resample-spk.mjs applies to an ephemeris.
 *
 * The attitude sampled is whatever SPICE answers for `--frame` relative to
 * `--ref` with every `--kernels` CK loaded, in the order given — later files
 * take precedence, exactly as they would in the viewer — so overlapping
 * versions of a reconstruction merge into one history. Gaps in coverage stay
 * gaps: each covered stretch is its own interpolation interval.
 *
 * Each record also carries the source's angular velocity, so state
 * transformations through the frame (spkezr, sxform) work on the output as they
 * do on the source.
 *
 * The output is furnished into a second SPICE instance and compared with the
 * source at random epochs; the script fails if the worst error exceeds 1.5×
 * the tolerance, or if a state transformation through the output fails.
 *
 * Usage:
 *   node scripts/thin-ck.mjs \
 *     --kernels NAIF0011.TLS,ROS_160929_STEP.TSC,ROS_V38.TF,ROS_SA_2014_V0048.BC \
 *     --inst=-226015 --frame ROS_SA+Y --ref ROS_SA+Y_ZERO \
 *     --step 60 --tol-deg 0.25 --out ros_sapy.bc
 *
 * Needs the packages built (npm run build): it runs on cspice-wasm.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { createSpiceBindings } from 'cspice-wasm';

const { values: opt } = parseArgs({
  options: {
    kernels: { type: 'string' },
    inst: { type: 'string' },
    frame: { type: 'string' },
    ref: { type: 'string' },
    // Optional: by default the clock the frame kernel assigns to --inst.
    sclk: { type: 'string' },
    step: { type: 'string', default: '60' },
    'tol-deg': { type: 'string', default: '0.25' },
    start: { type: 'string' },
    stop: { type: 'string' },
    out: { type: 'string' },
    verify: { type: 'string', default: '20000' },
  },
});
for (const k of ['kernels', 'inst', 'frame', 'ref', 'out']) {
  if (!opt[k]) {
    console.error(`thin-ck: --${k} is required`);
    process.exit(2);
  }
}
const INST = Number(opt.inst);
const STEP = Number(opt.step);
const TOL = (Number(opt['tol-deg']) * Math.PI) / 180;
const kernels = opt.kernels.split(',').filter(Boolean);
const isCk = (p) => /\.bc$/i.test(p);

/**
 * The clock a CK for INST is read with, which is also the one it must be
 * written with: `CK_<inst>_SCLK` from the text kernels, else SPICE's own
 * default of the instrument ID divided by 1000. Getting this wrong is not an
 * error SPICE reports — it shifts every record by the clocks' offset (81 s for
 * 67P's frame against Rosetta's clock), which the verification below catches.
 */
function sclkFor(inst) {
  if (opt.sclk) return Number(opt.sclk);
  const re = new RegExp(`CK_${inst}_SCLK\\s*=\\s*(-?\\d+)`);
  for (const k of kernels) {
    if (!/\.(tf|ti|tpc|tsc|tm)$/i.test(k)) continue;
    const m = readFileSync(k, 'latin1').match(re);
    if (m) return Number(m[1]);
  }
  return Math.trunc(inst / 1000);
}
const SCLK = sclkFor(INST);

const load = async (paths) => {
  const s = await createSpiceBindings();
  for (const p of paths) s.furnsh(basename(p), new Uint8Array(readFileSync(p)));
  return s;
};
const spice = await load(kernels);

/** Source attitude as a SPICE quaternion [w, x, y, z], or null in a gap. */
const quat = (s, et) => {
  try {
    return s.m2q(s.pxform(opt.ref, opt.frame, et));
  } catch {
    return null;
  }
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
/** Rotation angle between two unit quaternions. */
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(dot(a, b))));
function slerp(a, b, u) {
  let d = dot(a, b);
  const bb = d < 0 ? b.map((v) => -v) : b;
  d = Math.abs(d);
  if (d > 1 - 1e-12) return a.map((v, i) => v + (bb[i] - v) * u);
  const om = Math.acos(d);
  const s0 = Math.sin((1 - u) * om) / Math.sin(om);
  const s1 = Math.sin(u * om) / Math.sin(om);
  return a.map((v, i) => s0 * v + s1 * bb[i]);
}

const start = opt.start ? spice.str2et(opt.start) : -Infinity;
const stop = opt.stop ? spice.str2et(opt.stop) : Infinity;
const coverage = spice
  .ckCoverageAll(INST, { level: 'INTERVAL' })
  .map(([a, b]) => [Math.max(a, start), Math.min(b, stop)])
  .filter(([a, b]) => b > a);
if (coverage.length === 0) throw new Error(`thin-ck: no CK coverage for ${INST} in the window`);

// ── Sample each covered stretch; a failed pxform (a gap inside it) splits it ──

const pieces = [];
for (const [a, b] of coverage) {
  let cur = null;
  const n = Math.max(1, Math.ceil((b - a) / STEP));
  for (let k = 0; k <= n; k++) {
    const t = k === n ? b : a + k * STEP;
    const q = quat(spice, t);
    if (!q) {
      if (cur && cur.t.length >= 2) pieces.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { t: [], q: [] };
    const prev = cur.q[cur.q.length - 1];
    cur.q.push(prev && dot(prev, q) < 0 ? q.map((v) => -v) : q);
    cur.t.push(t);
  }
  if (cur && cur.t.length >= 2) pieces.push(cur);
}

/**
 * Refine a piece wherever the motion between neighbouring samples is not the
 * steady rotation a slerp would draw: a fast slew, or a step between the
 * source's interpolation intervals, can hide inside one --step. The midpoint is
 * sampled; if it strays from the slerp by more than TOL/4 the gap is bisected
 * (to 0.5 s) so the thinning below sees the real motion. A steady spin — a
 * comet's, or a slow array turn — passes the test and costs nothing.
 */
function refine(p) {
  const t = [p.t[0]];
  const q = [p.q[0]];
  const fill = (ta, qa, tb, qb, depth) => {
    if (depth > 12 || tb - ta < 0.5) return;
    const tm = (ta + tb) / 2;
    let qm = quat(spice, tm);
    if (!qm) return;
    if (dot(qa, qm) < 0) qm = qm.map((v) => -v);
    if (angle(slerp(qa, qb, 0.5), qm) <= TOL / 4) return;
    fill(ta, qa, tm, qm, depth + 1);
    t.push(tm);
    q.push(qm);
    fill(tm, qm, tb, qb, depth + 1);
  };
  for (let k = 1; k < p.t.length; k++) {
    fill(p.t[k - 1], p.q[k - 1], p.t[k], p.q[k], 0);
    t.push(p.t[k]);
    q.push(p.q[k]);
  }
  return { t, q };
}
for (let i = 0; i < pieces.length; i++) pieces[i] = refine(pieces[i]);

/** Whether a slerp from sample i to sample j stays within TOL of every sample between. */
function spans(p, i, j) {
  for (let m = i + 1; m < j; m++) {
    const u = (p.t[m] - p.t[i]) / (p.t[j] - p.t[i]);
    if (angle(slerp(p.q[i], p.q[j], u), p.q[m]) > TOL) return false;
  }
  return true;
}

// Greedy thinning, galloping then bisecting for how far each record can reach.
/**
 * Angular velocity of --frame relative to --ref, in --ref axes — what a CK
 * record carries (rad/s). It is not needed for orientation, but it is for any
 * state transformation through the frame: a Philae ephemeris stated in 67P's
 * body frame, or a solar-array offset stated in the spacecraft's, cannot be
 * turned into a velocity without it, and spkezr then fails where spkpos would
 * not. Taken from the source's sxform; differenced from pxform if the source
 * carries none.
 */
function angularVelocity(t, t0, t1) {
  let C;
  let dC;
  try {
    const xf = spice.sxform(opt.ref, opt.frame, t);
    C = [xf[0], xf[1], xf[2], xf[6], xf[7], xf[8], xf[12], xf[13], xf[14]];
    dC = [xf[18], xf[19], xf[20], xf[24], xf[25], xf[26], xf[30], xf[31], xf[32]];
  } catch {
    const h = 0.5;
    const a = Math.max(t0, t - h);
    const b = Math.min(t1, t + h);
    const Ca = spice.pxform(opt.ref, opt.frame, a);
    const Cb = spice.pxform(opt.ref, opt.frame, b);
    C = spice.pxform(opt.ref, opt.frame, t);
    dC = Ca.map((v, i) => (Cb[i] - v) / (b - a));
  }
  // dC/dt = -[w]x C with w in the instrument frame: [w]x = -dC C^T.
  const W = (i, j) => -(dC[i * 3] * C[j * 3] + dC[i * 3 + 1] * C[j * 3 + 1] + dC[i * 3 + 2] * C[j * 3 + 2]);
  const wi = [W(2, 1), W(0, 2), W(1, 0)];
  // Into reference-frame axes: w_ref = C^T w_inst.
  return [0, 1, 2].map((j) => C[j] * wi[0] + C[3 + j] * wi[1] + C[6 + j] * wi[2]);
}

const sclkdp = [];
const quats = [];
const avvs = [];
const starts = [];
let samples = 0;
for (const p of pieces) {
  samples += p.t.length;
  const keep = [0];
  let i = 0;
  const last = p.t.length - 1;
  while (i < last) {
    let good = i + 1;
    let stride = 1;
    let bad = -1;
    while (true) {
      const j = Math.min(i + stride * 2, last);
      if (j === good) break;
      if (spans(p, i, j)) {
        good = j;
        if (j === last) break;
        stride *= 2;
      } else {
        bad = j;
        break;
      }
    }
    if (bad > 0) {
      while (bad - good > 1) {
        const mid = (good + bad) >> 1;
        if (spans(p, i, mid)) good = mid;
        else bad = mid;
      }
    }
    keep.push(good);
    i = good;
  }
  starts.push(spice.sce2c(SCLK, p.t[0]));
  const t0 = p.t[0];
  const t1 = p.t[p.t.length - 1];
  for (const k of keep) {
    sclkdp.push(spice.sce2c(SCLK, p.t[k]));
    quats.push(...p.q[k]);
    avvs.push(...angularVelocity(p.t[k], t0, t1));
  }
}

const outName = basename(opt.out);
spice.writeCk03(
  outName, INST, opt.ref, `THINNED ${opt.frame}`.slice(0, 40),
  new Float64Array(sclkdp), new Float64Array(quats), new Float64Array(avvs), new Float64Array(starts),
);
const outBytes = spice.readKernelBytes(outName);
// writeCk03 furnishes what it wrote; the source instance must answer from the
// source alone, or the check below compares the output with itself.
spice.unload(outName);
writeFileSync(opt.out, outBytes);
console.log(
  `thin-ck: ${opt.frame} (clock ${SCLK}): ${samples} samples in ${pieces.length} covered stretches -> ${sclkdp.length} records, ` +
    `${opt.out} (${(outBytes.length / 1e6).toFixed(2)} MB)`,
);

// ── Verify in an independent instance holding only the output CK ──

const check = await load(kernels.filter((k) => !isCk(k)));
check.furnsh(outName, outBytes);
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
let worst = 0;
let worstAt = 0;
let probed = 0;
const total = pieces.reduce((s, p) => s + (p.t[p.t.length - 1] - p.t[0]), 0);
for (let n = 0; n < Number(opt.verify); n++) {
  // Pick a covered stretch in proportion to its length, then a time inside it.
  let r = rand() * total;
  const p = pieces.find((pc) => (r -= pc.t[pc.t.length - 1] - pc.t[0]) <= 0) ?? pieces[pieces.length - 1];
  const t = p.t[0] + rand() * (p.t[p.t.length - 1] - p.t[0]);
  const a = quat(spice, t);
  const b = quat(check, t);
  if (!a || !b) continue;
  probed++;
  const e = angle(a, b);
  if (e > worst) { worst = e; worstAt = t; }
}
// The velocity path works too: a state transformation through the output
// frame must succeed wherever an orientation does.
let sxformFailures = 0;
for (let n = 0; n < 200; n++) {
  const p = pieces[Math.floor(rand() * pieces.length)];
  const t = p.t[0] + rand() * (p.t[p.t.length - 1] - p.t[0]);
  try { check.sxform(opt.ref, opt.frame, t); } catch { sxformFailures++; }
}
if (sxformFailures > 0) {
  console.error(`thin-ck: sxform through the output failed at ${sxformFailures}/200 epochs; angular velocity is missing`);
  process.exit(1);
}
const deg = (x) => ((x * 180) / Math.PI).toFixed(3);
console.log(`thin-ck: verified at ${probed} epochs: max ${deg(worst)} deg at ${spice.et2utc(worstAt, 'ISOC', 0)}`);
if (worst > 1.5 * TOL) {
  console.error(`thin-ck: worst error exceeds 1.5 x --tol-deg ${opt['tol-deg']}; not using the result`);
  process.exit(1);
}
