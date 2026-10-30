import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The panel half of issue #106: the suggestion follows the query, "Use
 * available range" fills the window without searching, and a custom window is
 * never overwritten behind the user's back.
 */

const IDS: Record<string, number> = { EARTH: 399, 'EARTH BARYCENTER': 3, MARS: 499, 'MARS BARYCENTER': 4, MOON: 301 };
const NAMES = Object.fromEntries(Object.entries(IDS).map(([n, i]) => [i, n]));

const BASE_SEGMENTS = [
  { body: 3, center: 0, frame: 1, type: 13, file: 'a', start: 0, end: 10_000 },
  { body: 399, center: 3, frame: 1, type: 13, file: 'a', start: 0, end: 10_000 },
  { body: 301, center: 399, frame: 1, type: 13, file: 'a', start: 0, end: 10_000 },
  { body: 499, center: 4, frame: 1, type: 13, file: 'b', start: 0, end: 10_000 },
  { body: 4, center: 0, frame: 1, type: 13, file: 'b', start: 1_000, end: 3_000 },
  { body: 4, center: 0, frame: 1, type: 13, file: 'b', start: 5_000, end: 8_000 },
];
let segments = [...BASE_SEGMENTS];
let loaded = 1;
let lightTimeSeconds = 0;
let reportSpkCoverage = false;

const fakeSpice = {
  bodn2c: (name: string) => IDS[name.toUpperCase()] ?? null,
  bodc2n: (code: number) => NAMES[code] ?? null,
  spkSegments: () => segments,
  totalLoaded: () => loaded,
  spkcov: (id: number) => reportSpkCoverage
    ? segments.filter((segment) => segment.body === id).map(({ start, end }) => ({ start, end }))
    : [],
  spkpos: () => ({ position: [1, 0, 0], lightTime: lightTimeSeconds }),
  pxform: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  bodvrd: () => [1, 1, 1],
};

vi.mock('../loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../loader')>()),
  getSpice: () => fakeSpice,
  getGeometryWorker: () => null,
}));

const finder = await import('../event-finder.svelte');
const {
  ef, currentSearchUnavailable, resetForScene, resetForm, setKind, setRole, setWindow, useAvailableWindow, windowOutsideUsable,
  refreshCoverage, ensureCoverageCurrent, runSearch,
} = finder;
const { vs } = await import('../viewer-state.svelte');
const { analysis } = await import('../analysis.svelte');

beforeEach(() => {
  segments = [...BASE_SEGMENTS];
  lightTimeSeconds = 0;
  reportSpkCoverage = false;
  analysis.reference.abcorr = 'LT+S';
  vs.et = 2_000;
  vs.scrubBaseMin = 0;
  vs.scrubBaseMax = 10_000;
  ef.kind = 'closest-approach';
  resetForm();
  setRole('observer', 'MARS');
  setRole('target', 'EARTH');
});

afterEach(() => {
  resetForScene();
  loaded = 1;
  vs.kernelCount = 0;
});

