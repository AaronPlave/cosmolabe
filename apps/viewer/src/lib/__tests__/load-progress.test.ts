import { describe, it, expect } from 'vitest';
import { LoadProgress, ASSET_PHASE_BUDGET_BYTES } from '../load-progress';

/**
 * The complaint this guards against: the bar filling up for the kernels and then
 * starting over at zero for the models, textures and trajectories, so one load
 * looked like two. The bar is one run in one direction — assert that on the
 * actual shape of a load rather than by watching a 175 MB catalog come down.
 */

/** Replays a whole load and returns every bar position it passed through. */
function replay(
  kernelBytes: number,
  steps: Array<['kernels' | 'assets', number]>,
): number[] {
  const p = new LoadProgress();
  p.begin({ kernelBytes });
  const seen = [p.value];
  for (const [phase, fraction] of steps) seen.push(p.set(phase, fraction));
  return seen;
}

const isMonotonic = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]);

describe('LoadProgress', () => {
  it('holds its position when the asset phase reports its own zero', () => {
    // cassini-soi's shape: ~175 MB of declared kernels, then its models,
    // textures and trajectory caches.
    const seen = replay(175_000_000, [
      ['kernels', 0.25],
      ['kernels', 0.5],
      ['kernels', 1],
      // The asset phase opens by reporting its own zero — the moment the old
      // two-bar behaviour showed itself.
      ['assets', 0],
      ['assets', 0.3],
      ['assets', 1],
    ]);

    expect(isMonotonic(seen)).toBe(true);
    // The handover: the bar holds its kernel position instead of dropping.
    const atKernelsDone = seen[3];
    const atAssetsZero = seen[4];
    expect(atAssetsZero).toBe(atKernelsDone);
    expect(atKernelsDone).toBeGreaterThan(50);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it('gives a kernel-heavy catalog most of the bar, and ends it short of full', () => {
    const p = new LoadProgress();
    p.begin({ kernelBytes: 175_000_000 });
    // 175 MB against the 40 MB asset budget ≈ 81%.
    expect(p.weightOf('kernels')).toBeCloseTo(0.81, 2);
    expect(p.set('kernels', 1)).toBeCloseTo(81, 0);
    // Kernels finishing is not the load finishing: the rest of the bar is real
    // work, which is the whole point of not running it to 100 here.
    expect(p.value).toBeLessThan(100);
  });

  it('gives the whole bar to assets when the catalog has no kernels', () => {
    const p = new LoadProgress();
    p.begin({});
    expect(p.weightOf('assets')).toBe(1);
    expect(p.set('assets', 0.5)).toBe(50);
    expect(p.set('assets', 1)).toBe(100);
  });

  it('splits the bar evenly when kernels match the asset budget', () => {
    const p = new LoadProgress();
    p.begin({ kernelBytes: ASSET_PHASE_BUDGET_BYTES });
    expect(p.weightOf('kernels')).toBeCloseTo(0.5, 6);
    expect(p.set('kernels', 1)).toBeCloseTo(50, 6);
  });

  it('holds the bar when the asset count grows under it', () => {
    // Assets are counted, and the count is discovered as it goes: a `.cmod`'s
    // material textures only join once its mesh has parsed. 3/3 becoming 3/7 is
    // a real drop in the raw fraction and must not move the bar back.
    const p = new LoadProgress();
    p.begin({});
    const atThreeOfThree = p.set('assets', 3 / 3);
    const atThreeOfSeven = p.set('assets', 3 / 7);
    expect(atThreeOfSeven).toBe(atThreeOfThree);
    expect(p.set('assets', 7 / 7)).toBe(100);
  });

  it('starts a genuinely new load from zero', () => {
    // The one reset that should exist: a second catalog is a new load, not a
    // continuation of the last one.
    const p = new LoadProgress();
    p.begin({ kernelBytes: 175_000_000 });
    p.set('kernels', 1);
    p.set('assets', 1);
    expect(p.value).toBe(100);

    p.begin({ kernelBytes: 0 });
    expect(p.value).toBe(0);
    expect(p.weightOf('assets')).toBe(1);
  });

  it('ignores out-of-range and non-finite fractions', () => {
    const p = new LoadProgress();
    p.begin({});
    expect(p.set('assets', -1)).toBe(0);
    expect(p.set('assets', 0.5)).toBe(50);
    // A zero-asset scene divides 0/0 on the caller's side; whatever arrives
    // here, the bar stays where it was rather than becoming NaN%.
    expect(p.set('assets', Number.NaN)).toBe(50);
    expect(p.set('assets', 42)).toBe(100);
  });
});
