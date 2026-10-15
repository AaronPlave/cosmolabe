/**
 * Continuous geometry profiles — the time-series half of the analysis
 * timeline (#65), counterpart to the event lanes.
 *
 * Sampling policy: a profile is a *display* sampling of
 * `Universe.absolutePositionOf` across whatever window the timeline is
 * currently drawing, at a density set by how many pixels that window has. It
 * has nothing to do with a geometry-finder search step and needs no SPICE
 * kernels, so profiles work on every catalog — Keplerian, TLE and sampled
 * trajectories included — which the event path cannot promise. Zooming the
 * timeline resamples; playback does not.
 *
 * Framework-free on purpose: the timeline rows are the Svelte side, and this
 * is what they, and the tests, share.
 */
import type { EtInterval } from '@cosmolabe/core';
import { formatKm } from './event-query';

/** Absolute position lookup, in km. `Universe.absolutePositionOf` in the app. */
export type PositionOf = (body: string, et: number) => readonly [number, number, number];

/** The participants a quantity is measured between. */
export interface ProfileBodies {
  observer: string;
  target: string;
  /** Light source for phase angle; `Sun` when unset. */
  illuminator?: string;
}

export type ProfileQuantityId = 'range' | 'relative-speed' | 'range-rate' | 'phase-angle';

export interface ProfileQuantitySpec {
  id: ProfileQuantityId;
  /** Row label. */
  label: string;
  /**
   * The quantity's unit. Readouts and scale labels carry it, scaled (a
   * distance reads in m, km or AU); a row's label does not.
   */
  unit: string;
  /** Plotted around zero rather than fitted to [min, max]. */
  symmetric: boolean;
  format: (value: number) => string;
}

/** Relative-speed vocabulary, shared by speed and range rate. */
export function formatSpeed(kms: number): string {
  const abs = Math.abs(kms);
  if (abs < 0.001) return `${(kms * 1e6).toFixed(1)} mm/s`;
  if (abs < 1) return `${(kms * 1000).toFixed(1)} m/s`;
  return `${kms.toFixed(2)} km/s`;
}

/** Range rate is signed; negative is closing. */
export function formatRangeRate(kms: number): string {
  return `${kms >= 0 ? '+' : '−'}${formatSpeed(Math.abs(kms))}`;
}

export function formatAngle(deg: number): string {
  return `${deg.toFixed(1)}°`;
}

/**
 * The starting vocabulary. Ids match the `quantity` strings the shared
 * analysis model (`ContinuousProfileConfiguration`) documents, so a profile
 * configured elsewhere lands on the same row type.
 */
export const PROFILE_QUANTITIES: readonly ProfileQuantitySpec[] = [
  { id: 'range', label: 'Distance', unit: 'km', symmetric: false, format: formatKm },
  { id: 'relative-speed', label: 'Rel. speed', unit: 'km/s', symmetric: false, format: formatSpeed },
  { id: 'range-rate', label: 'Range rate', unit: 'km/s', symmetric: true, format: formatRangeRate },
  { id: 'phase-angle', label: 'Phase angle', unit: '°', symmetric: false, format: formatAngle },
];

export function profileQuantity(id: string): ProfileQuantitySpec | undefined {
  return PROFILE_QUANTITIES.find((q) => q.id === id);
}

/** Half-width of the central difference used for velocity terms, in s. */
const VELOCITY_DT = 0.5;

function finite(p: readonly number[]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
}

function relative(positionOf: PositionOf, bodies: ProfileBodies, et: number): [number, number, number] | null {
  const from = positionOf(bodies.observer, et);
  const to = positionOf(bodies.target, et);
  if (!finite(from) || !finite(to)) return null;
  return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
}

/**
 * One quantity at one instant, or null where either body has no state (a
 * coverage gap, a missing Sun for phase angle). Exact rather than
 * interpolated from samples, so a hover readout is as good as the live one.
 */
export function quantityAt(
  quantity: ProfileQuantityId,
  bodies: ProfileBodies,
  et: number,
  positionOf: PositionOf,
): number | null {
  if (!bodies.observer || !bodies.target || bodies.observer === bodies.target) return null;
  try {
    const r = relative(positionOf, bodies, et);
    if (!r) return null;
    const dist = Math.hypot(r[0], r[1], r[2]);

    if (quantity === 'range') return dist;

    if (quantity === 'phase-angle') {
      // Angle at the target between the illuminator and the observer.
      const target = positionOf(bodies.target, et);
      const sun = positionOf(bodies.illuminator || 'Sun', et);
      if (!finite(sun) || !finite(target)) return null;
      const ts = [sun[0] - target[0], sun[1] - target[1], sun[2] - target[2]];
      const to = [-r[0], -r[1], -r[2]];
      const magTs = Math.hypot(ts[0], ts[1], ts[2]);
      if (!(magTs > 0) || !(dist > 0)) return null;
      const cos = (ts[0] * to[0] + ts[1] * to[1] + ts[2] * to[2]) / (magTs * dist);
      return Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI);
    }

    const a = relative(positionOf, bodies, et - VELOCITY_DT);
    const b = relative(positionOf, bodies, et + VELOCITY_DT);
    if (!a || !b) return null;
    const v = [
      (b[0] - a[0]) / (2 * VELOCITY_DT),
      (b[1] - a[1]) / (2 * VELOCITY_DT),
      (b[2] - a[2]) / (2 * VELOCITY_DT),
    ];
    if (quantity === 'relative-speed') return Math.hypot(v[0], v[1], v[2]);
    // range-rate
    return dist > 0 ? (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / dist : null;
  } catch {
    return null;
  }
}

