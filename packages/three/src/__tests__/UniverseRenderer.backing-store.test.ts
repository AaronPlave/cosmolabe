import { afterEach, describe, expect, it, vi } from 'vitest';
import { UniverseRenderer } from '../UniverseRenderer.js';

function harness(dpr: number) {
  vi.stubGlobal('window', { devicePixelRatio: dpr });
  const canvas = { clientWidth: 1280, clientHeight: 800, width: 1280 * dpr, height: 800 * dpr };
  const renderer = {
    domElement: canvas,
    getPixelRatio: () => dpr,
    setPixelRatio: (value: number) => { dpr = value; },
    setDrawingBufferSize: vi.fn((width: number, height: number, ratio: number) => {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
    }),
  };
  const state = Object.assign(Object.create(UniverseRenderer.prototype), {
    renderer,
    bloomEffect: { setSize: vi.fn() },
    _devicePixelBox: null,
  }) as {
    _syncBackingStore(): void;
    _devicePixelBox: {
      pixels: { inlineSize: number; blockSize: number };
      cssWidth: number;
      cssHeight: number;
      dpr: number;
    } | null;
  };
  // Deliver the paired CSS/device-pixel measurement, independently of frames.
  const observe = (width = Math.round(canvas.clientWidth * dpr), height = Math.round(canvas.clientHeight * dpr)) => {
    state._devicePixelBox = {
      pixels: { inlineSize: width, blockSize: height },
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      dpr,
    };
  };
  return { canvas, renderer, state, observe };
}

afterEach(() => vi.unstubAllGlobals());

describe('UniverseRenderer backing-store observations (#350)', () => {
  it.each([1, 1.25, 1.5, 2])('rejects delayed observations during one-pixel resizes at DPR %s', dpr => {
    const { canvas, renderer, state, observe } = harness(dpr);
    observe();
    for (const [width, height] of [[1281, 800], [1282, 801], [1281, 800], [1280, 799], [1280, 800]]) {
      canvas.clientWidth = width;
      canvas.clientHeight = height;
      // Render before the observer callback: the previous box is stale.
      state._syncBackingStore();
      expect([canvas.width, canvas.height]).toEqual([Math.round(width * dpr), Math.round(height * dpr)]);
      observe();
      renderer.setDrawingBufferSize.mockClear();
      state._syncBackingStore();
      expect(renderer.setDrawingBufferSize).not.toHaveBeenCalled();
    }
  });

  it('uses a matching fractional-DPR observation, but rejects it after a DPR change', () => {
    const { canvas, state, observe } = harness(1.25);
    canvas.clientWidth = 1281;
    // Device-pixel rounding can depend on the canvas origin. A fresh browser
    // measurement must still take precedence over round(CSS size × DPR).
    observe(1602);
    state._syncBackingStore();
    expect(canvas.width).toBe(1602);

    vi.stubGlobal('window', { devicePixelRatio: 1.2495 });
    state._syncBackingStore();
    expect(canvas.width).toBe(Math.round(1281 * 1.2495));
  });
});
