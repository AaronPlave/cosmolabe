/**
 * Pipeline-mode parity: the same scene built twice, once on each CSPICE build,
 * compared through the core's own machinery rather than at the SPICE call.
 *
 * The distinction from packages/frames/src/differential.test.ts matters. That
 * file proves *call* parity — identical answers to identical CSPICE calls. This
 * one proves parity *through* the pipeline that consumes those answers:
 * absolutePositionOf's parent-chain accumulation and per-leg frame alignment,
 * composeBodyToWorldQuat's obliquity composition, subPointOf's body-fixed
 * unwrap. A difference too small to see at the call can be amplified by a chain
 * walk, and a frame or epoch discrepancy that call parity misses shows up here
 * as a position that lands somewhere else.
 *
 * It also measures what golden-fingerprints.test.ts structurally cannot: the
 * goldens round positions to 1e-6 km and quaternions to 9 decimals, so they can
 * only report "no shift larger than the rounding quantum". This compares
 * unrounded doubles and reports the actual worst-case deltas, so the size of any
 * shift is a number we can look at rather than infer.
 *
 * Measured 2026-09-02, saturn-soi, 10 bodies x 5 epochs: every delta exactly
 * zero — position, orientation, and sub-point alike. Not "within tolerance";
 * the doubles are bit-identical. Run with `--reporter=verbose` to see the
 * per-body table, since vitest suppresses stdout for passing tests.
 *
 * The one observable difference between the engines is cosmetic: timecraftjs
 * prefixes thrown SPICE messages with "SPICE: " and the heritage adapter does
 * not, visible in the benign "Saturn Rings has no ephemeris" fallback warning.
 * Nothing keys off that text.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildUniverseFromCatalog, type BuiltScene } from './_harness/buildUniverse.js';
import { SCENES } from './_harness/scenes.js';
import { composeBodyToWorldQuat } from '../kinematics.js';

/** Hours from the scene epoch — the same spread the goldens sample, so a
 *  trajectory-frame divergence has room to open up. */
const SAMPLE_OFFSETS_HR = [-12, -6, 0, 6, 12];

/** Tripwires. Set at the golden fingerprints' own rounding quantum (1e-6 km =
 *  1 mm) and an equivalently tight pointing bound, not at the "close enough to
 *  render" level: the whole point is to notice a real change in the numbers,
 *  and upstream measured this at the 0.1 mm noise floor. If a legitimate
 *  difference ever pushes past these, that is a deliberate re-baseline with the
 *  deltas reviewed, not a threshold to widen. */
const POSITION_TRIPWIRE_KM = 1e-6;
const POINTING_TRIPWIRE_ARCSEC = 1e-3;

/** Angle between two unit quaternions, in arcseconds.
 *
 *  Uses the half-angle tangent form rather than 2*acos(dot). acos is useless at
 *  the precision this test cares about: for dot = 1 - eps its derivative is
 *  unbounded, so a dot one ulp below 1.0 returns 2*sqrt(2*eps) ~ 8.7e-3 arcsec
 *  — a floor that has nothing to do with the inputs. Two *bit-identical*
 *  quaternion pairs can land on either side of that ulp and appear to differ by
 *  what looks like a real pointing error. atan2 of the chord against the sum
 *  stays accurate all the way down to zero, which is where the answers here
 *  actually live. */
function quatAngleArcsec(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const na = Math.hypot(...a) || 1;
  const nb = Math.hypot(...b) || 1;
  const p: number[] = [a[0] / na, a[1] / na, a[2] / na, a[3] / na];
  let q: number[] = [b[0] / nb, b[1] / nb, b[2] / nb, b[3] / nb];
  // q and -q are the same rotation; align signs before differencing.
  const dot = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
  if (dot < 0) q = q.map((v) => -v);
  const diff = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2], p[3] - q[3]);
  const sum = Math.hypot(p[0] + q[0], p[1] + q[1], p[2] + q[2], p[3] + q[3]);
  return 2 * Math.atan2(diff, sum) * (180 / Math.PI) * 3600;
}

interface Worst {
  label: string;
  value: number;
}

function track(worst: Worst, label: string, value: number): void {
  if (value > worst.value) {
    worst.value = value;
    worst.label = label;
  }
}

