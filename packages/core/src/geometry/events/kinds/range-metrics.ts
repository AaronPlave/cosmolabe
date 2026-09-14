import type { GeometryFinderProvider } from '../provider.js';
import type { EtInterval, EtSeconds, EventMetric } from '../types.js';

/**
 * Distance annotation shared by the distance-based kinds.
 *
 * GF answers *when*, never *how far*: `gfdist` hands back the window in which
 * a distance condition held and nothing about the distance itself. The number
 * a closest-approach result is actually about therefore comes from one
 * position lookup, through the provider's optional `range`. Providers that
 * cannot do one still search — their events simply carry no distance metric,
 * which is why every function here returns `undefined` rather than throwing.
 */

/** Km, formatted by the UI; precision is a suggestion, not a rounding. */
export function rangeMetric(key: string, label: string, km: number): EventMetric {
  return { key, label, value: km, unit: 'km', precision: 1 };
}

/** The observer→target range at one instant, when the provider can measure it. */
export async function rangeAt(
  provider: GeometryFinderProvider,
  target: string,
  abcorr: string,
  observer: string,
  et: EtSeconds,
): Promise<number | undefined> {
  if (!provider.range) return undefined;
  const km = await provider.range(target, abcorr, observer, et);
  return Number.isFinite(km) ? km : undefined;
}

/**
 * The extreme range inside a window, and when it occurred.
 *
 * `relate` is `ABSMIN` or `ABSMAX`. CSPICE's absolute-extremum relations are
 * documented to report the extremum over the whole confinement window, but
 * every candidate GF hands back is measured and compared rather than trusting
 * the first: a provider that reports local extrema under an absolute relation,
 * or splits the window, would otherwise silently yield "the minimum" that is
 * merely the earliest one. The cost is one position lookup per candidate, and
 * GF normally returns exactly one.
 *
 * A degenerate input window has no interior to search, so its single instant is
 * measured directly.
 */
export async function rangeExtremum(
  provider: GeometryFinderProvider,
  target: string,
  abcorr: string,
  observer: string,
  relate: 'ABSMIN' | 'ABSMAX',
  step: EtSeconds,
  window: EtInterval,
): Promise<{ et: EtSeconds; km: number } | undefined> {
  if (!provider.range) return undefined;

  if (window.end <= window.start) {
    const km = await rangeAt(provider, target, abcorr, observer, window.start);
    return km === undefined ? undefined : { et: window.start, km };
  }

  const found = await provider.gfdist(target, abcorr, observer, relate, 0, 0, step, [window]);

  let best: { et: EtSeconds; km: number } | undefined;
  for (const candidate of found) {
    const et = (candidate.start + candidate.end) / 2;
    const km = await rangeAt(provider, target, abcorr, observer, et);
    if (km === undefined) continue;
    if (!best || (relate === 'ABSMIN' ? km < best.km : km > best.km)) best = { et, km };
  }

  return best;
}
