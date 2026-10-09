import { describe, expect, it } from 'vitest';
import { frameTicks } from '../GraticuleFrame.js';

describe('regional coordinate frame', () => {
  it('tracks the same major lines continuously along edges and never duplicates a coordinate', () => {
    const sample = (offset: number) => (x: number, y: number) => ({ latDeg: y / 100 - 4 + offset, lonDeg: x / 100 - 4, incidence: 1 });
    const first = frameTicks(800, 800, [1, 1], sample(0));
    const moved = frameTicks(800, 800, [1, 1], sample(0.01));
    expect(new Set(first.map(t => `${t.axis}:${t.value}`)).size).toBe(first.length);
    expect(new Set(first.map(t => t.axis)).size).toBe(2);
    for (const t of first) {
      expect(t.value).toBe(Math.round(t.value));
      const next = moved.find(n => n.axis === t.axis && n.value === t.value)!;
      expect(next.edge).toBe(t.edge);
      if (t.axis === 'latitude') expect(next.y - t.y).toBeCloseTo(-1, 3);
    }
  });
  it('respects rotation and suppresses sky and grazing surface samples', () => {
    const rotated = frameTicks(800, 800, [1, 1], (x, y) => ({ latDeg: x / 100 - 4, lonDeg: y / 100 - 4, incidence: 1 }));
    expect(rotated.filter(t => t.axis === 'latitude').every(t => t.edge >= 2)).toBe(true);
    expect(frameTicks(800, 800, [1, 1], () => null)).toEqual([]);
    expect(frameTicks(800, 800, [1, 1], (x, y) => ({ latDeg: x, lonDeg: y, incidence: 0.2 }))).toEqual([]);
  });
  it('keeps longitude canonical through the seam', () => {
    const ticks = frameTicks(800, 800, [1, 1], (x, y) => ({ latDeg: y / 100 - 4, lonDeg: ((179 + x / 200 + 180) % 360) - 180, incidence: 1 }));
    const longs = ticks.filter(t => t.axis === 'longitude');
    expect(longs.some(t => t.value === -180)).toBe(true);
    expect(longs.every(t => t.value >= -180 && t.value < 180)).toBe(true);
  });
});