describe('pipeline parity: cspice-wasm vs timecraftjs through the core', () => {
  let legacy: BuiltScene;
  let harvested: BuiltScene;

  beforeAll(async () => {
    const def = SCENES['saturn-soi']!;
    const opts = {
      catalog: def.catalog,
      kernels: def.kernels,
      defaultTime: def.defaultTime,
    };
    legacy = await buildUniverseFromCatalog({ ...opts, engine: 'timecraftjs' });
    harvested = await buildUniverseFromCatalog({ ...opts, engine: 'cspice-wasm' });
  }, 120_000);

  it('resolves the scene epoch identically', () => {
    expect(harvested.et).toBe(legacy.et);
    expect(harvested.bodyNames).toEqual(legacy.bodyNames);
  });

  it('places every body identically through the parent-chain accumulation', () => {
    const worst: Worst = { label: 'none', value: 0 };
    const perBody: string[] = [];

    for (const name of legacy.bodyNames) {
      let bodyWorst = 0;
      for (const hr of SAMPLE_OFFSETS_HR) {
        const t = legacy.et + hr * 3600;
        const a = legacy.universe.absolutePositionOf(name, t);
        const b = harvested.universe.absolutePositionOf(name, t);
        // NaN is a legitimate answer (out of coverage) but both must agree on it.
        const aNaN = a.some(Number.isNaN);
        const bNaN = b.some(Number.isNaN);
        expect(bNaN, `${name} @${hr}h: coverage disagreement`).toBe(aNaN);
        if (aNaN) continue;
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        bodyWorst = Math.max(bodyWorst, d);
        track(worst, `${name} @${hr}h`, d);
      }
      perBody.push(`${name.padEnd(16)} ${(bodyWorst * 1e6).toFixed(3).padStart(12)} mm`);
    }

    console.log(
      '\n  position delta, worst over ' + SAMPLE_OFFSETS_HR.length + ' epochs per body:\n' +
      perBody.map((l) => '    ' + l).join('\n') +
      `\n    worst overall: ${(worst.value * 1e6).toFixed(6)} mm (${worst.label})\n`,
    );
    expect(worst.value, `worst position delta (${worst.label})`).toBeLessThan(POSITION_TRIPWIRE_KM);
  });

  it('composes every body-to-world orientation identically', () => {
    const worst: Worst = { label: 'none', value: 0 };
    const rows: string[] = [];

    for (const name of legacy.bodyNames) {
      const lb = legacy.universe.getBody(name);
      const hb = harvested.universe.getBody(name);
      if (!lb?.rotation || !hb?.rotation) continue;
      let bodyWorst = 0;
      for (const hr of SAMPLE_OFFSETS_HR) {
        const t = legacy.et + hr * 3600;
        const lq = lb.rotationAt(t);
        const hq = hb.rotationAt(t);
        expect(!!hq, `${name} @${hr}h: one engine produced no orientation`).toBe(!!lq);
        if (!lq || !hq) continue;
        const d = quatAngleArcsec(
          composeBodyToWorldQuat(lq, lb.rotation.sourceFrame),
          composeBodyToWorldQuat(hq, hb.rotation.sourceFrame),
        );
        bodyWorst = Math.max(bodyWorst, d);
        track(worst, `${name} @${hr}h`, d);
      }
      rows.push(`${name.padEnd(16)} ${bodyWorst.toExponential(3).padStart(12)} arcsec`);
    }

    console.log(
      '\n  orientation delta, worst per body:\n' +
      rows.map((l) => '    ' + l).join('\n') +
      `\n    worst overall: ${worst.value.toExponential(6)} arcsec (${worst.label})\n`,
    );
    expect(worst.value, `worst pointing delta (${worst.label})`).toBeLessThan(
      POINTING_TRIPWIRE_ARCSEC,
    );
  });

  it('computes sub-points identically, exercising the body-fixed unwrap', () => {
    const worstAlt: Worst = { label: 'none', value: 0 };
    const worstAng: Worst = { label: 'none', value: 0 };

    for (const name of legacy.bodyNames) {
      for (const hr of SAMPLE_OFFSETS_HR) {
        const t = legacy.et + hr * 3600;
        const a = legacy.universe.subPointOf(name, t);
        const b = harvested.universe.subPointOf(name, t);
        expect(b === null, `${name} @${hr}h: subPointOf nullity disagreement`).toBe(a === null);
        if (!a || !b) continue;
        track(worstAlt, `${name} @${hr}h`, Math.abs(a.altKm - b.altKm));
        track(worstAng, `${name} @${hr}h lat`, Math.abs(a.lat - b.lat));
        // Longitude wraps; compare the shorter way round.
        const dLon = Math.abs(((a.lon - b.lon + 540) % 360) - 180);
        track(worstAng, `${name} @${hr}h lon`, dLon);
      }
    }

    console.log(
      `\n  sub-point delta: altitude ${(worstAlt.value * 1e6).toFixed(6)} mm (${worstAlt.label}),` +
      ` angle ${worstAng.value.toExponential(6)} deg (${worstAng.label})\n`,
    );
    expect(worstAlt.value, `worst sub-point altitude delta (${worstAlt.label})`).toBeLessThan(
      POSITION_TRIPWIRE_KM,
    );
    expect(worstAng.value, `worst sub-point angle delta (${worstAng.label})`).toBeLessThan(
      POINTING_TRIPWIRE_ARCSEC / 3600,
    );
  });
});
