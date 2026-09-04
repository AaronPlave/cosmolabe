/**
 * The viewer's exported camera `time`, checked against SPICE.
 *
 * This is the first test in `apps/viewer`, and it exists because the app was in
 * no gate at all — not typechecked, not tested, not built on any PR (issue #20).
 * What that cost: `camera-view-io.ts` reckoned J2000 as 2000-01-01T12:00:00 UTC
 * for the entire time #3 and #22 were removing exactly that constant from every
 * other file, and nothing anywhere could see it. `Date.UTC(2000, 0, 1, 12, 0, 0)`
 * is perfectly well-typed, so the typecheck gate added alongside this would not
 * have caught it either.
 *
 * The expectations come from `str2et` with the real naif0012.tls, not from a
 * second copy of our own arithmetic — a wrong implementation that agreed with
 * itself would still fail here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Spice, type SpiceInstance } from '@cosmolabe/spice';
import { etToIso } from '../camera-view-io.js';

const LSK = join(__dirname, '../../../../../packages/spice/test-kernels/naif0012.tls');
const haveLsk = existsSync(LSK);

/** Epochs an exported view plausibly carries: the demo catalogs' own. */
const EPOCHS = [
  '2004-07-01T02:48:00Z', // cassini-soi defaultTime
  '2005-01-14T09:00:00Z', // Huygens landing
  '2017-01-01T00:00:01Z', // one second after the most recent leap insertion
  '2024-07-04T12:00:00Z', // earth-moon defaultTime
];

describe.skipIf(!haveLsk)('camera-view-io: exported time', () => {
  let spice: SpiceInstance;

  beforeAll(async () => {
    spice = await Spice.init();
    const buf = readFileSync(LSK);
    await spice.furnish({
      type: 'buffer',
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      filename: 'naif0012.tls',
    });
  });

  it.each(EPOCHS)('round-trips %s through str2et', (iso) => {
    const et = spice.str2et(iso.replace(/Z$/, ''));
    // Bounded by `Date`'s integer-millisecond resolution plus the TDB-TT
    // periodic term we deliberately do not model (peaks ~1.7 ms).
    expect(Math.abs(Date.parse(etToIso(et)) - Date.parse(iso))).toBeLessThan(3);
  });

  it('is exact where reckoning J2000 as noon UTC was 69.184 s off', () => {
    // The mutation guard. Reinstate the old constant and this fails: noon UTC
    // is 64.184 s later than the real J2000 instant, plus the five leap seconds
    // since, so the string it wrote named an epoch 69.184 s LATER than the one
    // SPICE means. The assertion pins both halves — how far off the old way
    // was, and that we are not off that way.
    const iso = '2024-07-04T12:00:00Z';
    const et = spice.str2et(iso.replace(/Z$/, ''));
    const noonReckoning = Date.UTC(2000, 0, 1, 12, 0, 0) + et * 1000;
    expect((noonReckoning - Date.parse(iso)) / 1000).toBeCloseTo(69.184, 2);
    expect(Math.abs(Date.parse(etToIso(et)) - Date.parse(iso))).toBeLessThan(3);
  });

  it('falls back to now rather than emitting a bogus epoch', () => {
    for (const bad of [NaN, Infinity, 1e10]) {
      expect(Date.parse(etToIso(bad))).toBeCloseTo(Date.now(), -4);
    }
  });
});
