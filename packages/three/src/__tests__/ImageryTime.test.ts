import { describe, expect, it } from 'vitest';
import {
  dayNumber, dayString, utcDay, parseTimeExtent, resolveImageryTime, ImageryTimeFollower,
  type ImageryTemporalConfig, type ImageryAvailability,
} from '../ImageryTime.js';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-11-06T12:00:00Z');
const RANGE: ImageryAvailability = { start: '2002-07-04', end: '2026-11-05' };

describe('day arithmetic', () => {
  it('round-trips real calendar days and rejects impossible ones', () => {
    expect(dayString(dayNumber('2024-02-29')!)).toBe('2024-02-29');
    expect(dayNumber('2025-02-29')).toBeNull();
    expect(dayNumber('2026-13-01')).toBeNull();
    expect(dayNumber('yesterday')).toBeNull();
    expect(dayNumber(undefined)).toBeNull();
  });

  it('takes the UTC day of an instant, not the local one', () => {
    expect(utcDay(at('2026-03-01T23:59:59.999Z'))).toBe('2026-03-01');
    expect(utcDay(at('2026-03-02T00:00:00Z'))).toBe('2026-03-02');
    expect(utcDay(NaN)).toBeNull();
    // Years the tile services cannot spell are unavailable, not "+275760-09-13".
    expect(utcDay(8.64e15)).toBeNull();
  });
});

describe('parseTimeExtent', () => {
  it('reads GIBS-style daily intervals and single days', () => {
    expect(parseTimeExtent(['2002-07-04/2026-11-05/P1D'])).toEqual({ start: '2002-07-04', end: '2026-11-05' });
    expect(parseTimeExtent(['2020-01-01', '2019-01-01/2019-06-30/P1D'])).toEqual({ start: '2019-01-01', end: '2020-01-01' });
  });

  it('ignores coarser cadences and unreadable entries', () => {
    expect(parseTimeExtent(['2020-01-01/2020-12-01/P1M'])).toBeNull();
    expect(parseTimeExtent(['soon'])).toBeNull();
    expect(parseTimeExtent([])).toBeNull();
  });
});

describe('resolveImageryTime', () => {
  const base: ImageryTemporalConfig = {};

  it('follows the simulation UTC day', () => {
    const r = resolveImageryTime(base, 'follow-simulation', null, at('2021-07-05T09:00:08Z'), RANGE, NOW);
    expect(r).toMatchObject({ requested: '2021-07-05', date: '2021-07-05', state: 'exact', offsetDays: 0 });
  });

  it('shows a fixed date whatever the simulation says, and never swaps it', () => {
    const fixed = (date: string) => resolveImageryTime({ outOfRange: 'nearest' }, 'fixed', date, at('1999-01-01T00:00:00Z'), RANGE, NOW);
    expect(fixed('2024-06-01')).toMatchObject({ date: '2024-06-01', state: 'exact' });
    // `nearest` is a follow-mode convenience; an explicit date outside the range shows nothing.
    expect(fixed('1990-01-01')).toMatchObject({ date: null, state: 'before-range' });
  });

  it('shows nothing before the first day or after the last, by default', () => {
    expect(resolveImageryTime(base, 'follow-simulation', null, at('1998-01-01T00:00:00Z'), RANGE, NOW))
      .toMatchObject({ date: null, state: 'before-range', requested: '1998-01-01' });
    expect(resolveImageryTime(base, 'follow-simulation', null, at('2026-11-05T23:00:00Z'), RANGE, NOW))
      .toMatchObject({ date: '2026-11-05', state: 'exact' });
    expect(resolveImageryTime(base, 'follow-simulation', null, at('2026-11-06T01:00:00Z'), RANGE, NOW))
      .toMatchObject({ date: null, state: 'after-range' });
  });

  it('labels the nearest day with its offset when asked for it', () => {
    const cfg = { outOfRange: 'nearest' as const };
    const before = resolveImageryTime(cfg, 'follow-simulation', null, at('2002-07-01T00:00:00Z'), RANGE, NOW);
    expect(before).toMatchObject({ date: '2002-07-04', requested: '2002-07-01', state: 'nearest', offsetDays: 3 });
    const after = resolveImageryTime(cfg, 'follow-simulation', null, at('2026-11-10T00:00:00Z'), RANGE, NOW);
    expect(after).toMatchObject({ date: '2026-11-05', requested: '2026-11-10', state: 'nearest', offsetDays: -5 });
  });

  it('never displays a day later than the wall clock can have published', () => {
    // No declared end at all: the clock and the latency are the only bound.
    const cfg = { latencyDays: 1 };
    expect(resolveImageryTime(cfg, 'follow-simulation', null, at('2026-11-05T10:00:00Z'), { start: null, end: null }, NOW))
      .toMatchObject({ date: '2026-11-05', state: 'exact' });
    expect(resolveImageryTime(cfg, 'follow-simulation', null, at('2026-11-06T10:00:00Z'), { start: null, end: null }, NOW))
      .toMatchObject({ date: null, state: 'not-yet-published' });
    expect(resolveImageryTime({}, 'follow-simulation', null, at('2030-01-01T00:00:00Z'), { start: null, end: null }, NOW))
      .toMatchObject({ date: null, state: 'not-yet-published' });
  });

  it('resolves `latest` only from a provider-declared end', () => {
    expect(resolveImageryTime(base, 'latest', null, null, RANGE, NOW)).toMatchObject({ date: '2026-11-05', state: 'exact' });
    expect(resolveImageryTime(base, 'latest', null, null, { start: null, end: null }, NOW)).toMatchObject({ date: null, state: 'invalid' });
  });

  it('is invalid for unusable dates and a missing simulation time', () => {
    expect(resolveImageryTime(base, 'fixed', 'soon', null, RANGE, NOW)).toMatchObject({ date: null, state: 'invalid' });
    expect(resolveImageryTime(base, 'fixed', null, null, RANGE, NOW)).toMatchObject({ date: null, state: 'invalid' });
    expect(resolveImageryTime(base, 'follow-simulation', null, null, RANGE, NOW)).toMatchObject({ date: null, state: 'invalid' });
  });
});

