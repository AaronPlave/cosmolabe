import { describe, it, expect } from 'vitest';
import {
  etToDate,
  dateToEt,
  etToIso,
  etToJulianComponents,
  julianComponentsToEt,
  etIntervalToIso,
} from '../TimeConversions.js';

describe('TimeConversions', () => {
  it('etToDate at ET=0 returns J2000 epoch', () => {
    const date = etToDate(0);
    // J2000 = 2000-01-01T11:58:55.816 UTC (TDB-TAI offset accounted for in J2000_UNIX_MS)
    expect(date.getUTCFullYear()).toBe(2000);
    expect(date.getUTCMonth()).toBe(0); // January
    expect(date.getUTCDate()).toBe(1);
    expect(date.getUTCHours()).toBe(11);
    expect(date.getUTCMinutes()).toBe(58);
  });

  it('dateToEt roundtrips with etToDate', () => {
    const originalEt = 86400; // 1 day after J2000
    const date = etToDate(originalEt);
    const recoveredEt = dateToEt(date);
    expect(recoveredEt).toBeCloseTo(originalEt, 3);
  });

  it('etToIso returns valid ISO string', () => {
    const iso = etToIso(0);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(iso).toContain('Z');
  });

  it('etToIso at known epoch produces expected date', () => {
    // 1 day = 86400 seconds. At ET=86400 we should be on Jan 2, 2000.
    const oneDayEt = 86400;
    const iso = etToIso(oneDayEt);
    expect(iso).toContain('2000-01-02');
  });

  it('julianComponentsToEt roundtrips with etToJulianComponents', () => {
    const originalEt = 123456.789;
    const { dayNumber, secondsOfDay } = etToJulianComponents(originalEt);
    const recoveredEt = julianComponentsToEt(dayNumber, secondsOfDay);
    expect(recoveredEt).toBeCloseTo(originalEt, 3);
  });

  it('etToJulianComponents at ET=0 returns J2000 Julian Day', () => {
    const { dayNumber, secondsOfDay } = etToJulianComponents(0);
    // At ET=0 (TDB), TAI is about 32.184 seconds earlier
    // Julian Day 2451545.0 is J2000 in TDB
    // After converting to TAI: 2451545.0 - 32.184/86400
    expect(dayNumber).toBe(2451544);
    // secondsOfDay should be close to 86400 - 32.184 = 86367.816
    expect(secondsOfDay).toBeCloseTo(86400 - 32.184, 3);
  });

  it('etIntervalToIso produces start/end format', () => {
    const result = etIntervalToIso(0, 86400);
    expect(result).toContain('/');
    const [start, end] = result.split('/');
    expect(start).toMatch(/^\d{4}-\d{2}/);
    expect(end).toMatch(/^\d{4}-\d{2}/);
  });

  it('handles negative ET (before J2000)', () => {
    const date = etToDate(-86400);
    expect(date.getUTCFullYear()).toBe(1999);
    expect(date.getUTCMonth()).toBe(11); // December
    expect(date.getUTCDate()).toBe(31);
  });
});
