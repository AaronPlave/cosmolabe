import type { SurfaceViewPreset } from '@cosmolabe/core';

/** One session view choice shared by named and coordinate destinations. */
export const navigationView = $state({ preset: 'overhead' as SurfaceViewPreset, rangeText: '' });

export function navigationRange() {
  const text = navigationView.rangeText.trim();
  if (!text) return { ok: true as const, km: undefined };
  const value = Number(text);
  return Number.isFinite(value) && value > 0
    ? { ok: true as const, km: navigationView.preset === 'surface' ? value / 1000 : value }
    : { ok: false as const, error: 'Range must be a positive number.' };
}
