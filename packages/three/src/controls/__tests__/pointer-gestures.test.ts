/**
 * Gesture math for touch camera navigation (issue #72).
 *
 * The camera controls used to bind mouse events only, so a phone could look at
 * the scene and not navigate it. `TouchGestureTracker` is the piece that turns
 * raw contacts into the one-finger drag and two-finger pinch/pan the modes
 * consume; it is deliberately DOM-free so this runs without a browser.
 */
import { describe, it, expect } from 'vitest';
import { TouchGestureTracker, pinchToWheelDelta } from '../PointerInput.js';

interface Recorded {
  drags: Array<[number, number]>;
  pinches: Array<[number, number, number]>;
  counts: Array<[number, number, number]>;
}

function tracker() {
  const rec: Recorded = { drags: [], pinches: [], counts: [] };
  const t = new TouchGestureTracker({
    onDrag: (dx, dy) => rec.drags.push([dx, dy]),
    onPinch: (scale, dx, dy) => rec.pinches.push([scale, dx, dy]),
    onCountChange: (n, x, y) => rec.counts.push([n, x, y]),
  });
  const at = (pointerId: number, clientX: number, clientY: number) => ({ pointerId, clientX, clientY });
  return { t, rec, at };
}

describe('TouchGestureTracker', () => {
  it('reports one-finger movement as incremental drag deltas', () => {
    const { t, rec, at } = tracker();
    t.down(at(1, 100, 100));
    t.move(at(1, 110, 90));
    t.move(at(1, 115, 90));

    expect(rec.drags).toEqual([[10, -10], [5, 0]]);
    expect(rec.pinches).toEqual([]);
  });

  it('reports the first move after touchdown against the touchdown point, not the origin', () => {
    const { t, rec, at } = tracker();
    t.down(at(1, 500, 400));
    t.move(at(1, 502, 400));

    // The bug this guards: seeding from (0,0) makes the first drag a 500px jump.
    expect(rec.drags).toEqual([[2, 0]]);
  });

  it('separates a pinch from the centroid pan in a two-finger gesture', () => {
    const { t, rec, at } = tracker();
    t.down(at(1, 100, 100));
    t.down(at(2, 200, 100));
    // Spread to twice the distance, and slide the pair 10px right. A device
    // reports one move per finger, so the gesture arrives as two increments
    // whose scales multiply and whose centroid deltas add.
    t.move(at(1, 60, 100));
    t.move(at(2, 260, 100));

    const scale = rec.pinches.reduce((acc, [s]) => acc * s, 1);
    const dx = rec.pinches.reduce((acc, [, x]) => acc + x, 0);
    const dy = rec.pinches.reduce((acc, [, , y]) => acc + y, 0);
    expect(scale).toBeCloseTo(2, 6);
    expect(dx).toBeCloseTo(10, 6);
    expect(dy).toBeCloseTo(0, 6);
  });

  it('does not emit a drag for the finger that is part of a two-finger gesture', () => {
    const { t, rec, at } = tracker();
    t.down(at(1, 100, 100));
    t.down(at(2, 200, 100));
    t.move(at(1, 150, 100));

    expect(rec.drags).toEqual([]);
    expect(rec.pinches).toHaveLength(1);
  });

  it('re-anchors when a finger lifts, so the remaining finger does not jump', () => {
    const { t, rec, at } = tracker();
    t.down(at(1, 100, 100));
    t.down(at(2, 300, 100));
    t.up(at(2, 300, 100));
    t.move(at(1, 104, 100));

    // Without re-anchoring, the delta would be measured from the 200,100
    // centroid — a 96px jolt instead of the 4px the finger actually moved.
    expect(rec.drags).toEqual([[4, 0]]);
  });

  it('announces every count change with the gesture anchor', () => {
    const { t, rec, at } = tracker();
    t.down(at(1, 100, 100));
    t.down(at(2, 300, 200));
    t.up(at(1, 100, 100));
    t.up(at(2, 300, 200));

    expect(rec.counts).toEqual([
      [1, 100, 100],
      [2, 200, 150],
      [1, 300, 200],
      [0, 0, 0],
    ]);
  });

  it('drops every contact on cancel, once', () => {
    const { t, rec, at } = tracker();
    t.down(at(1, 10, 10));
    t.down(at(2, 20, 20));
    t.cancel();
    t.cancel();
    t.move(at(1, 50, 50));

    expect(t.activeCount).toBe(0);
    expect(rec.counts.at(-1)).toEqual([0, 0, 0]);
    expect(rec.counts.filter(([n]) => n === 0)).toHaveLength(1);
    expect(rec.drags).toEqual([]);
  });

  it('ignores a pointer it never saw go down', () => {
    const { t, rec, at } = tracker();
    t.move(at(9, 10, 10));
    t.up(at(9, 10, 10));

    expect(rec.drags).toEqual([]);
    expect(rec.counts).toEqual([]);
  });
});

describe('pinchToWheelDelta', () => {
  it('maps spreading fingers to a zoom-in (negative) delta and pinching to zoom-out', () => {
    expect(pinchToWheelDelta(2)).toBeLessThan(0);
    expect(pinchToWheelDelta(0.5)).toBeGreaterThan(0);
    expect(pinchToWheelDelta(1)).toBeCloseTo(0, 12);
  });

  it('is symmetric, so a pinch undoes the spread that preceded it', () => {
    expect(pinchToWheelDelta(1.5) + pinchToWheelDelta(1 / 1.5)).toBeCloseTo(0, 9);
  });

  it('compounds like the wheel it stands in for', () => {
    // Two steps of the same ratio carry the same delta as one step of the square.
    expect(2 * pinchToWheelDelta(1.2)).toBeCloseTo(pinchToWheelDelta(1.44), 9);
  });
});
