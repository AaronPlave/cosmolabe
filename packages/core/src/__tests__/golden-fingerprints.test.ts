/**
 * Layer 2 — golden scene-fingerprint snapshots.
 *
 * For each registered scene, recompute the deterministic fingerprint and diff
 * it against a committed golden JSON with per-field tolerances. Catches
 * regressions in positions/orientations across ALL trajectory + rotation paths
 * (including analytical ones SPICE can't oracle), and pins the structural
 * wiring (parent / sourceFrame / trajectoryFrame) exactly.
 *
 * Regenerate after an intentional change:
 *   UPDATE_GOLDENS=1 npx vitest run golden-fingerprints   # rewrite existing goldens
 *   CREATE_GOLDENS=1 npx vitest run golden-fingerprints   # write a NEW scene's golden
 * then review the JSON diff before committing.
 *
 * Creating and rewriting are separate flags, and a writing run reports its
 * comparisons as SKIPPED rather than passed. Both matter for the same reason:
 * `UPDATE_GOLDENS=1` used to make this file report four green tests while
 * asserting nothing at all — the comparison returned early and "golden file
 * exists" was satisfied by the file `beforeAll` had just written. A green run
 * that has verified zero is worse than a red one (issue #20). Under UPDATE a
 * *missing* golden still fails, because that is the renamed-scene case and it
 * must not self-baseline.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SCENES, buildScene } from './_harness/scenes.js';
import {
  fingerprintScene,
  serializeFingerprint,
  type SceneFingerprint,
  type BodyFingerprint,
} from './_harness/fingerprint.js';

const GOLDEN_DIR = join(__dirname, '__goldens__');
const UPDATE = process.env.UPDATE_GOLDENS === '1';
const CREATE = process.env.CREATE_GOLDENS === '1';
/** Any run that writes a golden has, by definition, not checked one. */
const WRITING = UPDATE || CREATE;

// Tolerances: goldens are same-machine deterministic, so deltas come only from
// JSON rounding (1e-6 km / 1e-9 quat). These are well above that and well below
// any meaningful regression.
const POS_TOL_KM = 1e-3; // 1 m
const QUAT_TOL_DEG = 1e-4;

function norm(v: number[]): number {
  return Math.hypot(...v);
}
function quatAngleDeg(a: number[], b: number[]): number {
  // Sign-invariant angle between two quaternions (handles q vs -q). Divide by
  // the norms so 1e-9-rounded (slightly sub-unit) goldens don't inject a
  // spurious angle — identical quats must read as exactly 0°.
  const na = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  const nb = Math.hypot(b[0], b[1], b[2], b[3]) || 1;
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (na * nb);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

function compareBody(actual: BodyFingerprint, golden: BodyFingerprint) {
  expect(actual.parent, `${actual.name} parent`).toBe(golden.parent);
  expect(actual.trajectoryFrame, `${actual.name} trajectoryFrame`).toBe(golden.trajectoryFrame);
  expect(actual.sourceFrame, `${actual.name} sourceFrame`).toBe(golden.sourceFrame);

  // Position-less bodies (rings, barycenters with no trajectory) serialize as
  // null/NaN. Compare finiteness structurally; numeric drift only when finite.
  const gFinite = golden.absolutePosition.every((n) => Number.isFinite(n));
  const aFinite = actual.absolutePosition.every((n) => Number.isFinite(n));
  expect(aFinite, `${actual.name} position finiteness`).toBe(gFinite);
  if (gFinite) {
    const dPos = norm([
      actual.absolutePosition[0] - golden.absolutePosition[0],
      actual.absolutePosition[1] - golden.absolutePosition[1],
      actual.absolutePosition[2] - golden.absolutePosition[2],
    ]);
    expect(dPos, `${actual.name} position drift (km)`).toBeLessThan(POS_TOL_KM);
  }

  if (golden.bodyToWorldQuat === null) {
    expect(actual.bodyToWorldQuat, `${actual.name} quat`).toBeNull();
  } else {
    expect(actual.bodyToWorldQuat, `${actual.name} quat`).not.toBeNull();
    expect(
      quatAngleDeg(actual.bodyToWorldQuat!, golden.bodyToWorldQuat),
      `${actual.name} orientation drift (deg)`,
    ).toBeLessThan(QUAT_TOL_DEG);
  }
}

describe('golden fingerprints', () => {
  for (const sceneName of Object.keys(SCENES)) {
    describe(sceneName, () => {
      let actual: SceneFingerprint;
      const goldenPath = join(GOLDEN_DIR, `${sceneName}.json`);

      beforeAll(async () => {
        actual = fingerprintScene(await buildScene(sceneName), sceneName);
        // Rewriting what is there is UPDATE's job; bringing a new file into
        // existence is CREATE's. Neither does the other's.
        if (existsSync(goldenPath) ? UPDATE : CREATE) {
          if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
          writeFileSync(goldenPath, serializeFingerprint(actual));
        }
      }, 30000);

      // Not skipped under UPDATE: a golden that has gone missing while someone
      // is rewriting goldens means a scene was renamed, and the old file is now
      // orphaned. Creating it is CREATE's decision to make, explicitly.
      it.skipIf(CREATE)('golden file exists (run CREATE_GOLDENS=1 to create)', () => {
        expect(existsSync(goldenPath), `missing golden ${goldenPath}`).toBe(true);
      });

      it.skipIf(WRITING)('matches the committed golden', () => {
        const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as SceneFingerprint;

        // Same body set, same order.
        expect(actual.bodies.map((b) => b.name)).toEqual(golden.bodies.map((b) => b.name));
        for (let i = 0; i < golden.bodies.length; i++) compareBody(actual.bodies[i], golden.bodies[i]);

        // Trajectory samples.
        expect(actual.trajectories.map((t) => t.name)).toEqual(golden.trajectories.map((t) => t.name));
        for (let i = 0; i < golden.trajectories.length; i++) {
          const at = actual.trajectories[i];
          const gt = golden.trajectories[i];
          for (let k = 0; k < gt.samples.length; k++) {
            const d = norm([
              at.samples[k][0] - gt.samples[k][0],
              at.samples[k][1] - gt.samples[k][1],
              at.samples[k][2] - gt.samples[k][2],
            ]);
            expect(d, `${gt.name} sample[${k}] drift (km)`).toBeLessThan(POS_TOL_KM);
          }
        }
      });
    });
  }
});
