// The policy that decides whether a scene runs the workers' own CSPICE
// instances. It is a heuristic over poor signals, so what it does with each one
// is pinned here rather than left to be re-derived from the browser it happens
// to run in (issue #88).

import { describe, it, expect } from 'vitest';
import { shouldRunSpiceWorkers, CONSTRAINED_DEVICE_MEMORY_GIB } from '../device-budget';

describe('shouldRunSpiceWorkers', () => {
  it('runs the workers when nothing suggests a constrained device', () => {
    expect(shouldRunSpiceWorkers({})).toBe(true);
  });

  it('runs them on a desktop with headroom', () => {
    expect(shouldRunSpiceWorkers({ deviceMemory: 8 })).toBe(true);
    expect(shouldRunSpiceWorkers({ deviceMemory: CONSTRAINED_DEVICE_MEMORY_GIB + 1 })).toBe(true);
  });

  it('skips them when the device reports little memory', () => {
    expect(shouldRunSpiceWorkers({ deviceMemory: CONSTRAINED_DEVICE_MEMORY_GIB })).toBe(false);
    expect(shouldRunSpiceWorkers({ deviceMemory: 2 })).toBe(false);
  });

  it('trusts a reported figure over the pointer type', () => {
    // A touchscreen laptop that reports 16 GiB is not the device this is about.
    expect(shouldRunSpiceWorkers({ deviceMemory: 16, coarsePointer: true })).toBe(true);
  });

  it('reads a touch-primary device with no reported memory as constrained', () => {
    // iOS Safari: no deviceMemory, and the engine that terminates the page.
    expect(shouldRunSpiceWorkers({ coarsePointer: true })).toBe(false);
  });

  it('leaves a mouse-driven browser with no reported memory alone', () => {
    expect(shouldRunSpiceWorkers({ coarsePointer: false })).toBe(true);
  });

  describe('the ?spiceWorkers override', () => {
    it('forces the single-instance path on a machine with plenty of memory', () => {
      expect(shouldRunSpiceWorkers({ deviceMemory: 32, search: '?spiceWorkers=0' })).toBe(false);
      expect(shouldRunSpiceWorkers({ deviceMemory: 32, search: '?spiceWorkers=false' })).toBe(false);
    });

    it('forces the workers back on where the heuristic would skip them', () => {
      expect(shouldRunSpiceWorkers({ coarsePointer: true, search: '?spiceWorkers=1' })).toBe(true);
      expect(shouldRunSpiceWorkers({ deviceMemory: 2, search: '?spiceWorkers=1' })).toBe(true);
    });

    it('is ignored when the URL carries other parameters but not this one', () => {
      expect(shouldRunSpiceWorkers({ deviceMemory: 2, search: '?test=1' })).toBe(false);
      expect(shouldRunSpiceWorkers({ deviceMemory: 32, search: '?test=1' })).toBe(true);
    });
  });
});
