import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { reference: 1737, accepts: true, scale: 1 };
const dolly = vi.fn((_km: number) => state.accepts);
const crane = vi.fn((_km: number) => state.accepts);

vi.mock('../viewer-state.svelte', () => ({
  dolly: (km: number) => dolly(km),
  crane: (km: number) => crane(km),
  getRenderer: () => ({
    scaleFactor: state.scale,
    cameraController: { get moveSpeedReference() { return state.reference; } },
  }),
}));

import { startHeldCameraMove, stopAllHeldCameraMoves } from '../held-camera-moves';

let frames: FrameRequestCallback[] = [];
const run = (ms: number) => { const f = frames.shift(); f?.(ms); };

beforeEach(() => {
  frames = [];
  state.reference = 1737; state.accepts = true;
  dolly.mockClear(); crane.mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
});
afterEach(() => { stopAllHeldCameraMoves(); vi.unstubAllGlobals(); });

describe('held camera moves', () => {
  it('moves by the shared speed reference, not the orbit-centre range', () => {
    state.reference = 0.1; // ~100 m altitude while orbiting the Moon's centre
    startHeldCameraMove('cam:crane-up');
    run(1000); run(1016);
    const km = crane.mock.calls[1][0];
    expect(km).toBeGreaterThan(0);
    expect(km).toBeLessThan(0.1 * 0.55 * 0.05 + 1e-12); // metres per frame, never kilometres
  });

  it('rescales at once when the reference changes while held', () => {
    startHeldCameraMove('cam:dolly-out');
    run(1000); run(1016);
    const far = dolly.mock.calls[1][0];
    state.reference = 0.1;
    run(1032);
    expect(dolly.mock.calls[2][0]).toBeCloseTo(far * (0.1 / 1737), 9);
  });

  it('stops when the camera mode stops accepting the move', () => {
    startHeldCameraMove('cam:dolly-in');
    run(1000);
    state.accepts = false;
    run(1016);
    expect(frames).toHaveLength(0);
    expect(dolly).toHaveBeenCalled();
  });
});
