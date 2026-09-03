/**
 * Epoch parsing must not depend on the machine that runs it.
 *
 * The bug these tests exist to catch: `Date.parse` reads an offset-less
 * date-time as LOCAL time, so a naive catalog epoch produced a different
 * ephemeris time in every timezone, while the SPICE `str2et` path read the same
 * string as UTC. It stayed hidden for three months because the committed
 * `analytical-no-spice` golden was generated in US Pacific summer and the suite
 * only ever ran there — the scene was 7 hours and 738,151 km of Earth orbit off
 * anywhere else.
 *
 * Note what is NOT done here: no test imports the value under test to check it.
 * Each expectation states the UTC instant independently, via `Date.UTC`, so a
 * wrong parse cannot agree with a wrong expectation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { utcMsFromCalendarString, approxEtFromCalendarString, J2000_UNIX_MS_APPROX } from '../time.js';

/** Run `fn` with `process.env.TZ` set, restoring it afterwards.
 *
 *  Node reads TZ per `Date` construction, so this genuinely changes parsing
 *  behavior mid-process — which is what makes the invariance claim testable
 *  rather than merely asserted. */
function inTimezone<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

const ZONES = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Eucla'];

afterEach(() => {
  delete process.env.TZ;
});

describe('utcMsFromCalendarString', () => {
  it('reads a naive date-time as UTC, in every timezone', () => {
    const expected = Date.UTC(2004, 6, 1, 2, 48, 0);
    for (const tz of ZONES) {
      expect(inTimezone(tz, () => utcMsFromCalendarString('2004-07-01T02:48:00')), tz).toBe(expected);
    }
  });

  it('stays sensitive to the defect it guards', () => {
    // If this ever stops holding, the environment no longer reproduces the bug
    // and the invariance test above has quietly become vacuous.
    const local = inTimezone('America/Los_Angeles', () => Date.parse('2004-07-01T02:48:00'));
    const utc = Date.UTC(2004, 6, 1, 2, 48, 0);
    expect(local - utc).toBe(7 * 3600 * 1000);
  });

  it('honors an explicit designator or offset rather than overriding it', () => {
    expect(utcMsFromCalendarString('2004-07-01T02:48:00Z')).toBe(Date.UTC(2004, 6, 1, 2, 48, 0));
    expect(utcMsFromCalendarString('2004-07-01T02:48:00+02:00')).toBe(Date.UTC(2004, 6, 1, 0, 48, 0));
    expect(utcMsFromCalendarString('2004-07-01T02:48:00-0700')).toBe(Date.UTC(2004, 6, 1, 9, 48, 0));
  });

  it('keeps sub-second precision', () => {
    expect(utcMsFromCalendarString('2004-07-01T02:48:00.331')).toBe(Date.UTC(2004, 6, 1, 2, 48, 0, 331));
  });

  it('leaves a date-only form alone (already UTC per spec)', () => {
    for (const tz of ZONES) {
      expect(inTimezone(tz, () => utcMsFromCalendarString('2004-07-01')), tz).toBe(Date.UTC(2004, 6, 1));
    }
  });

  it('accepts the space-separated form SPICE also writes', () => {
    for (const tz of ZONES) {
      expect(inTimezone(tz, () => utcMsFromCalendarString('2004-07-01 02:48:00')), tz).toBe(
        Date.UTC(2004, 6, 1, 2, 48, 0),
      );
    }
  });

  it('returns NaN for an unparseable string, like Date.parse', () => {
    expect(utcMsFromCalendarString('not a time')).toBeNaN();
    // Day-of-year form: SPICE takes it, Date.parse does not. NaN lets the
    // caller fall back or report rather than silently reading epoch 0.
    expect(utcMsFromCalendarString('2004-183T02:48:00')).toBeNaN();
  });

  it('tolerates surrounding whitespace', () => {
    expect(utcMsFromCalendarString('  2004-07-01T02:48:00  ')).toBe(Date.UTC(2004, 6, 1, 2, 48, 0));
  });
});

describe('approxEtFromCalendarString', () => {
  it('is seconds past the J2000 epoch, timezone-independent', () => {
    const et = approxEtFromCalendarString('2004-07-01T02:48:00');
    expect(et).toBe((Date.UTC(2004, 6, 1, 2, 48, 0) - Date.UTC(2000, 0, 1, 12, 0, 0)) / 1000);
    for (const tz of ZONES) {
      expect(inTimezone(tz, () => approxEtFromCalendarString('2004-07-01T02:48:00')), tz).toBe(et);
    }
  });

  it('is zero at the J2000 epoch itself', () => {
    expect(approxEtFromCalendarString('2000-01-01T12:00:00')).toBe(0);
  });

  it('propagates NaN rather than reporting epoch 0', () => {
    expect(approxEtFromCalendarString('not a time')).toBeNaN();
  });

  it('names the TDB offset it does not model', () => {
    // The real J2000 epoch is 2000-01-01T12:00:00 TDB = 11:58:55.816 UTC. This
    // fallback treats it as 12:00:00 UTC, so it runs 64.184 s off — which is
    // why str2et is always preferred, and is pinned here so the size of the
    // approximation is visible rather than folk knowledge.
    const exact = Date.UTC(2000, 0, 1, 11, 58, 55, 816);
    expect((J2000_UNIX_MS_APPROX - exact) / 1000).toBeCloseTo(64.184, 3);
  });
});
