import { describe, expect, it, vi } from 'vitest';
import { UniverseRenderer } from './UniverseRenderer.js';

function fixture() {
  const r = Object.create(UniverseRenderer.prototype) as any;
  const iv = { active: true, sensorName: 'NAC', fullScreen: false, pointing: 'none', unavailableReason: null as string | null,
    fov: [1, 1], viewFov: [1, 1], imageRect: null, measure: () => true,
    update() { this.pointing = 'target'; this.unavailableReason = null; },
    markUnavailable(reason: string) { this.pointing = 'unavailable'; this.unavailableReason = reason; } };
  const sf = { body: { name: 'NAC' }, present: true };
  Object.assign(r, { instrumentView: iv, instrumentObservedEt: null, instrumentObservedPointing: 'none',
    instrumentObservedUnavailable: null, instrumentRenderError: null, sensorFrustums: new Map([['NAC', sf]]),
    universe: { getBody: () => undefined }, timeController: { et: 10 }, scaleFactor: 1,
    renderer: { domElement: {} }, bodyMeshes: new Map(), renderInstrumentScene: vi.fn() });
  const draw = (et: number) => { r.timeController.et = et; r.renderInstrumentFeed(et, undefined, () => [0, 0, 0]); };
  return { r, iv, sf, draw };
}

describe('instrument observation versus independent playback clock', () => {
  it('keeps last rendered physical pointing and its epoch between clock and renderer RAFs', () => {
    const { r, draw } = fixture();
    draw(10);
    expect(r.getInstrumentViewInfo()).toMatchObject({ pointing: 'target', pointingUnavailable: null, observedEt: 10, fresh: true });
    r.timeController.et = 11;
    expect(r.getInstrumentViewInfo()).toMatchObject({ pointing: 'target', pointingUnavailable: null, observedEt: 10, fresh: false });
    draw(11);
    expect(r.getInstrumentViewInfo()).toMatchObject({ observedEt: 11, fresh: true });
  });

  it('publishes only after a successful draw and leaves a failed render explicitly stale', () => {
    const { r, draw } = fixture();
    draw(10);
    r.renderInstrumentScene = () => {
      expect(r.getInstrumentViewInfo().observedEt).toBe(10);
      throw new Error('GPU draw failed');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { draw(11); } finally { warn.mockRestore(); }
    expect(r.getInstrumentViewInfo()).toMatchObject({ pointing: 'target', observedEt: 10, fresh: false,
      renderError: 'Instrument frame could not be rendered.' });
  });

  it('records a real state/attitude failure at the attempted epoch, then recovers', () => {
    const { r, sf, draw } = fixture();
    sf.present = false;
    draw(10);
    expect(r.getInstrumentViewInfo()).toMatchObject({ pointing: 'unavailable', observedEt: 10, fresh: true,
      pointingUnavailable: 'NAC or its spacecraft has no state or attitude at this time.' });
    sf.present = true; draw(11);
    expect(r.getInstrumentViewInfo()).toMatchObject({ pointing: 'target', pointingUnavailable: null, observedEt: 11, fresh: true });
  });
});
