import type { SurfaceViewPreset } from '@cosmolabe/core';
import { resettable } from './session.svelte';

export type NavigationFraming = 'auto' | 'feature' | 'custom';
/** Retain framing intent, not a previous feature's computed altitude. */
export const navigationView = $state({ preset: 'overhead' as SurfaceViewPreset, framing: 'auto' as NavigationFraming, rangeText: '' });
resettable(navigationView);

export function featureRangeKm(diameterKm?: number): number | undefined {
  if (diameterKm === undefined || !Number.isFinite(diameterKm) || diameterKm <= 0) return undefined;
  const km = Math.max(5, diameterKm * 1.5);
  return Number.isFinite(km) ? km : undefined;
}

export function setNavigationFraming(framing: NavigationFraming, diameterKm?: number): void {
  if (framing === 'custom' && navigationView.framing === 'feature') {
    const km = featureRangeKm(diameterKm);
    navigationView.rangeText = km === undefined ? '' : String(km);
  } else if (framing !== 'custom') navigationView.rangeText = '';
  navigationView.framing = framing;
  if (framing === 'feature') navigationView.preset = 'overhead';
}

/** Omit diameter for Coordinates: retained Fit intent behaves as Auto there. */
export function navigationRange(diameterKm?: number) {
  if (navigationView.framing !== 'custom') {
    return { ok: true as const, km: navigationView.framing === 'feature' ? featureRangeKm(diameterKm) : undefined };
  }
  const value = Number(navigationView.rangeText.trim());
  return Number.isFinite(value) && value > 0
    ? { ok: true as const, km: navigationView.preset === 'surface' ? value / 1000 : value }
    : { ok: false as const, error: 'Range must be a positive number.' };
}
