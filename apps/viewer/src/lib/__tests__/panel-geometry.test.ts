import { describe, it, expect } from 'vitest';
import {
  clampFloat, moveFloat, resizeFloat, floatFromDocked,
  MIN_PANEL_W, MIN_PANEL_H, KEEP_VISIBLE_X, KEEP_VISIBLE_Y,
} from '../panel-geometry';

/**
 * The constraint that matters: a panel the user drags must stay reachable. A
 * floating panel whose header leaves the viewport cannot be dragged back, and
 * recovering it would need a "reset layout" command that this shell
 * deliberately does not have.
 */

const viewport = { width: 1440, height: 900 };
const panel = { x: 400, y: 300, w: 360, h: 400 };

describe('clampFloat', () => {
  it('leaves a panel already inside the viewport alone', () => {
    expect(clampFloat(panel, viewport)).toEqual(panel);
  });

  it('keeps a grabbable strip on screen when dragged off the right edge', () => {
    const r = clampFloat({ ...panel, x: 5000 }, viewport);
    expect(r.x).toBe(viewport.width - KEEP_VISIBLE_X);
    expect(r.x).toBeLessThan(viewport.width);
  });

  it('keeps a grabbable strip on screen when dragged off the left edge', () => {
    const r = clampFloat({ ...panel, x: -5000 }, viewport);
    expect(r.x + r.w).toBeGreaterThanOrEqual(KEEP_VISIBLE_X);
  });

  it('never lets the header go above the top edge, where nothing could grab it', () => {
    expect(clampFloat({ ...panel, y: -200 }, viewport).y).toBe(0);
  });

  it('keeps the header on screen when dragged off the bottom', () => {
    const r = clampFloat({ ...panel, y: 5000 }, viewport);
    expect(r.y).toBe(viewport.height - KEEP_VISIBLE_Y);
  });

  it('refuses to shrink a panel below its own chrome', () => {
    const r = clampFloat({ ...panel, w: 10, h: 10 }, viewport);
    expect(r.w).toBe(MIN_PANEL_W);
    expect(r.h).toBe(MIN_PANEL_H);
  });

  it('caps a panel at the viewport rather than letting it exceed it', () => {
    const r = clampFloat({ ...panel, w: 99_999, h: 99_999 }, viewport);
    expect(r.w).toBe(viewport.width);
    expect(r.h).toBe(viewport.height);
  });

  it('still produces a reachable panel on a viewport smaller than the minimum', () => {
    // A phone-sized window with a desktop-sized rect: the size floor wins over
    // the viewport, so there must still be a legal position rather than a
    // clamp range with no values in it.
    const tiny = { width: 120, height: 90 };
    const r = clampFloat(panel, tiny);
    expect(r.w).toBe(MIN_PANEL_W);
    expect(r.h).toBe(MIN_PANEL_H);
    expect(r.x).toBeLessThanOrEqual(Math.max(0, tiny.width - KEEP_VISIBLE_X));
    expect(r.y).toBeGreaterThanOrEqual(0);
  });
});

describe('moveFloat', () => {
  it('applies the delta to where the gesture started, not to the last frame', () => {
    // Deltas are measured from the gesture's origin every frame, so the same
    // delta twice is the same result — a drag cannot accumulate drift.
    expect(moveFloat(panel, 50, -20, viewport)).toEqual(moveFloat(panel, 50, -20, viewport));
    expect(moveFloat(panel, 50, -20, viewport)).toMatchObject({ x: 450, y: 280 });
  });

  it('clamps as it goes, so a fast drag cannot overshoot off-screen', () => {
    expect(moveFloat(panel, 9999, 9999, viewport).x).toBe(viewport.width - KEEP_VISIBLE_X);
  });
});

describe('resizeFloat', () => {
  it('grows away from the origin, so the header stays put under the pointer', () => {
    const r = resizeFloat(panel, 100, 50, viewport);
    expect(r).toMatchObject({ x: panel.x, y: panel.y, w: 460, h: 450 });
  });

  it('stops at the minimum instead of inverting', () => {
    const r = resizeFloat(panel, -9999, -9999, viewport);
    expect(r.w).toBe(MIN_PANEL_W);
    expect(r.h).toBe(MIN_PANEL_H);
  });
});

describe('floatFromDocked', () => {
  it('floats a panel exactly where it was docked, so it is picked up, not moved', () => {
    const box = { x: 49, y: 10, w: 384, h: 382 };
    expect(floatFromDocked(box, viewport)).toEqual(box);
  });
});
