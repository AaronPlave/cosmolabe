import { beforeEach, describe, expect, it, vi } from 'vitest';

const scrubTo = vi.fn();
vi.mock('../viewer-state.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../viewer-state.svelte')>()),
  scrubTo: (f: number) => scrubTo(f),
}));

const { timeline, timelineSurface, wheelIntent, hoverTarget, eventKey, ghostEt, profileRowHeight, clockLines, TL_HEAD_PX } =
  await import('../timeline.svelte');
const { vs, panScrubberBy, setScrubberWindow } = await import('../viewer-state.svelte');

/** A row of the timeline (`data-tl-row`), `top` px down the dock. */
function fakeRow(id: string, top: number) {
  return { getAttribute: () => id, getBoundingClientRect: () => ({ top }) };
}

/** An element in a row; `plot` marks an analysis plot's background. */
function fakeTarget(row: ReturnType<typeof fakeRow> | null, plot = true) {
  return {
    closest: (sel: string) => (sel === '[data-tl-row]' ? row : sel === '[data-tl-plot]' && plot ? {} : null),
  };
}

/** Just enough of the dock for the action. */
function fakeDock() {
  const target = new EventTarget();
  const captured = new Set<number>();
  return Object.assign(target, {
    dataset: {} as Record<string, string>,
    setPointerCapture: (id: number) => captured.add(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    hasPointerCapture: (id: number) => captured.has(id),
    captured,
  });
}

const lane = fakeRow('lane:a', 20);
const profile = fakeRow('profile:p', 40);
const transport = fakeRow('transport', 0);

function pointer(
  node: EventTarget, type: string, x: number, y = 0, pointerType = 'touch', id = 1,
  on: object = fakeTarget(profile), buttons = 0,
) {
  const e = new Event(type);
  Object.assign(e, { clientX: x, clientY: y, pointerType, pointerId: id, button: 0, buttons });
  Object.defineProperty(e, 'target', { value: on });
  node.dispatchEvent(e);
}

function wheel(node: EventTarget, x: number, deltaY: number, on: object = fakeTarget(profile)) {
  const e = new Event('wheel', { cancelable: true });
  Object.assign(e, { clientX: x, clientY: 50, deltaX: 0, deltaY, shiftKey: false });
  Object.defineProperty(e, 'target', { value: on });
  node.dispatchEvent(e);
  return e.defaultPrevented;
}

/**
 * The timeline is one interaction plane over a shared axis — here 100 px wide
 * at x = 0, live from y = 0 to 100. On an analysis plot a click seeks, a drag
 * pans, and on touch a vertical swipe is left to the scrolling lane region.
 */
describe('timeline surface gestures', () => {
  let dock: ReturnType<typeof fakeDock>;

  beforeEach(() => {
    scrubTo.mockClear();
    vs.scrubBaseMin = 0;
    vs.scrubBaseMax = 10_000;
    vs.scrubMin = 1000;
    vs.scrubMax = 2000;
    // Off-screen, so presses in these tests land on the background.
    vs.et = 0;
    timeline.hoverEt = null;
    timeline.hoverRow = null;
    timeline.linkedEt = null;
    dock = fakeDock();
    timelineSurface(dock as unknown as HTMLElement, {
      bounds: () => ({ left: 0, width: 100, top: 0, bottom: 100 }),
      targets: (row) => (row === 'lane:a' ? { snapTargets: [{ fraction: 0.5, id: 'ca' }] } : { snapTargets: [] }),
    });
  });

  it('keeps the hovered instant while the pointer crosses rows, tracking the row separately', () => {
    pointer(dock, 'pointermove', 20, 25, 'mouse', 1, fakeTarget(lane));
    expect([timeline.hoverEt, timeline.hoverRow]).toEqual([1200, 'lane:a']);
    pointer(dock, 'pointermove', 20, 45, 'mouse', 1, fakeTarget(profile));
    expect([timeline.hoverEt, timeline.hoverRow]).toEqual([1200, 'profile:p']);
    // The rule between rows belongs to no row, but is still on the axis.
    pointer(dock, 'pointermove', 20, 39, 'mouse', 1, fakeTarget(null, false));
    expect([timeline.hoverEt, timeline.hoverRow]).toEqual([1200, null]);
    // Off the axis — the label gutter — there is no instant to inspect.
    pointer(dock, 'pointermove', -30, 45, 'mouse', 1, fakeTarget(profile, false));
    expect([timeline.hoverEt, timeline.hoverRow]).toEqual([null, 'profile:p']);
  });

  it('snaps to the events of the row under the pointer', () => {
    pointer(dock, 'pointermove', 52, 25, 'mouse', 1, fakeTarget(lane));
    expect([timeline.hoverEt, timeline.previewEventId]).toEqual([1500, 'ca']);
    expect(timeline.anchor).toEqual({ x: 50, y: 20 });
    pointer(dock, 'pointermove', 52, 45, 'mouse', 1, fakeTarget(profile));
    expect([timeline.hoverEt, timeline.previewEventId]).toEqual([1520, null]);
  });

  it('zooms about the pointer over any row, and leaves the wheel alone off the axis', () => {
    expect(wheel(dock, 90, -100, fakeTarget(lane))).toBe(true);
    expect(vs.scrubMax - vs.scrubMin).toBeLessThan(1000);
    expect(vs.scrubMin).toBeLessThan(1900);
    expect(vs.scrubMax).toBeGreaterThan(1900);
    const span = vs.scrubMax - vs.scrubMin;
    expect(wheel(dock, 90, -100, fakeTarget(transport, false))).toBe(true);
    expect(vs.scrubMax - vs.scrubMin).toBeLessThan(span);
    const before = [vs.scrubMin, vs.scrubMax];
    expect(wheel(dock, -20, -100)).toBe(false);
    expect([vs.scrubMin, vs.scrubMax]).toEqual(before);
  });

  it('leaves presses on the transport track to the track', () => {
    pointer(dock, 'pointerdown', 50, 5, 'mouse', 1, fakeTarget(transport, false));
    pointer(dock, 'pointerup', 50, 5, 'mouse', 1, fakeTarget(transport, false));
    expect(scrubTo).not.toHaveBeenCalled();
    expect(dock.captured.size).toBe(0);
  });

  it('does not hover while a press held elsewhere (the track scrubbing) moves over it', () => {
    pointer(dock, 'pointermove', 20, 45, 'mouse');
    expect(timeline.hoverEt).toBe(1200);
    pointer(dock, 'pointermove', 30, 5, 'mouse', 1, fakeTarget(transport, false), 1);
    expect(timeline.hoverEt).toBeNull();
  });

  it('seeks on a mouse click, snapped to a nearby event of that row', () => {
    pointer(dock, 'pointerdown', 52, 25, 'mouse', 1, fakeTarget(lane));
    pointer(dock, 'pointerup', 53, 25, 'mouse', 1, fakeTarget(lane));
    expect(scrubTo).toHaveBeenCalledWith(0.5);
    expect(dock.captured.size).toBe(0);
  });

  it('pans on a mouse drag, content following the pointer, without seeking', () => {
    pointer(dock, 'pointerdown', 50, 0, 'mouse');
    pointer(dock, 'pointermove', 60, 0, 'mouse');
    pointer(dock, 'pointermove', 70, 0, 'mouse');
    pointer(dock, 'pointerup', 70, 0, 'mouse');
    // 20 px of a 100 px axis over a 1000 s window: 200 s earlier.
    expect(vs.scrubMin).toBe(800);
    expect(vs.scrubMax).toBe(1800);
    expect(scrubTo).not.toHaveBeenCalled();
    expect(dock.captured.size).toBe(0);
  });

  it('keeps panning when the drag wanders off the axis vertically', () => {
    pointer(dock, 'pointerdown', 50, 50, 'mouse');
    pointer(dock, 'pointermove', 60, 150, 'mouse');
    expect(vs.scrubMin).toBe(900);
  });

  it('leaves a vertical touch swipe to the scrolling region', () => {
    pointer(dock, 'pointerdown', 40, 0);
    pointer(dock, 'pointermove', 41, 30);
    pointer(dock, 'pointercancel', 41, 30);
    expect(scrubTo).not.toHaveBeenCalled();
    expect(vs.scrubMin).toBe(1000);
    expect(dock.captured.size).toBe(0);
  });

  it('pans on a horizontal touch drag and seeks on a tap', () => {
    pointer(dock, 'pointerdown', 40, 0);
    pointer(dock, 'pointermove', 20, 2);
    pointer(dock, 'pointerup', 20, 2);
    expect(vs.scrubMin).toBe(1200);
    expect(scrubTo).not.toHaveBeenCalled();

    pointer(dock, 'pointerdown', 25, 0, 'touch', 2);
    pointer(dock, 'pointerup', 26, 1, 'touch', 2);
    expect(scrubTo).toHaveBeenCalledWith(0.26);
    expect(timeline.hoverEt).toBeNull();
  });

  it('keeps panning when a child hands its implicit touch capture to the dock', () => {
    pointer(dock, 'pointerdown', 80, 0);
    pointer(dock, 'pointermove', 70, 1);
    const childLoss = new Event('lostpointercapture');
    Object.defineProperty(childLoss, 'target', { value: {} });
    dock.dispatchEvent(childLoss);
    pointer(dock, 'pointermove', 50, 1);
    expect(vs.scrubMin).toBe(1300);
  });

  it('scrubs time from a drag that starts on the playhead, with a grab target wider than the line', () => {
    vs.et = 1500; // x = 50 px
    pointer(dock, 'pointerdown', 54, 0, 'mouse');
    pointer(dock, 'pointermove', 70, 0, 'mouse');
    pointer(dock, 'pointerup', 70, 0, 'mouse');
    expect(scrubTo.mock.calls.map(([f]) => f)).toEqual([0.7]);
    // Scrubbing moves time, not the view.
    expect([vs.scrubMin, vs.scrubMax]).toEqual([1000, 2000]);
  });

  it('scrubs from the playhead on touch too, once the drag is horizontal', () => {
    vs.et = 1500;
    pointer(dock, 'pointerdown', 58, 0);
    pointer(dock, 'pointermove', 70, 1);
    expect(scrubTo).toHaveBeenLastCalledWith(0.7);
    expect(vs.scrubMin).toBe(1000);
  });

  it('pans rather than scrubs from just outside the grab target', () => {
    vs.et = 1500;
    pointer(dock, 'pointerdown', 60, 0, 'mouse');
    pointer(dock, 'pointermove', 70, 0, 'mouse');
    expect(scrubTo).not.toHaveBeenCalled();
    expect(vs.scrubMin).toBe(900);
  });

  it('ends the pan when the dock loses capture', () => {
    pointer(dock, 'pointerdown', 30, 0, 'mouse');
    pointer(dock, 'pointermove', 40, 0, 'mouse');
    const loss = new Event('lostpointercapture');
    Object.defineProperty(loss, 'target', { value: dock });
    dock.dispatchEvent(loss);
    pointer(dock, 'pointermove', 80, 0, 'mouse');
    // No longer panning: a move previews rather than pans.
    expect(vs.scrubMin).toBe(900);
    expect(timeline.hoverEt).toBe(900 + 800);
  });

  it('reads out at an event previewed elsewhere, until the pointer inspects a time of its own', () => {
    timeline.linkedEt = 1700;
    expect(ghostEt()).toBe(1700);
    pointer(dock, 'pointermove', 20, 45, 'mouse');
    expect(ghostEt()).toBe(1200);
  });
});

describe('profile row heights', () => {
  it('has exactly two modes, set by the row alone — never by how many profiles exist', () => {
    expect(profileRowHeight(false, true)).toBeLessThanOrEqual(50);
    expect(profileRowHeight(false, true)).toBeGreaterThanOrEqual(44);
    expect(profileRowHeight(true, true)).toBeGreaterThanOrEqual(110);
    expect(profileRowHeight(true, true)).toBeLessThanOrEqual(120);
  });
});

describe('timeline cursor', () => {
  it('shows the scrub cursor near the playhead and while dragging it, grabbing while panning', () => {
    scrubTo.mockClear();
    Object.assign(vs, { scrubBaseMin: 0, scrubBaseMax: 10_000, scrubMin: 1000, scrubMax: 2000, et: 1500 });
    const dock = fakeDock();
    timelineSurface(dock as unknown as HTMLElement, {
      bounds: () => ({ left: 0, width: 100, top: 0, bottom: 100 }),
      targets: () => ({ snapTargets: [] }),
    });
    pointer(dock, 'pointermove', 56, 45, 'mouse');
    expect(dock.dataset.tlCursor).toBe('playhead');
    pointer(dock, 'pointermove', 20, 45, 'mouse');
    expect(dock.dataset.tlCursor).toBeUndefined();
    pointer(dock, 'pointerdown', 20, 45, 'mouse');
    pointer(dock, 'pointermove', 30, 45, 'mouse');
    expect(dock.dataset.tlCursor).toBe('pan');
    pointer(dock, 'pointerup', 30, 45, 'mouse');
    // The pan moved the window 100 s earlier: the playhead is now at 60 px.
    pointer(dock, 'pointerdown', 60, 45, 'mouse');
    expect(dock.dataset.tlCursor).toBe('scrub');
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

describe('timeline hover targets', () => {
  const opts = {
    snapTargets: [{ fraction: 0.2, id: 'instant' }, { fraction: 0.4, id: 'long' }, { fraction: 0.9, id: 'long' }],
    spans: [{ start: 0.4, end: 0.9, id: 'long' }, { start: 0.5, end: 0.6, id: 'short' }],
  };

  it('previews a snapped edge first, then the shortest interval the hover is inside', () => {
    expect(hoverTarget(0.202, 1000, opts)).toEqual({ at: 0.2, id: 'instant' });
    expect(hoverTarget(0.55, 1000, opts)).toEqual({ at: 0.55, id: 'short' });
    expect(hoverTarget(0.7, 1000, opts)).toEqual({ at: 0.7, id: 'long' });
    expect(hoverTarget(0.3, 1000, opts)).toEqual({ at: 0.3, id: null });
  });

  it('keys events by query as well as id, since result ids recur across searches', () => {
    expect(eventKey({ id: 'result-1', queryId: 'a' })).not.toBe(eventKey({ id: 'result-1', queryId: 'b' }));
  });
});

describe('timeline framing', () => {
  beforeEach(() => {
    vs.scrubBaseMin = 0;
    vs.scrubBaseMax = 10_000;
  });

  it('frames a requested window, within the base range and minimum span', () => {
    setScrubberWindow(2000, 3000);
    expect([vs.scrubMin, vs.scrubMax]).toEqual([2000, 3000]);
    setScrubberWindow(9500, 11_000);
    expect([vs.scrubMin, vs.scrubMax]).toEqual([8500, 10_000]);
    setScrubberWindow(500, 500);
    expect(vs.scrubMax - vs.scrubMin).toBe(10);
    setScrubberWindow(-1e9, 1e9);
    expect([vs.scrubMin, vs.scrubMax]).toEqual([0, 10_000]);
  });
});

describe('compact clock', () => {
  const t = '2030-07-29 18:31:21 UTC';
  it('keeps the date to the end: zone, then seconds, then two lines', () => {
    expect(clockLines(t, Infinity)).toEqual(['2030-07-29 18:31:21 UTC']);
    expect(clockLines(t, 170)).toEqual(['2030-07-29 18:31:21']);
    expect(clockLines(t, 140)).toEqual(['2030-07-29 18:31']);
    expect(clockLines(t, 60)).toEqual(['2030-07-29', '18:31']);
    for (const room of [0, 60, 140, 170, 1000]) expect(clockLines(t, room)[0]).toMatch(/^2030-07-29/);
  });
  it('leaves text that is not a UTC timestamp whole', () => {
    expect(clockLines('J2000 +40.0 yr', 10)).toEqual(['J2000 +40.0 yr']);
  });
});

describe('stacked rows', () => {
  it('a phone row adds its header line over the same plot modes', () => {
    expect(profileRowHeight(false, false)).toBeGreaterThan(TL_HEAD_PX + 24);
    expect(profileRowHeight(true, false) - profileRowHeight(false, false))
      .toBe(profileRowHeight(true, true) - profileRowHeight(false, true));
  });
});