describe('event finder usable range', () => {
  it('offers each side of the barycenter gap for Mars ↔ Earth', () => {
    expect(ef.coverage?.status).toBe('available');
    expect(ef.coverage?.windows).toEqual([
      { start: 1_003, end: 2_997 },
      { start: 5_003, end: 7_997 },
    ]);
    // The automatic default is one of them — the one holding the current
    // time — never the envelope across the gap.
    expect(ef.form).toMatchObject({ startEt: 1_003, endEt: 2_997 });
    expect(ef.windowSource).toBe('suggested');
  });

  it('follows the selected bodies and the event type', () => {
    setRole('observer', 'MOON');
    expect(ef.coverage?.windows).toEqual([{ start: 3, end: 9_997 }]);

    setKind('occultation');
    // Occultation needs all three roles before there is geometry to assess.
    expect(ef.coverage).toBeNull();
    setRole('front', 'MOON');
    setRole('back', 'MARS');
    setRole('observer', 'EARTH');
    expect(ef.coverage?.windows).toHaveLength(2);
  });

  it('fills From/To without searching, and only when asked', () => {
    setWindow(100, 9_000);
    expect(ef.windowPinned).toBe(true);
    expect(ef.windowSource).toBe('custom');
    expect(windowOutsideUsable().length).toBeGreaterThan(0);

    // A body change keeps the user's window.
    setRole('target', 'MOON');
    expect(ef.form).toMatchObject({ startEt: 100, endEt: 9_000 });

    setRole('target', 'EARTH');
    useAvailableWindow(1);
    expect(ef.form).toMatchObject({ startEt: 5_003, endEt: 7_997 });
    expect(ef.windowSource).toBe('available');
    expect(ef.running).toBe(false);
    expect(ef.searched).toBe(false);
    expect(windowOutsideUsable()).toEqual([]);
  });

  it('refreshes the offered range with the correction used by the search', () => {
    vs.kernelCount = 1;
    analysis.reference.abcorr = 'NONE';
    refreshCoverage();
    setRole('observer', 'EARTH');
    setRole('target', 'MARS');
    expect(ef.coverage?.windows[0]?.start).toBe(1_003);

    lightTimeSeconds = 240;
    reportSpkCoverage = true;
    analysis.reference.abcorr = 'LT+S';
    useAvailableWindow(0);
    expect(ef.form?.startEt).toBeGreaterThan(1_240);
    expect(ef.form?.startEt).toBe(ef.coverage?.windows[0]?.start);
    expect(currentSearchUnavailable()).toBeNull();
  });

  it('checks estimated selections with the actual geometry rather than geometric light-time margins', () => {
    vs.kernelCount = 1;
    reportSpkCoverage = true;
    lightTimeSeconds = 240;
    setRole('observer', 'EARTH');
    setRole('target', 'MARS');
    refreshCoverage();
    ef.coverage = {
      status: 'available', exact: false,
      windows: [{ start: 1_003, end: 2_997 }], problems: [], caveats: ['Estimated edges'],
    };
    useAvailableWindow(0);
    // The geometric margin would reject the start; the actual corrected
    // calculation succeeds, including the derivative evaluations at ±2 s.
    expect(currentSearchUnavailable()).toBeNull();

    const probe = vi.spyOn(fakeSpice, 'spkpos').mockImplementation(() => {
      throw new Error('SPICE(SPKINSUFFDATA)');
    });
    try {
      expect(currentSearchUnavailable()?.message).toMatch(/could not evaluate.*SPKINSUFFDATA/);
    } finally {
      probe.mockRestore();
    }
  });

  it('says plainly when nothing is usable', () => {
    segments = segments.filter((s) => s.body !== 4);
    loaded++;
    refreshCoverage();
    expect(ef.coverage?.status).toBe('none');
    expect(ef.coverage?.problems.join(' ')).toMatch(/MARS BARYCENTER/);
  });

  it('catches kernels dropped while the panel was closed, on reopen', () => {
    // Close: nothing is mounted, nothing watches. Drop a kernel that removes
    // the barycenter's second piece; the count moves as the loader moves it.
    expect(ef.coverage?.windows).toHaveLength(2);
    segments = segments.filter((s) => !(s.body === 4 && s.start === 5_000));
    loaded++;
    vs.kernelCount++;
    expect(ef.coverage?.windows).toHaveLength(2); // stale until someone looks

    // Reopen: the panel's mount-time effect calls this, whatever count it
    // happens to see first.
    ensureCoverageCurrent();
    expect(ef.coverage?.windows).toEqual([{ start: 1_003, end: 2_997 }]);
    expect(ef.coverageKernelCount).toBe(vs.kernelCount);
  });

  it('refreshes a stale suggestion before a search runs', async () => {
    segments = segments.filter((s) => !(s.body === 4 && s.start === 5_000));
    loaded++;
    vs.kernelCount++;
    await runSearch();
    expect(ef.coverage?.windows).toEqual([{ start: 1_003, end: 2_997 }]);
  });

  it('clears the suggestion with the scene', () => {
    resetForScene();
    expect(ef.coverage).toBeNull();
  });
});
