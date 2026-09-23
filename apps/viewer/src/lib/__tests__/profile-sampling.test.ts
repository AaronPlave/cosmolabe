import { describe, expect, it } from 'vitest';
import {
  PROFILE_QUANTITIES,
  plotBounds,
  profilePath,
  profileQuantity,
  quantityAt,
  sampleCountFor,
  sampleProfile,
  formatRangeRate,
  type PositionOf,
} from '../profile-sampling';
import { snapFraction } from '../scrubber-math';

/**
 * A kernel-free two-body scene: the target moves along +x at 1 km/s through a
 * closest approach of 100 km at et = 0; the Sun sits far off along +y. This is
 * the point of the profile sampler — plain positions, no SPICE.
 */
const positionOf: PositionOf = (body, et) => {
  if (body === 'Probe') return [0, 0, 0];
  if (body === 'Rock') return [et, 100, 0];
  if (body === 'Sun') return [0, 1e8, 0];
  return [NaN, NaN, NaN];
};
const bodies = { observer: 'Probe', target: 'Rock' };
const spec = (id: string) => profileQuantity(id)!;

describe('profile quantities', () => {
  it('starts from the four quantities the ruler had, under shared-model ids', () => {
    expect(PROFILE_QUANTITIES.map((q) => q.id)).toEqual(['range', 'relative-speed', 'range-rate', 'phase-angle']);
  });

  it('computes range, speed, range rate and phase angle from positions alone', () => {
    expect(quantityAt('range', bodies, 0, positionOf)).toBeCloseTo(100);
    expect(quantityAt('range', bodies, 100, positionOf)).toBeCloseTo(Math.hypot(100, 100));
    expect(quantityAt('relative-speed', bodies, 50, positionOf)).toBeCloseTo(1);
    // Closing before the approach, opening after, zero at it.
    expect(quantityAt('range-rate', bodies, -100, positionOf)!).toBeLessThan(0);
    expect(quantityAt('range-rate', bodies, 0, positionOf)).toBeCloseTo(0);
    expect(quantityAt('range-rate', bodies, 100, positionOf)!).toBeGreaterThan(0);
    // At et = 0 the Sun and the observer are on opposite sides of the target.
    expect(quantityAt('phase-angle', bodies, 0, positionOf)).toBeCloseTo(180, 3);
  });

  it('reports a gap rather than a number where a body has no state', () => {
    expect(quantityAt('range', { observer: 'Probe', target: 'Nowhere' }, 0, positionOf)).toBeNull();
    expect(quantityAt('range', { observer: 'Probe', target: 'Probe' }, 0, positionOf)).toBeNull();
    expect(quantityAt('phase-angle', { ...bodies, illuminator: 'Nowhere' }, 0, positionOf)).toBeNull();
  });

  it('signs range rate so closing reads as negative', () => {
    expect(formatRangeRate(-0.5)).toBe('−500.0 m/s');
    expect(formatRangeRate(2)).toBe('+2.00 km/s');
  });
});

describe('profile sampling', () => {
  it('samples evenly across the window with the minimum where the approach is', () => {
    const series = sampleProfile(spec('range'), bodies, { start: -1000, end: 1000 }, 201, positionOf);
    expect(series.ets).toHaveLength(201);
    expect(series.ets[0]).toBe(-1000);
    expect(series.ets[200]).toBe(1000);
    const values = series.values as number[];
    expect(values.indexOf(Math.min(...values))).toBe(100);
    expect(series.min).toBeCloseTo(100);
  });

  it('leaves instants outside the profile’s own window as gaps, and breaks the trace there', () => {
    const series = sampleProfile(spec('range'), bodies, { start: 0, end: 100 }, 11, positionOf, { start: 0, end: 50 });
    expect(series.values.slice(6).every((v) => v === null)).toBe(true);
    const gappy = { ets: [0, 1, 2, 3], values: [1, null, 2, 3], min: 0, max: 3 };
    expect(profilePath(gappy, 30, 10).match(/M/g)).toHaveLength(2);
  });

  it('keeps range rate symmetric about zero and gives a flat trace a span', () => {
    expect(plotBounds([-1, 3], true)).toEqual({ min: -3, max: 3 });
    const flat = plotBounds([5, 5], false);
    expect(flat.max).toBeGreaterThan(flat.min);
    expect(plotBounds([null, null], false)).toEqual({ min: 0, max: 0 });
  });

  it('scales display density with the pixels available, within bounds', () => {
    expect(sampleCountFor(10)).toBe(48);
    expect(sampleCountFor(600)).toBe(300);
    expect(sampleCountFor(5000)).toBe(480);
  });
});

describe('timeline event snapping', () => {
  const candidates = [{ fraction: 0.5, id: 'ca' }, { fraction: 0.52, id: 'other' }];

  it('snaps only within a few pixels, to the nearest candidate', () => {
    expect(snapFraction(0.503, candidates, 1000)?.id).toBe('ca');
    expect(snapFraction(0.518, candidates, 1000)?.id).toBe('other');
    expect(snapFraction(0.51, candidates, 1000)).toBeNull();
    expect(snapFraction(0.5, candidates, 0)).toBeNull();
  });
});
