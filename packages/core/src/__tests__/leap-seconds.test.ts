/**
 * The SPICE-free epoch path, checked against SPICE itself.
 *
 * `etFromCalendarString` exists for the configuration that has no leapseconds
 * kernel furnished — a shipping path, not a theoretical one, since the
 * SPICE-free demo build reaches it for every string epoch in a catalog. It used
 * to be `approxEtFromCalendarString`, reckoning ET as elapsed UTC from noon and
 * so wrong by TAI-UTC plus the TT term: 64.184 s at J2000, growing to 69.184 s
 * by 2024. #3 removed the constant 64.184 s; this removes the rest.
 *
 * The point of these tests is that they do NOT assert self-consistency. Each
 * expectation comes from `str2et` with the real `naif0012.tls` furnished, so
 * the table is checked against the authority it is standing in for. A table
 * that agreed with a wrong implementation would still fail here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Spice, type SpiceInstance } from '@cosmolabe/spice';
import { etFromCalendarString, deltaAtSeconds, etToDate, etFromDate } from '../time.js';

const LSK = join(__dirname, '../../../spice/test-kernels/naif0012.tls');
const haveLsk = existsSync(LSK);

/** Epochs spanning the table: before the first leap second, across several
 *  insertions, at J2000 itself, and after the most recent (2017) one. */
const EPOCHS = [
  '1972-01-01T00:00:00Z', // the first entry in the table
  '1977-09-05T12:56:00Z', // Voyager 1 launch — a real catalog epoch here
  '1990-06-15T03:00:00Z',
  '1999-12-31T23:59:00Z',
  '2000-01-01T11:58:55Z', // the J2000 instant, near enough
  '2000-01-01T12:00:00Z',
  '2004-07-01T02:48:00Z', // Cassini SOI
  '2005-01-14T09:00:00Z', // Huygens landing
  '2012-07-01T00:00:01Z', // one second after a leap insertion
  '2016-12-31T23:59:59Z', // one second before the most recent insertion
  '2017-01-01T00:00:01Z', // one second after it
  '2024-01-01T00:00:00Z',
  '2031-03-06T00:00:00Z', // beyond the table, exercising the clamp-forward
];

describe.skipIf(!haveLsk)('etFromCalendarString vs SPICE str2et', () => {
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

  it.each(EPOCHS)('matches str2et for %s', epoch => {
    const truth = spice.str2et(epoch.replace(/Z$/, ''));
    const ours = etFromCalendarString(epoch);
    // Millisecond agreement. The only thing we deliberately do not model is
    // the TDB-TT periodic term, which peaks around 1.7 ms.
    expect(ours).toBeCloseTo(truth, 2);
  });

  it('is exact where the old approximation was seconds off', () => {
    // Regression guard for the specific numbers in issue #12's table: reckoning
    // ET as elapsed UTC from noon was 69.184 s off at 2024, of which #3 fixed
    // 64.184 s and this fixes the remaining 5.
    const epoch = '2024-01-01T00:00:00Z';
    const truth = spice.str2et(epoch.replace(/Z$/, ''));
    const noonReckoning = (Date.parse(epoch) - Date.UTC(2000, 0, 1, 12, 0, 0)) / 1000;
    expect(truth - noonReckoning).toBeCloseTo(69.184, 2);
    expect(Math.abs(truth - etFromCalendarString(epoch))).toBeLessThan(0.01);
  });

  it('round-trips ET -> Date -> ET across a leap-second boundary', () => {
    for (const epoch of EPOCHS) {
      const et = spice.str2et(epoch.replace(/Z$/, ''));
      // Bounded by `Date`'s own resolution: it stores integer milliseconds,
      // so an ET carrying sub-millisecond detail cannot survive the trip
      // through one. Worst case is one full millisecond of truncation.
      // Asserting tighter would be claiming precision the representation
      // does not have.
      expect(Math.abs(etFromDate(etToDate(et)) - et)).toBeLessThan(0.0011);
    }
  });

  it('agrees with the LSK on every DELTA_AT step in the table', () => {
    // str2et of a UTC instant minus the same instant read as TDB gives TT-UTC,
    // which is ΔAT + 32.184. Checking each step boundary catches an off-by-one
    // day or a transposed value in the table.
    for (const year of [1972, 1980, 1990, 1999, 2006, 2009, 2012, 2015, 2017, 2024]) {
      // Space, not "T": str2et rejects a system token appended to an ISO "T"
      // string but accepts one on the calendar form. Same quirk documented in
      // OemAdapter.oemEpochToEt.
      const cal = `${year}-06-15 00:00:00`;
      const utcEt = spice.str2et(cal);
      const tdbEt = spice.str2et(`${cal} TDB`);
      const ttMinusUtc = utcEt - tdbEt;
      expect(deltaAtSeconds(Date.parse(`${cal.replace(' ', 'T')}Z`)) + 32.184).toBeCloseTo(ttMinusUtc, 2);
    }
  });
});

describe.skipIf(!haveLsk)('pre-1972 is a documented limitation, not a silent one', () => {
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

  it('is within ~1.1 s before 1972, where UTC ran on rubber seconds', () => {
    // Before 1972-01-01 UTC was steered by a rate offset rather than integer
    // leap seconds, and the LSK models that; the table clamps to the 1972
    // value instead. The gap is about a second. No catalog in this repo has a
    // pre-1972 epoch (Voyager 1, the earliest, is 1977), so the clamp is
    // deliberate — but it is asserted here so it stays a known bound rather
    // than becoming a surprise.
    const truth = spice.str2et('1970-01-01T00:00:00');
    const err = Math.abs(etFromCalendarString('1970-01-01T00:00:00Z') - truth);
    expect(err).toBeGreaterThan(0.5);
    expect(err).toBeLessThan(1.5);
  });
});

describe('etFromCalendarString without SPICE', () => {
  it('returns NaN for an unparseable string rather than 0', () => {
    // 0 is J2000, not a neutral value. Coercing failure to 0 is how an
    // unreadable epoch silently moved a body to 2000-01-01.
    expect(etFromCalendarString('2004-183T12:00:00')).toBeNaN();
    expect(etFromCalendarString('not a date')).toBeNaN();
  });

  it('reads a naive epoch as UTC, not local time', () => {
    expect(etFromCalendarString('2024-01-01T00:00:00')).toBe(
      etFromCalendarString('2024-01-01T00:00:00Z'),
    );
  });

  it('reports the documented leap-second counts', () => {
    expect(deltaAtSeconds(Date.UTC(1998, 5, 1))).toBe(31); // before the 1999-01-01 step
    expect(deltaAtSeconds(Date.UTC(2000, 0, 1))).toBe(32);
    expect(deltaAtSeconds(Date.UTC(2024, 0, 1))).toBe(37);
  });
});
