/**
 * Held dolly/crane share the keyboard's ground-aware speed policy (#15): near a
 * surface the reference is altitude, not the range to the orbit centre.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { KeyboardControls } from '../KeyboardControls.js';

// KeyboardControls listens on `window`; the policy under test needs no DOM.
beforeAll(() => { vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} }); });

describe('movement speed reference', () => {
  it('is the orbit range when no surface is near', () => {
    const keys = new KeyboardControls({ enabled: false });
    expect(keys.speedReference(1737)).toBe(1737);
    keys.dispose();
  });

  it('follows altitude, not centre range, near a surface', () => {
    const keys = new KeyboardControls({ enabled: false });
    keys.altitudeRefSceneUnits = 0.1; // ~100 m over the Moon while orbiting its centre
    expect(keys.speedReference(1737)).toBe(0.1);
    // Far above the surface the orbit range is still the cap.
    keys.altitudeRefSceneUnits = 5000;
    expect(keys.speedReference(1737)).toBe(1737);
    keys.dispose();
  });
});