export interface ProfileSeries {
  /** Sample instants, evenly spaced across the window, endpoints included. */
  ets: number[];
  /** Value per instant; null is a gap and breaks the trace. */
  values: (number | null)[];
  /** Plot bounds — padded to a nonzero span, symmetric about 0 when asked. */
  min: number;
  max: number;
}

/**
 * Samples `count` evenly spaced instants across `window`. `limit`, when given,
 * is the profile's own configured window: instants outside it are gaps rather
 * than being silently extrapolated.
 */
export function sampleProfile(
  quantity: ProfileQuantitySpec,
  bodies: ProfileBodies,
  window: EtInterval,
  count: number,
  positionOf: PositionOf,
  limit?: EtInterval,
): ProfileSeries {
  const n = Math.max(2, Math.floor(count));
  const span = window.end - window.start;
  const ets: number[] = [];
  const values: (number | null)[] = [];
  if (!(span > 0)) return { ets, values, min: 0, max: 0 };
  for (let i = 0; i < n; i++) {
    const et = window.start + (span * i) / (n - 1);
    ets.push(et);
    const inside = !limit || (et >= limit.start && et <= limit.end);
    values.push(inside ? quantityAt(quantity.id, bodies, et, positionOf) : null);
  }
  return { ets, values, ...plotBounds(values, quantity.symmetric) };
}

export function plotBounds(values: readonly (number | null)[], symmetric: boolean): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  if (symmetric) {
    const abs = Math.max(Math.abs(min), Math.abs(max), 1e-12);
    return { min: -abs, max: abs };
  }
  if (max - min <= Math.abs(max) * 1e-12) {
    // A flat trace still needs a span to draw in; centre it.
    const pad = Math.abs(max) * 0.01 || 1;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

/** Vertical position of `value` in a row `height` tall, with a small inset. */
export function valueY(value: number, series: Pick<ProfileSeries, 'min' | 'max'>, height: number): number {
  const range = series.max - series.min || 1;
  const inset = height * 0.1;
  return height - inset - ((value - series.min) / range) * (height - 2 * inset);
}

/**
 * SVG path data for a series drawn `width` × `height`. Gaps start a new
 * subpath rather than bridging across a coverage hole.
 */
export function profilePath(series: ProfileSeries, width: number, height: number): string {
  const n = series.values.length;
  if (n < 2) return '';
  let d = '';
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = series.values[i];
    if (v == null) {
      pen = false;
      continue;
    }
    const x = (i / (n - 1)) * width;
    const y = valueY(v, series, height);
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(2)}`;
    pen = true;
  }
  return d;
}

/**
 * Display sample count for a plot `px` wide: about one sample per pixel, so
 * a curve that oscillates fast across a multi-year window is still drawn
 * rather than aliased into a smooth line. Capped for very wide plots.
 */
export function sampleCountFor(px: number): number {
  return Math.max(48, Math.min(1600, Math.round(px)));
}

/**
 * The value the *drawn* trace has at `et`: linear between the two samples
 * around it, as the polyline is. This, not the exact value, places the
 * cursor's dot, so the dot always sits on the visible line; readouts stay
 * exact. Null in a gap or outside the series.
 */
export function seriesValueAt(series: Pick<ProfileSeries, 'ets' | 'values'>, et: number): number | null {
  const { ets, values } = series;
  const n = ets.length;
  if (n < 2 || et < ets[0] || et > ets[n - 1]) return null;
  const t = ((et - ets[0]) / (ets[n - 1] - ets[0])) * (n - 1);
  const i = Math.min(n - 2, Math.floor(t));
  const f = t - i;
  const a = values[i];
  const b = values[i + 1];
  // On a sample exactly, that sample is the line, whatever lies beyond it.
  if (f === 0) return a;
  if (f === 1) return b;
  if (a == null || b == null) return null;
  return a + (b - a) * f;
}

/**
 * Whether an event belongs on a profile by default: its participants include
 * both bodies the profile measures between. A Clipper → Io closest approach
 * annotates the Clipper → Io distance; a Europa flyby does not, unless it is
 * selected or previewed.
 */
export function eventRelevantToProfile(
  participants: Readonly<Record<string, string | undefined>>,
  bodies: Pick<ProfileBodies, 'observer' | 'target'>,
): boolean {
  const names = new Set(Object.values(participants).filter((v): v is string => !!v).map((v) => v.toLowerCase()));
  return names.has(bodies.observer.toLowerCase()) && names.has(bodies.target.toLowerCase());
}

/**
 * Values for an expanded row's faint gridlines: the view's top, middle and
 * bottom. Three is enough to read a value off a 100 px row without turning
 * it into a chart; a symmetric quantity gets its zero line as the middle.
 */
export function gridValues(series: Pick<ProfileSeries, 'min' | 'max'>): number[] {
  if (!(series.max > series.min)) return [];
  return [series.max, (series.max + series.min) / 2, series.min];
}
