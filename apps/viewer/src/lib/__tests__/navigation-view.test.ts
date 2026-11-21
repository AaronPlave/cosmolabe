import { beforeEach, describe, expect, it } from 'vitest';
import { featureRangeKm, navigationRange, navigationView, setNavigationFraming } from '../navigation-view.svelte';

beforeEach(() => Object.assign(navigationView, { preset: 'overhead', framing: 'auto', rangeText: '' }));
describe('shared navigation framing', () => {
  it('retains feature-relative intent across large, small and unknown destinations', () => {
    setNavigationFraming('feature');
    expect(navigationRange(3760)).toEqual({ ok: true, km: 5640 });
    expect(navigationRange(1)).toEqual({ ok: true, km: 5 });
    for (const diameter of [undefined, 0, -1, NaN, Infinity, Number.MAX_VALUE]) expect(navigationRange(diameter)).toEqual({ ok: true, km: undefined });
    expect(navigationView.framing).toBe('feature');
    expect(navigationRange(20)).toEqual({ ok: true, km: 30 });
    expect(navigationView.rangeText).toBe('');
  });
  it('uses Auto for Coordinates while retaining Fit intent for Places', () => {
    setNavigationFraming('feature');
    expect(navigationRange()).toEqual({ ok: true, km: undefined });
    expect(navigationRange(20)).toEqual({ ok: true, km: 30 });
    setNavigationFraming('auto');expect(navigationRange(20)).toEqual({ ok: true, km: undefined });
  });
  it('makes explicit Custom settings equivalent in both workflows, including surface metres', () => {
    setNavigationFraming('feature');setNavigationFraming('custom',20);
    expect(navigationRange(20)).toEqual(navigationRange());expect(navigationRange()).toEqual({ ok: true, km: 30 });
    navigationView.preset='surface';navigationView.rangeText='100';
    expect(navigationRange()).toEqual({ ok: true, km: .1 });
    expect(navigationRange(999)).toEqual(navigationRange());
  });
  it('validates Custom input without carrying its old value into Auto or Fit', () => {
    setNavigationFraming('custom');
    for(const text of ['', '0', '-1', 'oops', 'Infinity']) { navigationView.rangeText=text;expect(navigationRange().ok).toBe(false); }
    setNavigationFraming('auto');expect(navigationView.rangeText).toBe('');expect(navigationRange().ok).toBe(true);
    expect(featureRangeKm(20)).toBe(30);
  });
});
