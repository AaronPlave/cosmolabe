import assert from 'node:assert/strict';

/** Reject captures whose live renderer does not match the requested URL policy. */
export function checkExposureMetadata(metadata, mode) {
  const distance = 149597870;
  const fixed = 1 / (3.2 * 0.8 * Math.PI * (695000 / distance) ** 2);
  if (mode === 'fixed') {
    assert.ok(Number.isFinite(metadata?.exposure) &&
      Math.abs(metadata.exposure / fixed - 1) < 1e-12, 'Expected the fixed 1 AU multiplier');
  }
  assert.deepEqual(metadata, {
    mode: mode === 'fixed' ? 'fixed-reference' : 'legacy-observer-adapted',
    exposure: mode === 'fixed' ? metadata.exposure : null,
    response: 'reinhard-0.94',
    radianceUnits: 'relative-solar-center',
    referenceDistanceKm: distance,
  }, 'Live exposure metadata must match the requested reference contract');
}
