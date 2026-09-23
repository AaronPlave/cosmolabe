import { beforeEach, describe, expect, it, vi } from 'vitest';

const scrubTo = vi.fn();
vi.mock('../viewer-state.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../viewer-state.svelte')>()),
  scrubTo: (f: number) => scrubTo(f),
}));

const { timeline, timelineGestures } = await import('../timeline.svelte');
const { vs } = await import('../viewer-state.svelte');

/** Just enough of an element for the action: 100 px wide at x = 0. */
function fakeRow() {
  const target = new EventTarget();
  const captured = new Set<number>();
  return Object.assign(target, {
    clientWidth: 100,
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

describe('timeline gestures', () => {
  let row: ReturnType<typeof fakeRow>;

  beforeEach(() => {
    scrubTo.mockClear();
    vs.scrubMin = 0;
    vs.scrubMax = 1000;
    timeline.hoverEt = null;
    row = fakeRow();
    timelineGestures(row as unknown as HTMLElement, { snapTargets: [] });
  });

  it('leaves a vertical touch swipe to the scrolling region', () => {
    pointer(row, 'pointerdown', 40, 0);
    pointer(row, 'pointermove', 41, 30);
    // The browser takes the pan and cancels the pointer.
    pointer(row, 'pointercancel', 41, 30);
    expect(scrubTo).not.toHaveBeenCalled();
    expect(row.captured.size).toBe(0);
  });

  it('scrubs on a horizontal touch drag', () => {
    pointer(row, 'pointerdown', 40, 0);
    pointer(row, 'pointermove', 60, 2);
    pointer(row, 'pointermove', 70, 2);
    pointer(row, 'pointerup', 70, 2);
    expect(scrubTo.mock.calls.map(([f]) => f)).toEqual([0.6, 0.7]);
    expect(row.captured.size).toBe(0);
  });

  it('seeks on a touch tap without leaving a ghost behind', () => {
    pointer(row, 'pointerdown', 25, 0);
    pointer(row, 'pointerup', 26, 1);
    expect(scrubTo).toHaveBeenCalledWith(0.26);
    expect(timeline.hoverEt).toBeNull();
  });

  it('commits a mouse press immediately and previews on hover', () => {
    pointer(row, 'pointermove', 50, 0, 'mouse');
    expect(timeline.hoverEt).toBe(500);
    pointer(row, 'pointerdown', 30, 0, 'mouse');
    expect(scrubTo).toHaveBeenCalledWith(0.3);
    expect(row.captured.has(1)).toBe(true);
  });

  it('keeps scrubbing when a child hands its implicit touch capture to the row', () => {
    pointer(row, 'pointerdown', 80, 0);
    pointer(row, 'pointermove', 70, 1);
    const childLoss = new Event('lostpointercapture');
    Object.defineProperty(childLoss, 'target', { value: {} });
    row.dispatchEvent(childLoss);
    pointer(row, 'pointermove', 50, 1);
    expect(scrubTo.mock.calls.map(([f]) => f)).toEqual([0.7, 0.5]);
  });

  it('cleans up when capture is lost mid-drag', () => {
    pointer(row, 'pointerdown', 30, 0, 'mouse');
    row.dispatchEvent(new Event('lostpointercapture'));
    scrubTo.mockClear();
    pointer(row, 'pointermove', 80, 0, 'mouse');
    // No longer dragging: a move previews rather than seeks.
    expect(scrubTo).not.toHaveBeenCalled();
    expect(timeline.hoverEt).toBe(800);
  });
});
