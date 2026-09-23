import { beforeEach, describe, expect, it, vi } from 'vitest';

const scrubTo = vi.fn();
vi.mock('../viewer-state.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../viewer-state.svelte')>()),
  scrubTo: (f: number) => scrubTo(f),
}));

const { timeline, timelineGestures, wheelIntent } = await import('../timeline.svelte');
const { vs, panScrubberBy } = await import('../viewer-state.svelte');

/** Just enough of an element for the action: 100 px wide at x = 0. */
function fakeRow() {
  const target = new EventTarget();
  const captured = new Set<number>();
  return Object.assign(target, {
    clientWidth: 100,
    style: { cursor: '' },
    getBoundingClientRect: () => ({ left: 0, width: 100 }),
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
    matches: () => false,
    captured,
  });
}

function pointer(node: EventTarget, type: string, x: number, y = 0, pointerType = 'touch', id = 1) {
  const e = new Event(type);
  Object.assign(e, { clientX: x, clientY: y, pointerType, pointerId: id, button: 0 });
  node.dispatchEvent(e);
}

/**
 * Rows below the transport navigate the axis: a click seeks, a drag pans,
 * and on touch a vertical swipe is left to the scrolling lane region.
 */
describe('timeline row gestures', () => {
  let row: ReturnType<typeof fakeRow>;

  beforeEach(() => {
    scrubTo.mockClear();
    vs.scrubBaseMin = 0;
    vs.scrubBaseMax = 10_000;
    vs.scrubMin = 1000;
    vs.scrubMax = 2000;
    timeline.hoverEt = null;
    row = fakeRow();
    timelineGestures(row as unknown as HTMLElement, { snapTargets: [{ fraction: 0.5, id: 'ca' }] });
  });

  it('seeks on a mouse click, snapped to a nearby event, and previews on hover', () => {
    pointer(row, 'pointermove', 20, 0, 'mouse');
    expect(timeline.hoverEt).toBe(1200);
    pointer(row, 'pointerdown', 52, 0, 'mouse');
    pointer(row, 'pointerup', 53, 0, 'mouse');
    expect(scrubTo).toHaveBeenCalledWith(0.5);
    expect(row.captured.size).toBe(0);
  });

  it('pans on a mouse drag, content following the pointer, without seeking', () => {
    pointer(row, 'pointerdown', 50, 0, 'mouse');
    pointer(row, 'pointermove', 60, 0, 'mouse');
    pointer(row, 'pointermove', 70, 0, 'mouse');
    pointer(row, 'pointerup', 70, 0, 'mouse');
    // 20 px of a 100 px row over a 1000 s window: 200 s earlier.
    expect(vs.scrubMin).toBe(800);
    expect(vs.scrubMax).toBe(1800);
    expect(scrubTo).not.toHaveBeenCalled();
    expect(row.captured.size).toBe(0);
  });

  it('leaves a vertical touch swipe to the scrolling region', () => {
    pointer(row, 'pointerdown', 40, 0);
    pointer(row, 'pointermove', 41, 30);
    pointer(row, 'pointercancel', 41, 30);
    expect(scrubTo).not.toHaveBeenCalled();
    expect(vs.scrubMin).toBe(1000);
    expect(row.captured.size).toBe(0);
  });

  it('pans on a horizontal touch drag and seeks on a tap', () => {
    pointer(row, 'pointerdown', 40, 0);
    pointer(row, 'pointermove', 20, 2);
    pointer(row, 'pointerup', 20, 2);
    expect(vs.scrubMin).toBe(1200);
    expect(scrubTo).not.toHaveBeenCalled();

    pointer(row, 'pointerdown', 25, 0, 'touch', 2);
    pointer(row, 'pointerup', 26, 1, 'touch', 2);
    expect(scrubTo).toHaveBeenCalledWith(0.26);
    expect(timeline.hoverEt).toBeNull();
  });

  it('keeps panning when a child hands its implicit touch capture to the row', () => {
    pointer(row, 'pointerdown', 80, 0);
    pointer(row, 'pointermove', 70, 1);
    const childLoss = new Event('lostpointercapture');
    Object.defineProperty(childLoss, 'target', { value: {} });
    row.dispatchEvent(childLoss);
    pointer(row, 'pointermove', 50, 1);
    expect(vs.scrubMin).toBe(1300);
  });

  it('ends the pan when the row loses capture', () => {
    pointer(row, 'pointerdown', 30, 0, 'mouse');
    pointer(row, 'pointermove', 40, 0, 'mouse');
    row.dispatchEvent(new Event('lostpointercapture'));
    pointer(row, 'pointermove', 80, 0, 'mouse');
    // No longer panning: a move previews rather than pans.
    expect(vs.scrubMin).toBe(900);
    expect(timeline.hoverEt).toBe(900 + 800);
  });
});

describe('timeline wheel and pan', () => {
  beforeEach(() => {
    vs.scrubBaseMin = 0;
    vs.scrubBaseMax = 10_000;
    vs.scrubMin = 1000;
    vs.scrubMax = 2000;
  });

  it('zooms on a vertical wheel and pans on a sideways or Shift wheel', () => {
    expect(wheelIntent({ deltaX: 0, deltaY: -40, shiftKey: false })).toEqual({ zoomIn: true });
    expect(wheelIntent({ deltaX: 30, deltaY: 5, shiftKey: false })).toEqual({ pan: 30 });
    expect(wheelIntent({ deltaX: 0, deltaY: 40, shiftKey: true })).toEqual({ pan: 40 });
    expect(wheelIntent({ deltaX: 0, deltaY: 0, shiftKey: false })).toBeNull();
  });

  it('pans without changing the span, stopping at the base range', () => {
    panScrubberBy(500);
    expect([vs.scrubMin, vs.scrubMax]).toEqual([1500, 2500]);
    panScrubberBy(-5000);
    expect([vs.scrubMin, vs.scrubMax]).toEqual([0, 1000]);
    panScrubberBy(1e9);
    expect([vs.scrubMin, vs.scrubMax]).toEqual([9000, 10_000]);
  });
});
