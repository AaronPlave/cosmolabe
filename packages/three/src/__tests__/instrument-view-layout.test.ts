import { describe, expect, it } from 'vitest';
import { fitImageRect, intersectRect } from '../InstrumentView.js';

describe('instrument image layout', () => {
  it('letterboxes a wide instrument and pillarboxes a tall one without changing its aspect', () => {
    expect(fitImageRect(400, 400, 2)).toEqual({ x: 0, y: 100, w: 400, h: 200 });
    expect(fitImageRect(400, 400, 0.5)).toEqual({ x: 100, y: 0, w: 200, h: 400 });
    const r = fitImageRect(437, 291, 1.37);
    expect(r.w / r.h).toBeCloseTo(1.37, 10);
  });

  it('clips the image to what is on screen, and to nothing when they miss', () => {
    expect(intersectRect({ x: -10, y: 5, w: 50, h: 50 }, { x: 0, y: 0, w: 30, h: 20 }))
      .toEqual({ x: 0, y: 5, w: 30, h: 15 });
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBeNull();
  });
});
