/** Unrounded independent scene expectations. Provenance: docs/spice-retirement.md. */
import { describe, it, expect, beforeAll } from 'vitest';
import { subPointOf, composeBodyToWorldQuat } from '../kinematics.js';
import { buildUniverseFromCatalog, type BuiltScene } from './_harness/buildUniverse.js';
import { SCENES } from './_harness/scenes.js';
import reference from './__fixtures__/pipeline-reference.json';

/** Quaternion sign is immaterial; chord/sum avoids acos's small-angle noise floor. */
function quatAngleArcsec(a: readonly number[], b: readonly number[]): number {
  const p = a.map(v => v / Math.hypot(...a));
  let q = b.map(v => v / Math.hypot(...b));
  if (p.reduce((sum,v,i) => sum + v*q[i]!, 0) < 0) q = q.map(v => -v);
  return 2 * Math.atan2(Math.hypot(...p.map((v,i) => v-q[i]!)),
    Math.hypot(...p.map((v,i) => v+q[i]!))) * 180 / Math.PI * 3600;
}

describe('scene pipeline against independent pinned reference', () => {
  let scene: BuiltScene;
  beforeAll(async () => {
    scene = await buildUniverseFromCatalog(SCENES['saturn-soi']!);
  }, 120_000);

  it('resolves the scene epoch and body membership exactly', () => {
    expect(scene.et).toBe(reference.et);
    expect(scene.bodyNames).toEqual(reference.bodyNames);
  });

  it('pins parent-chain positions, composed attitudes and body-fixed subpoints at five epochs', () => {
    for (const sample of reference.samples) {
      const { name, hr } = sample;
      const label = `${name} @ ${hr}h`;
      const et = reference.et + hr * 3600;
      const position = scene.universe.absolutePositionOf(name, et);
      // JSON encodes nonfinite components as null; preserve coverage assertions.
      expect(position.map(Number.isFinite), label).toEqual(sample.position.map(v => v !== null));
      if (sample.position.every(v => v !== null)) {
        expect(Math.hypot(...position.map((v,i) => v-sample.position[i]!)), label).toBeLessThan(1e-6);
      }
      const body = scene.universe.getBody(name)!;
      const q = body.rotationAt(et);
      const orientation = q && body.rotation ? composeBodyToWorldQuat(q,body.rotation.sourceFrame) : null;
      expect(!!orientation,label).toBe(!!sample.orientation);
      if (orientation && sample.orientation) {
        expect(quatAngleArcsec(orientation,sample.orientation),label).toBeLessThan(1e-3);
      }
      const point = subPointOf(n => scene.universe.getBody(n),name,et);
      expect(point === null,label).toBe(sample.subpoint === null);
      if (point && sample.subpoint) {
        for (const key of ['altKm', 'lat', 'lon'] as const) {
          const expected = sample.subpoint[key];
          expect(Number.isFinite(point[key]), `${label} ${key} coverage`).toBe(expected !== null);
          if (expected === null) continue;
          const delta = key === 'lon' ? Math.abs(((point[key]-expected+540)%360)-180)
            : Math.abs(point[key]-expected);
          expect(delta, `${label} ${key}`).toBeLessThan(key === 'altKm' ? 1e-6 : 1e-3/3600);
        }
      }
    }
  });
});