describe('ImageryTimeFollower', () => {
  const throttle = { settleMs: 400, minIntervalMs: 1000, maxWaitMs: 3000 };
  const sim = (iso: string) => resolveImageryTime({}, 'follow-simulation', null, at(iso), RANGE, NOW);

  it('commits the first resolution at once', () => {
    const f = new ImageryTimeFollower(throttle);
    expect(f.offer(sim('2021-07-05T00:00:00Z'), 0)?.date).toBe('2021-07-05');
    expect(f.commits).toBe(1);
  });

  it('does not commit again while the same day holds, but keeps `requested` current', () => {
    const f = new ImageryTimeFollower(throttle);
    f.offer(sim('2021-07-05T01:00:00Z'), 0);
    expect(f.offer(sim('2021-07-05T23:00:00Z'), 5000)).toBeNull();
    expect(f.commits).toBe(1);
  });

  it('debounces a new day until it settles', () => {
    const f = new ImageryTimeFollower(throttle);
    f.offer(sim('2021-07-05T00:00:00Z'), 0);
    expect(f.offer(sim('2021-07-06T00:00:00Z'), 1100)).toBeNull();
    expect(f.pending).toBe(true);
    expect(f.offer(sim('2021-07-06T00:00:00Z'), 1400)).toBeNull();
    expect(f.offer(sim('2021-07-06T00:00:00Z'), 1500)?.date).toBe('2021-07-06');
    expect(f.pending).toBe(false);
  });

  it('bounds requests during rapid scrubbing and playback', () => {
    const f = new ImageryTimeFollower(throttle);
    let day = at('2021-01-01T00:00:00Z');
    // One new UTC day every frame (16 ms) for ten seconds: about 625 day buckets.
    for (let t = 0; t <= 10_000; t += 16) {
      f.offer(sim(new Date(day).toISOString()), t);
      day += 86_400_000;
    }
    // Never more than one commit per maxWait window (plus the first).
    expect(f.commits).toBeLessThanOrEqual(1 + Math.ceil(10_000 / throttle.maxWaitMs));
    expect(f.commits).toBeGreaterThan(1);
  });

  it('commits the day a scrub stops on', () => {
    const f = new ImageryTimeFollower(throttle);
    f.offer(sim('2021-01-01T00:00:00Z'), 0);
    for (let t = 16; t < 500; t += 16) f.offer(sim(new Date(at('2021-01-01T00:00:00Z') + t * 864e5).toISOString()), t);
    const target = sim('2022-03-03T00:00:00Z');
    let committed = null;
    for (let t = 500; t < 2200 && !committed; t += 16) committed = f.offer(target, t);
    expect(committed?.date).toBe('2022-03-03');
  });

  it('treats a hidden-state change as a commit so stale imagery is removed', () => {
    const f = new ImageryTimeFollower(throttle);
    f.offer(sim('2026-11-05T00:00:00Z'), 0);
    const gone = f.offer(sim('2026-11-09T00:00:00Z'), 3500);
    expect(gone).toMatchObject({ date: null, state: 'not-yet-published' });
  });

  it('applies an explicit choice immediately and only when it changes the source', () => {
    const f = new ImageryTimeFollower(throttle);
    f.offer(sim('2021-07-05T00:00:00Z'), 0);
    const fixed = resolveImageryTime({}, 'fixed', '2020-02-02', null, RANGE, NOW);
    expect(f.force(fixed, 10)?.date).toBe('2020-02-02');
    expect(f.force(fixed, 20)).toBeNull();
    expect(f.commits).toBe(2);
  });
});
