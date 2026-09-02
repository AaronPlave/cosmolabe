// F3: a declarative time-series evaluation spec and its interpreter. An EvalSpec
// describes a time grid and a set of providers (range, position, velocity, ...).
// runEvalSpec walks the grid once and fills one Float64Array column per output, so a
// heavy sweep is one worker round-trip instead of n. The loop yields periodically and
// checks a cancellation token, so a long job can be aborted. (STK_PARITY_SPEC F3.)

import { SpiceError, type AberrationCorrection, type SpiceEngine } from './index.ts';

/** A uniform time grid [start, stop] with step seconds (stop is included if it lands on a step). */
export interface UniformGrid {
  readonly start: number;
  readonly stop: number;
  readonly step: number;
}
/** An explicit set of sample epochs. */
export interface ExplicitGrid {
  readonly et: Float64Array | readonly number[];
}
export type EvalGrid = UniformGrid | ExplicitGrid;

/**
 * Upper bound on the number of grid samples, to fail loudly rather than attempt a
 * runaway allocation when a (possibly user-supplied) duration/step asks for an
 * unreasonable grid. 10M samples is far beyond any real analysis grid.
 */
export const MAX_GRID_SAMPLES = 10_000_000;

/** Build the sample epochs of a grid as a Float64Array. */
export function gridEpochs(grid: EvalGrid): Float64Array {
  if ('et' in grid) return grid.et instanceof Float64Array ? grid.et : Float64Array.from(grid.et);
  const { start, stop, step } = grid;
  if (!(step > 0)) throw new Error(`evalSeries grid step must be > 0, got ${step}`);
  if (stop < start) throw new Error(`evalSeries grid stop < start (${start}..${stop})`);
  const n = Math.floor((stop - start) / step + 1e-9) + 1;
  if (n > MAX_GRID_SAMPLES) {
    throw new Error(`evalSeries grid too large: ${n} samples exceeds the ${MAX_GRID_SAMPLES} cap (widen the step)`);
  }
  const et = new Float64Array(n);
  for (let i = 0; i < n; i++) et[i] = start + i * step;
  return et;
}

/** A provider computes one or more named scalar columns at each epoch. */
export type ProviderSpec =
  | { readonly kind: 'range'; readonly observer: string; readonly target: string; readonly abcorr?: AberrationCorrection }
  | { readonly kind: 'rangeRate'; readonly observer: string; readonly target: string; readonly abcorr?: AberrationCorrection }
  | { readonly kind: 'speed'; readonly observer: string; readonly target: string; readonly frame?: string; readonly abcorr?: AberrationCorrection }
  | { readonly kind: 'position'; readonly observer: string; readonly target: string; readonly frame: string; readonly abcorr?: AberrationCorrection }
  | { readonly kind: 'velocity'; readonly observer: string; readonly target: string; readonly frame: string; readonly abcorr?: AberrationCorrection }
  | { readonly kind: 'subPointLonLat'; readonly observer: string; readonly target: string; readonly frame: string; readonly abcorr?: AberrationCorrection };

export interface EvalSpec {
  readonly grid: EvalGrid;
  readonly providers: readonly ProviderSpec[];
}

/** The provider kinds, for a registry/UI to enumerate. */
export type ProviderKind = ProviderSpec['kind'];

/** Unit-tagged metadata for a provider kind: a registry the workbench enumerates. */
export interface ProviderDescriptor {
  readonly kind: ProviderKind;
  readonly label: string;
  /** Physical unit of every column this provider emits. */
  readonly unit: string;
  /** Output column names (aligns with the EvalSeries columns). */
  readonly columns: readonly string[];
  /** Whether the provider needs a reference frame (position/velocity/sub-point). */
  readonly needsFrame: boolean;
}

/** The provider registry: every evaluable quantity with its unit and columns. */
export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
  { kind: 'range', label: 'Range', unit: 'km', columns: ['range'], needsFrame: false },
  { kind: 'rangeRate', label: 'Range rate', unit: 'km/s', columns: ['rangeRate'], needsFrame: false },
  { kind: 'speed', label: 'Speed', unit: 'km/s', columns: ['speed'], needsFrame: false },
  { kind: 'position', label: 'Position', unit: 'km', columns: ['pos.x', 'pos.y', 'pos.z'], needsFrame: true },
  { kind: 'velocity', label: 'Velocity', unit: 'km/s', columns: ['vel.x', 'vel.y', 'vel.z'], needsFrame: true },
  { kind: 'subPointLonLat', label: 'Sub-point lon/lat', unit: 'rad', columns: ['lon', 'lat'], needsFrame: true },
];

/** Look up a provider descriptor by kind. */
export function describeProvider(kind: ProviderKind): ProviderDescriptor {
  const d = PROVIDER_CATALOG.find((p) => p.kind === kind);
  if (!d) throw new Error(`unknown provider kind: ${kind}`);
  return d;
}

