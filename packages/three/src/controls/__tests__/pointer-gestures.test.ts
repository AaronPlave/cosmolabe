/**
 * Gesture math for touch camera navigation (issue #72).
 *
 * The camera controls used to bind mouse events only, so a phone could look at
 * the scene and not navigate it. `TouchGestureTracker` is the piece that turns
 * raw contacts into the one-finger drag and two-finger pinch/pan the modes
 * consume; it is deliberately DOM-free so this runs without a browser.
 */
import { describe, it, expect } from 'vitest';
import { TouchGestureTracker, pinchZoomFactor, attachPointerInput } from '../PointerInput.js';
import type { PointerInputSpec } from '../PointerInput.js';

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

describe('pinchZoomFactor', () => {
  it('brings you `strength` times closer for a doubled finger spread', () => {
    expect(pinchZoomFactor(2)).toBeCloseTo(0.5, 9);
    expect(pinchZoomFactor(2, 3)).toBeCloseTo(1 / 3, 9);
    expect(pinchZoomFactor(4)).toBeCloseTo(0.25, 9);
    expect(pinchZoomFactor(1)).toBe(1);
  });

  it('is symmetric, so a pinch undoes the spread that preceded it', () => {
    expect(pinchZoomFactor(1.5) * pinchZoomFactor(1 / 1.5)).toBeCloseTo(1, 9);
  });

  it('is independent of how many events the gesture is split into', () => {
    // The property the wheel-curve conversion it replaced did NOT have: there,
    // log-normalizing each tiny increment made a 120-event pinch zoom several
    // times further than the same gesture delivered in 30 events — far enough
    // to put the camera underground.
    const total = (events: number) => {
      const perEvent = Math.pow(2, 1 / events);
      let factor = 1;
      for (let i = 0; i < events; i++) factor *= pinchZoomFactor(perEvent);
      return factor;
    };
    expect(total(30)).toBeCloseTo(0.5, 9);
    expect(total(120)).toBeCloseTo(0.5, 9);
  });
});

/**
 * A minimal event target pair standing in for a canvas and its window, so the
 * listener wiring can be exercised without a DOM. `attachPointerInput` resolves
 * the window through `canvas.ownerDocument.defaultView`, which is what makes
 * this possible (and is what an artifact in an iframe needs anyway).
 */
function fakeDom() {
  const make = () => {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    return {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
      emit: (type: string, e: Record<string, unknown>) => {
        for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
      },
      count: (type: string) => listeners.get(type)?.size ?? 0,
    };
  };
  const view = make();
  const canvas = Object.assign(make(), { ownerDocument: { defaultView: view } });
  return { canvas, view };
}

function attachTo(dom: ReturnType<typeof fakeDom>, spec: PointerInputSpec) {
  return attachPointerInput(dom.canvas as unknown as HTMLElement, spec);
}

const mouse = (extra: Record<string, unknown>) => ({ pointerType: 'mouse', pointerId: 1, ...extra });

describe('attachPointerInput', () => {
  it('cancels a mouse drag on pointercancel, which carries no button transition', () => {
    const dom = fakeDom();
    const seen: string[] = [];
    attachTo(dom, {
      onButtonDown: () => seen.push('down'),
      onButtonUp: () => seen.push('up'),
      onCancel: () => seen.push('cancel'),
    });

    dom.canvas.emit('pointerdown', mouse({ button: 2, clientX: 0, clientY: 0 }));
    // Palm rejection, device deactivation and the like cancel with button -1,
    // so a consumer that only clears its state on its own button never hears
    // the release — and stays stuck in a drag.
    dom.view.emit('pointercancel', mouse({ button: -1, clientX: 0, clientY: 0 }));

    expect(seen).toEqual(['down', 'cancel']);
  });

  it('stops tracking a mouse drag once the pointer is cancelled', () => {
    const dom = fakeDom();
    const drags: Array<[number, number]> = [];
    attachTo(dom, { onButtonDrag: (dx, dy) => drags.push([dx, dy]) });

    dom.canvas.emit('pointerdown', mouse({ button: 0, clientX: 10, clientY: 10 }));
    dom.view.emit('pointermove', mouse({ clientX: 15, clientY: 10 }));
    dom.view.emit('pointercancel', mouse({ button: -1, clientX: 15, clientY: 10 }));
    dom.view.emit('pointermove', mouse({ clientX: 90, clientY: 10 }));

    expect(drags).toEqual([[5, 0]]);
  });

  it('routes touch contacts to gestures and leaves the button path alone', () => {
    const dom = fakeDom();
    const drags: Array<[number, number]> = [];
    let buttonDowns = 0;
    attachTo(dom, {
      onButtonDown: () => { buttonDowns++; },
      onDrag: (dx, dy) => drags.push([dx, dy]),
    });

    dom.canvas.emit('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 0, clientY: 0 });
    dom.view.emit('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 3, clientY: 4 });

    expect(buttonDowns).toBe(0);
    expect(drags).toEqual([[3, 4]]);
  });

  it('detaches every listener it added', () => {
    const dom = fakeDom();
    const detach = attachTo(dom, { preventContextMenu: true, onButtonDown: () => {} });
    detach();

    expect(dom.canvas.count('pointerdown')).toBe(0);
    expect(dom.canvas.count('contextmenu')).toBe(0);
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'blur']) {
      expect(dom.view.count(type)).toBe(0);
    }
  });
});
