import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkExposureMetadata } from './lib/exposure-capture.mjs';

const fixed = {
  mode: 'fixed-reference', exposure: 1 / (3.2 * 0.8 * Math.PI * (695000 / 149597870) ** 2),
  response: 'reinhard-0.94', radianceUnits: 'relative-solar-center', referenceDistanceKm: 149597870,
};
test('accepts the fixed 1 AU contract and the distinct legacy contract', () => {
  checkExposureMetadata(fixed, 'fixed');
  checkExposureMetadata({ ...fixed, mode: 'legacy-observer-adapted', exposure: null }, 'legacy');
});
test('rejects a missing hook result, wrong policy, changed multiplier or display contract', () => {
  for (const metadata of [undefined, { ...fixed, mode: 'legacy-observer-adapted' },
    { ...fixed, exposure: fixed.exposure * 2 }, { ...fixed, response: 'aces' },
    { ...fixed, referenceDistanceKm: 1 }, { ...fixed, radianceUnits: 'SI' }]) {
    assert.throws(() => checkExposureMetadata(metadata, 'fixed'));
  }
  assert.throws(() => checkExposureMetadata(fixed, 'legacy'));
});