export interface EvalSeriesResult {
  /** Sample epochs (ET seconds). */
  readonly et: Float64Array;
  /** One column per provider output, each length et.length. */
  readonly columns: Float64Array[];
  /** Column names aligned with `columns` (e.g. "range", "pos.x", "lat"). */
  readonly names: string[];
}

export interface EvalHooks {
  /** Yield to the event loop (and re-check cancellation) every this many epochs. */
  readonly yieldEvery?: number;
  /** Await this to let the worker process queued messages (a macrotask yield). */
  readonly yieldNow?: () => Promise<void>;
  /** Return true to abort the run; runEvalSpec then throws JobCancelledError. */
  readonly isCancelled?: () => boolean;
}

/** Thrown when a run is aborted via the cancellation token. */
export class JobCancelledError extends Error {
  constructor() {
    super('evalSeries job cancelled');
    this.name = 'JobCancelledError';
  }
}

/** Output column names for a provider, in order. */
export function providerColumns(p: ProviderSpec): string[] {
  // PROVIDER_CATALOG is the single source of truth for column names.
  return [...describeProvider(p.kind).columns];
}

/** Evaluate one provider at one epoch, returning its column values in order. */
async function evalProvider(engine: SpiceEngine, p: ProviderSpec, et: number): Promise<number[]> {
  const abcorr = p.abcorr ?? 'NONE';
  switch (p.kind) {
    case 'range': {
      const r = await engine.spkpos(p.target, et, 'J2000', abcorr, p.observer);
      return [Math.hypot(r.position.x, r.position.y, r.position.z)];
    }
    case 'speed': {
      const s = await engine.spkezr(p.target, et, p.frame ?? 'J2000', abcorr, p.observer);
      return [Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z)];
    }
    case 'rangeRate': {
      // d|r|/dt = (r . v) / |r| in an inertial frame.
      const s = await engine.spkezr(p.target, et, 'J2000', abcorr, p.observer);
      const { position: r, velocity: v } = s;
      const rm = Math.hypot(r.x, r.y, r.z);
      // A zero range makes d|r|/dt undefined: throw rather than divide by a faked 1.0,
      // which would emit a raw dot product (km^2/s) as if it were a range rate (km/s).
      if (rm === 0) {
        throw new SpiceError(
          `rangeRate undefined: ${p.observer}->${p.target} are coincident at et=${et} (|r|=0)`,
        );
      }
      return [(r.x * v.x + r.y * v.y + r.z * v.z) / rm];
    }
    case 'position': {
      const r = await engine.spkpos(p.target, et, p.frame, abcorr, p.observer);
      return [r.position.x, r.position.y, r.position.z];
    }
    case 'velocity': {
      const s = await engine.spkezr(p.target, et, p.frame, abcorr, p.observer);
      return [s.velocity.x, s.velocity.y, s.velocity.z];
    }
    case 'subPointLonLat': {
      // Sub-target point as planetocentric lon/lat (radians) in the body-fixed frame,
      // ready for @bessel/map-projection.
      const r = await engine.spkpos(p.target, et, p.frame, abcorr, p.observer);
      const { x, y, z } = r.position;
      const rm = Math.hypot(x, y, z);
      // A zero range has no sub-point: throw rather than clamp z/1 to a bogus +-90 lat.
      if (rm === 0) {
        throw new SpiceError(
          `subPointLonLat undefined: ${p.observer}->${p.target} are coincident at et=${et} (|r|=0)`,
        );
      }
      return [Math.atan2(y, x), Math.asin(Math.max(-1, Math.min(1, z / rm)))];
    }
  }
}

/**
 * Walk the grid once, filling one column per provider output. Yields to the event
 * loop every `yieldEvery` epochs (so a cancel message can be delivered) and aborts
 * with JobCancelledError when the token trips.
 */
export async function runEvalSpec(
  engine: SpiceEngine,
  spec: EvalSpec,
  hooks: EvalHooks = {},
): Promise<EvalSeriesResult> {
  const et = gridEpochs(spec.grid);
  const n = et.length;
  const names: string[] = [];
  for (const p of spec.providers) names.push(...providerColumns(p));
  const columns = names.map(() => new Float64Array(n));

  const yieldEvery = hooks.yieldEvery ?? 64;
  const yieldNow = hooks.yieldNow;
  const isCancelled = hooks.isCancelled;

  for (let i = 0; i < n; i++) {
    if (i > 0 && i % yieldEvery === 0) {
      if (yieldNow) await yieldNow();
      if (isCancelled?.()) throw new JobCancelledError();
    }
    let col = 0;
    for (const p of spec.providers) {
      const values = await evalProvider(engine, p, et[i]!);
      for (const v of values) columns[col++]![i] = v;
    }
  }
  if (isCancelled?.()) throw new JobCancelledError();
  return { et, columns, names };
}
