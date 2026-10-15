import { beforeEach, describe, expect, it } from 'vitest';
import { vs, zoomScrubber } from '../viewer-state.svelte';
import { timelineFraction } from '../timeline.svelte';
import { inWindow, windowFollowing, windowFraction } from '../scrubber-math';

/**
 * One axis, one playhead: every row derives the playhead's position from the
 * same unclamped fraction, so when the zoomed window leaves the playhead
 * behind, the track and the lanes agree that it is out of view.
 */
describe('timeline axis', () => {
  beforeEach(() => {
    vs.scrubBaseMin = 0;
    vs.scrubBaseMax = 1000;
    vs.scrubMin = 0;
    vs.scrubMax = 1000;
    vs.et = 100;
  });

  it('zooms about a pointer far from the playhead, leaving the playhead out of view', () => {
    for (let i = 0; i < 10; i++) zoomScrubber(true, 900);

    expect(vs.scrubMin).toBeLessThan(900);
    expect(vs.scrubMax).toBeGreaterThan(900);
    expect(vs.scrubMin).toBeGreaterThan(vs.et);
    // Out of view — not pinned to the left edge, where it would read as a
    // time it is not at.
    expect(timelineFraction(vs.et)).toBeLessThan(0);
    expect(inWindow(timelineFraction(vs.et))).toBe(false);
  });

  it('keeps the playhead in view when the zoom has no pointer to anchor on', () => {
    for (let i = 0; i < 10; i++) zoomScrubber(true);
    expect(inWindow(timelineFraction(vs.et))).toBe(true);
  });

  it('reports fractions unclamped, and treats only [0, 1] as on screen', () => {
    expect(windowFraction(150, 100, 200)).toBe(0.5);
    expect(windowFraction(50, 100, 200)).toBe(-0.5);
    expect(windowFraction(250, 100, 200)).toBe(1.5);
    expect(inWindow(0)).toBe(true);
    expect(inWindow(1)).toBe(true);
    expect(inWindow(1.01)).toBe(false);
    expect(inWindow(null)).toBe(false);
  });
});

/**
 * Jumping the playhead — selecting an event on the track, typing a time, a
 * script's `setTime` — must not throw away the user's zoom.
 */
describe('window following a jump', () => {
  const base = { min: 0, max: 10_000 };

  it('leaves a zoomed window alone when the new time is already in view', () => {
    expect(windowFollowing(1500, { min: 1000, max: 2000 }, base)).toEqual({ min: 1000, max: 2000 });
  });

  it('slides the window, keeping its span, to centre an off-screen time', () => {
    expect(windowFollowing(6000, { min: 1000, max: 2000 }, base)).toEqual({ min: 5500, max: 6500 });
  });

  it('stops at the base range’s edges rather than showing time outside it', () => {
    expect(windowFollowing(9900, { min: 1000, max: 2000 }, base)).toEqual({ min: 9000, max: 10_000 });
    expect(windowFollowing(100, { min: 5000, max: 6000 }, base)).toEqual({ min: 0, max: 1000 });
  });

  it('asks for a rebuilt range when the new time is outside the base', () => {
    expect(windowFollowing(20_000, { min: 1000, max: 2000 }, base)).toBeNull();
    expect(windowFollowing(NaN, { min: 1000, max: 2000 }, base)).toBeNull();
    expect(windowFollowing(500, { min: 0, max: 0 }, { min: 0, max: 0 })).toBeNull();
  });
});
