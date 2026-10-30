/**
 * Externally supplied spacecraft state — position and attitude a host streams
 * in (from Yamcs, a ground system, a planning tool), evaluated through the
 * ordinary `Trajectory` / `RotationModel` interfaces.
 *
 * The split: the host fetches; this module owns evaluation, coverage and the
 * cache. `stateAt` / `rotationAt` never touch the network — they read a bounded
 * window of samples that `focus(et)` keeps loaded around the playhead, and say
 * "unavailable" (NaN state, `StateUnavailableError`) wherever that window has
 * no data. Nothing is extrapolated or held: an operational state that ran out
 * is not shown as current.
 *
 * Bodies bind by catalog: `"trajectory": { "type": "MissionState", "source":
 * "SC-1" }` (and the same for `rotationModel`), through `UniverseOptions`'
 * factories. The catalog keeps owning models, labels, trails and sensors.
 */
import type { CartesianState, Trajectory } from './trajectories/Trajectory.js';
import { hermiteState } from './trajectories/InterpolatedStates.js';
import type { Quaternion, RotationModel } from './rotations/RotationModel.js';
import { slerp } from './rotations/InterpolatedRotation.js';
import type { DataProvenance, PluginData } from './plugins/PluginData.js';
import { StateUnavailableError, type CoverageInterval, type StateAvailability, type UnavailableReason } from './availability.js';
import { etFromCalendarString } from './time.js';
import { utcTimestamp } from './MissionActivity.js';
import type { RotationFactory, TrajectoryFactory } from './catalog/CatalogLoader.js';
import type { Universe } from './Universe.js';

export type MissionStateChannel = 'position' | 'attitude';
/** ET seconds past J2000 TDB (`TDB` sources) or an ISO 8601 UTC string ending in `Z` (`UTC` sources). */
export type SampleTime = number | string;

/** Everything needed to read a position stream without guessing. All required. */
export interface PositionConvention {
  readonly timeScale: 'TDB' | 'UTC';
  /** A frame the universe's `FrameRegistry` resolves (`J2000`, `ECLIPJ2000`, `IAU_MARS`, a SPICE frame). */
  readonly frame: string;
  /** The body positions are relative to. Must be the catalog item's `center`. */
  readonly center: string;
  readonly positionUnits: 'km' | 'm';
  readonly velocityUnits: 'km/s' | 'm/s';
  /** Widest sample spacing (s) interpolated across; anything wider is a gap. */
  readonly maxSampleSpacing: number;
}

/** Everything needed to read an attitude stream without guessing. All required. */
export interface AttitudeConvention {
  readonly timeScale: 'TDB' | 'UTC';
  readonly quaternionOrder: 'scalar-first' | 'scalar-last';
  /** The frame the attitude is stated against, resolvable by the `FrameRegistry`. */
  readonly referenceFrame: string;
  /** The spacecraft frame the attitude is of (e.g. `SC1_BUS`). */
  readonly bodyFrame: string;
  /**
   * Which way the quaternion transforms vector *coordinates*:
   * `reference-to-body` means v_body = q ⊗ v_ref ⊗ q* (SPICE's C-matrix sense,
   * CCSDS AEM `A2B` with A the reference); `body-to-reference` is its conjugate.
   */
  readonly direction: 'reference-to-body' | 'body-to-reference';
  readonly maxSampleSpacing: number;
}

export interface PositionSample { readonly t: SampleTime; readonly position: readonly number[]; readonly velocity: readonly number[] }
export interface AttitudeSample { readonly t: SampleTime; readonly quaternion: readonly number[] }

/**
 * Samples plus the window they are complete for. Inside `window`, the absence
 * of samples is a real gap — not "not fetched" — and a later batch replaces
 * what an earlier one said about the same window.
 */
export interface StateBatch<S> {
  readonly window: { readonly start: SampleTime; readonly end: SampleTime };
  readonly samples: readonly S[];
}
export type PositionBatch = StateBatch<PositionSample>;
export type AttitudeBatch = StateBatch<AttitudeSample>;
/** Batches cross the #179 authority boundary: adapter-issued `HostData`, or `ExploratoryData`. */
export type SuppliedBatch = PluginData<PositionBatch | AttitudeBatch>;

/** Handed to a live source: where it pushes, and how it reports its link. */
export interface MissionStateSink {
  push(channel: MissionStateChannel, batch: SuppliedBatch): void;
  setConnection(state: 'live' | 'disconnected'): void;
  /** Move the end of the declared coverage as live data grows. */
  extendCoverage(channel: MissionStateChannel, end: SampleTime): void;
}

/** What a host implements. Backend specifics (Yamcs, …) stay on the host side. */
export interface MissionStateSource {
  /** Stable identifier; catalogs bind to it. */
  readonly id: string;
  readonly position?: PositionConvention;
  readonly attitude?: AttitudeConvention;
  /** What the source can serve, when known: drives before/after-coverage and the playback range. */
  readonly coverage?: Partial<Record<MissionStateChannel, { readonly start: SampleTime; readonly end: SampleTime }>>;
  /** Seconds kept loaded behind / ahead of the playhead. Defaults 3600 / 900. */
  readonly prefetch?: { readonly behind?: number; readonly ahead?: number };
  /** Retention bound per channel. Default 50 000 samples. */
  readonly maxSamples?: number;
  /** A connected live feed silent for longer than this is reported `stale`. Default 10 000 ms. */
  readonly staleAfterMs?: number;
  /** Historical window fetch, in ET. Must honour `signal`; late answers are discarded anyway. */
  request?(channel: MissionStateChannel, window: CoverageInterval, signal: AbortSignal): Promise<SuppliedBatch>;
  /** Live feed. Returns an unsubscribe. */
  subscribe?(sink: MissionStateSink): () => void;
}

/** A source's coverage as Cosmolabe currently knows it. */
export interface ChannelCoverage {
  readonly declared?: CoverageInterval;
  /** Windows answered (complete), whether or not they held samples. */
  readonly loaded: readonly CoverageInterval[];
  /** Intervals that can be evaluated now. */
  readonly evaluable: readonly CoverageInterval[];
  readonly samples: number;
  readonly error?: string;
}
export interface SourceStatus {
  readonly id: string;
  readonly connection: 'live' | 'disconnected' | 'none';
  readonly position?: ChannelCoverage;
  readonly attitude?: ChannelCoverage;
}

export interface MissionStateChange { readonly sourceId: string; readonly channel?: MissionStateChannel }

const DEFAULT_BEHIND = 3600;
const DEFAULT_AHEAD = 900;
const DEFAULT_MAX_SAMPLES = 50_000;
const DEFAULT_STALE_MS = 10_000;
const RETRY_AFTER_MS = 2_000;
const QUATERNION_NORM_TOLERANCE = 1e-3;

// ── interval helpers (sorted, disjoint, inclusive) ──

function union(list: readonly CoverageInterval[], iv: CoverageInterval): CoverageInterval[] {
  const out: CoverageInterval[] = [];
  let { start, end } = iv;
  for (const x of list) {
    if (x.end < start || x.start > end) out.push(x);
    else { start = Math.min(start, x.start); end = Math.max(end, x.end); }
  }
  out.push({ start, end });
  return out.sort((a, b) => a.start - b.start);
}

function subtract(list: readonly CoverageInterval[], cut: CoverageInterval): CoverageInterval[] {
  const out: CoverageInterval[] = [];
  for (const x of list) {
    if (x.end <= cut.start || x.start >= cut.end) { out.push(x); continue; }
    if (x.start < cut.start) out.push({ start: x.start, end: cut.start });
    if (x.end > cut.end) out.push({ start: cut.end, end: x.end });
  }
  return out;
}

function clip(list: readonly CoverageInterval[], to: CoverageInterval): CoverageInterval[] {
  return list.flatMap((x) => {
    const start = Math.max(x.start, to.start), end = Math.min(x.end, to.end);
    return end >= start ? [{ start, end }] : [];
  });
}

const within = (list: readonly CoverageInterval[], t: number) => list.some((x) => t >= x.start && t <= x.end);
const covers = (list: readonly CoverageInterval[], iv: CoverageInterval) =>
  iv.end <= iv.start || list.reduce<CoverageInterval[]>((rest, x) => rest.flatMap((r) => subtract([r], x)), [iv]).length === 0;

/** Index of the last sample at or before `t`, or -1. */
function floorIndex(times: readonly number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

// ── conventions and samples ──

function toEt(t: SampleTime, scale: 'TDB' | 'UTC', what: string): number {
  if (scale === 'TDB') {
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error(`${what}: TDB times are ET seconds (finite numbers); got ${JSON.stringify(t)}`);
    return t;
  }
  // UTC goes through core's leap-second-exact calendar parse, never Date math.
  if (typeof t !== 'string' || !utcTimestamp(t)) throw new Error(`${what}: UTC times are ISO 8601 strings ending in Z; got ${JSON.stringify(t)}`);
  const et = etFromCalendarString(t);
  if (!Number.isFinite(et)) throw new Error(`${what}: cannot convert UTC ${t}`);
  return et;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${what} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`);
  return value as T;
}

function frameName(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is required`);
  // BODY_FIXED is relative to whatever the centre is: an ambiguity, not a frame.
  if (/^BODY_?FIXED$/i.test(value.trim())) throw new Error(`${what}: name the body-fixed frame explicitly (e.g. IAU_EARTH), not BODY_FIXED`);
  return value.trim();
}

function spacing(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${what}.maxSampleSpacing must be a positive number of seconds`);
  return value;
}

function validatePosition(c: PositionConvention, id: string): PositionConvention {
  const what = `source ${id} position`;
  oneOf(c.timeScale, ['TDB', 'UTC'], `${what}.timeScale`);
  frameName(c.frame, `${what}.frame`);
  if (typeof c.center !== 'string' || !c.center.trim()) throw new Error(`${what}.center is required`);
  oneOf(c.positionUnits, ['km', 'm'], `${what}.positionUnits`);
  oneOf(c.velocityUnits, ['km/s', 'm/s'], `${what}.velocityUnits`);
  spacing(c.maxSampleSpacing, what);
  return Object.freeze({ ...c });
}

function validateAttitude(c: AttitudeConvention, id: string): AttitudeConvention {
  const what = `source ${id} attitude`;
  oneOf(c.timeScale, ['TDB', 'UTC'], `${what}.timeScale`);
  oneOf(c.quaternionOrder, ['scalar-first', 'scalar-last'], `${what}.quaternionOrder`);
  oneOf(c.direction, ['reference-to-body', 'body-to-reference'], `${what}.direction`);
  frameName(c.referenceFrame, `${what}.referenceFrame`);
  frameName(c.bodyFrame, `${what}.bodyFrame`);
  spacing(c.maxSampleSpacing, what);
  return Object.freeze({ ...c });
}

function finiteVector(v: unknown, n: number, what: string): number[] {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error(`${what} must be ${n} finite numbers`);
  }
  return v as number[];
}

/** One stored sample's provenance, shared by every sample of its batch. */
interface SampleMeta {
  readonly authority: 'host' | 'exploratory';
  readonly provenance: DataProvenance;
  readonly classification?: DataProvenance['classification'];
}

class Channel {
  times: number[] = [];
  /** Position: [x, y, z, vx, vy, vz] km, km/s. Attitude: [w, x, y, z], reference→body. */
  values: number[][] = [];
  meta: SampleMeta[] = [];
  loaded: CoverageInterval[] = [];
  /**
   * Where interpolation is valid: the union of answered windows, minus windows
   * answered explicitly empty. Two samples are blended only when one interval
   * here spans both — never across a window nobody served.
   */
  segments: CoverageInterval[] = [];
  /** Windows answered by non-`planned` data, which predicted data never overwrites. */
  observed: CoverageInterval[] = [];
  inflight = new Set<{ window: CoverageInterval; controller: AbortController }>();
  failure?: { window: CoverageInterval; message: string; at: number };
  declared?: CoverageInterval;
  /** Rejected against the bound catalog (frame, centre). */
  error?: string;
  constructor(readonly kind: MissionStateChannel, readonly convention: PositionConvention | AttitudeConvention) {}

  abortAll(): void {
    for (const req of this.inflight) req.controller.abort();
    this.inflight.clear();
  }
}

class SourceEntry {
  readonly channels: Partial<Record<MissionStateChannel, Channel>> = {};
  connection: 'live' | 'disconnected' | 'none' = 'none';
  lastPush = -Infinity;
  unsubscribe?: () => void;
  invalidateTimer?: ReturnType<typeof setTimeout>;
  constructor(readonly source: MissionStateSource, readonly generation: number) {}
}

function sourceIdOf(spec: unknown, what: string): string {
  const source = (spec as { source?: unknown }).source;
  if (typeof source !== 'string' || !source.trim()) throw new Error(`${what} MissionState requires a "source" naming the host's mission-state source`);
  return source;
}

/**
 * Owns the sources, their bounded sample caches, and the request orchestration.
 *
 * One per viewer, outliving catalog loads: bodies re-bind by source ID on each
 * load, and cached samples remain valid because they belong to the source, not
 * to the scene.
 */
export class MissionStateManager {
  private readonly entries = new Map<string, SourceEntry>();
  private readonly listeners = new Set<(change: MissionStateChange) => void>();
  private universe: Universe | null = null;
  private focusEt: number | null = null;
  private generation = 0;
  private disposed = false;
  private readonly now: () => number;
  private readonly invalidateDelayMs: number;

  constructor(options: { now?: () => number; invalidateDelayMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.invalidateDelayMs = options.invalidateDelayMs ?? 200;
  }

  /** `UniverseOptions.trajectoryFactories` entry: `{ "type": "MissionState", "source": id }`. */
  readonly trajectoryFactories: Record<string, TrajectoryFactory> = {
    MissionState: ({ spec, item }) => new MissionStateTrajectory(this, sourceIdOf(spec, `${item.name} trajectory`)),
  };
  readonly rotationFactories: Record<string, RotationFactory> = {
    MissionState: ({ spec, item }) => new MissionStateRotation(this, sourceIdOf(spec, `${item.name} rotation`)),
  };

  // ── sources ──

  addSource(source: MissionStateSource): void {
    this.assertLive();
    if (!source || typeof source.id !== 'string' || !source.id.trim()) throw new Error('mission-state source id is required');
    if (this.entries.has(source.id)) throw new Error(`mission-state source "${source.id}" already exists; use replaceSource`);
    this.install(source);
  }

  /** Atomically swap a source: its cache is dropped and any late answer for the old one discarded. */
  replaceSource(source: MissionStateSource): void {
    this.assertLive();
    const old = this.entries.get(source?.id);
    if (!old) throw new Error(`no mission-state source "${source?.id}" to replace`);
    this.install(source, old);
  }

  removeSource(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.release(entry);
    this.entries.delete(id);
    this.invalidateBodies(id);
    this.emit({ sourceId: id });
    return true;
  }

  sourceIds(): string[] { return [...this.entries.keys()]; }

  status(id: string): SourceStatus | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const channel = (ch?: Channel): ChannelCoverage | undefined => ch && {
      declared: ch.declared, loaded: [...ch.loaded], evaluable: evaluableRuns(ch), samples: ch.times.length,
      error: ch.error,
    };
    return { id, connection: entry.connection, position: channel(entry.channels.position), attitude: channel(entry.channels.attitude) };
  }

  onChange(listener: (change: MissionStateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── binding and focus ──

  /** Bind to the scene's universe (or none): validates sources against the catalog bodies that name them. */
  bind(universe: Universe | null): void {
    if (this.universe === universe) return;
    for (const entry of this.entries.values()) for (const ch of Object.values(entry.channels)) ch.abortAll();
    this.universe = universe;
    for (const entry of this.entries.values()) this.validateBinding(entry);
    if (universe && this.focusEt !== null) this.focus(this.focusEt);
  }

  /**
   * Keep data loaded around `et`. Cheap to call every frame: it requests only
   * once the playhead nears the edge of what is loaded or in flight, and
   * aborts requests that no longer overlap the window it wants.
   */
  focus(et: number): void {
    if (this.disposed || !Number.isFinite(et)) return;
    this.focusEt = et;
    for (const entry of this.entries.values()) {
      for (const ch of Object.values(entry.channels)) this.plan(entry, ch, et);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
    this.listeners.clear();
    this.universe = null;
    this.disposed = true;
  }

  // ── evaluation (no I/O) ──

  positionConvention(id: string): PositionConvention | undefined {
    return this.entries.get(id)?.source.position;
  }

  attitudeConvention(id: string): AttitudeConvention | undefined {
    return this.entries.get(id)?.source.attitude;
  }

  /** Overall known extent of a channel: declared coverage, else the samples held. */
  extent(id: string, kind: MissionStateChannel): CoverageInterval | undefined {
    const ch = this.entries.get(id)?.channels[kind];
    if (!ch) return undefined;
    if (ch.declared) return ch.declared;
    return ch.times.length ? { start: ch.times[0], end: ch.times[ch.times.length - 1] } : undefined;
  }

  availability(id: string, kind: MissionStateChannel, et: number): StateAvailability {
    const entry = this.entries.get(id);
    const ch = entry?.channels[kind];
    if (!entry || !ch) {
      return { available: false, reason: 'unbound', sourceId: id,
        message: entry ? `Source "${id}" supplies no ${kind}.` : `No mission-state source "${id}" is registered.` };
    }
    const i = this.bracket(ch, et);
    if (i >= 0) {
      // Between two samples, the later one's provenance (both share authority and classification).
      const meta = ch.meta[ch.times[i] === et ? i : i + 1];
      return {
        available: true, sourceId: id, coverage: [runAround(ch, i)],
        classification: meta.classification, authority: meta.authority, provenance: meta.provenance,
      };
    }
    const reason = this.unavailableReason(entry, ch, et);
    return { available: false, sourceId: id, reason: reason.reason, message: reason.message, coverage: nearestRuns(ch, et) };
  }

  evaluatePosition(id: string, et: number): CartesianState {
    const ch = this.entries.get(id)?.channels.position;
    const i = ch ? this.bracket(ch, et) : -1;
    if (!ch || i < 0) return { position: [NaN, NaN, NaN], velocity: [NaN, NaN, NaN] };
    const a = ch.values[i];
    if (ch.times[i] === et || i + 1 >= ch.times.length) {
      return { position: [a[0], a[1], a[2]], velocity: [a[3], a[4], a[5]] };
    }
    const b = ch.values[i + 1];
    return hermiteState(
      { et: ch.times[i], position: [a[0], a[1], a[2]], velocity: [a[3], a[4], a[5]] },
      { et: ch.times[i + 1], position: [b[0], b[1], b[2]], velocity: [b[3], b[4], b[5]] },
      et,
    );
  }

  evaluateAttitude(id: string, et: number): Quaternion {
    const ch = this.entries.get(id)?.channels.attitude;
    const i = ch ? this.bracket(ch, et) : -1;
    if (!ch || i < 0) throw new StateUnavailableError(this.availability(id, 'attitude', et));
    const a = ch.values[i] as Quaternion;
    if (ch.times[i] === et || i + 1 >= ch.times.length) return [a[0], a[1], a[2], a[3]];
    const q = slerp(a, ch.values[i + 1] as Quaternion, (et - ch.times[i]) / (ch.times[i + 1] - ch.times[i]));
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }

  // ── internals ──

  /** The interpolation bracket's lower index, or -1 when `et` has no data within the declared spacing. */
  private bracket(ch: Channel, et: number): number {
    if (ch.error) return -1;
    const i = floorIndex(ch.times, et);
    if (i < 0) return -1;
    if (ch.times[i] === et) return i;
    return linked(ch, i) ? i : -1;
  }

  private unavailableReason(entry: SourceEntry, ch: Channel, et: number): { reason: UnavailableReason; message: string } {
    if (ch.error) return { reason: 'error', message: ch.error };
    const last = ch.times.length ? ch.times[ch.times.length - 1] : -Infinity;
    const first = ch.times.length ? ch.times[0] : Infinity;
    const afterLast = (): { reason: UnavailableReason; message: string } => {
      if (entry.connection === 'disconnected') return { reason: 'disconnected', message: 'Live feed disconnected; no state after its last sample.' };
      if (entry.connection === 'live') {
        const silent = this.now() - entry.lastPush;
        const limit = entry.source.staleAfterMs ?? DEFAULT_STALE_MS;
        return silent > limit
          ? { reason: 'stale', message: `Live feed silent for ${(silent / 1000).toFixed(0)} s; no state after its last sample.` }
          : { reason: 'pending', message: 'Awaiting live data.' };
      }
      return { reason: 'after-coverage', message: 'After the source\'s last sample.' };
    };
    if (ch.declared && et < ch.declared.start) return { reason: 'before-coverage', message: 'Before the source\'s coverage.' };
    if (ch.declared && et > ch.declared.end) return afterLast();
    if (!within(ch.loaded, et)) {
      if (ch.failure && et >= ch.failure.window.start && et <= ch.failure.window.end) return { reason: 'error', message: ch.failure.message };
      if (!ch.declared && et > last && entry.connection !== 'none') return afterLast();
      return { reason: 'pending', message: [...ch.inflight].some((r) => et >= r.window.start && et <= r.window.end) ? 'Requested from the source.' : 'Not loaded.' };
    }
    if (!ch.declared && et < first) return { reason: 'before-coverage', message: 'Before the first sample the source holds.' };
    if (!ch.declared && et > last) return afterLast();
    const i = floorIndex(ch.times, et);
    if (i >= 0 && i + 1 < ch.times.length && ch.times[i + 1] - ch.times[i] <= ch.convention.maxSampleSpacing) {
      return compatible(ch.meta[i], ch.meta[i + 1])
        ? { reason: 'gap', message: 'The source served no data between the samples on either side.' }
        : { reason: 'gap', message: 'The samples on either side differ in authority or classification (e.g. observed and planned); they are not blended.' };
    }
    return { reason: 'gap', message: `No samples within ${ch.convention.maxSampleSpacing} s of this epoch.` };
  }

  private plan(entry: SourceEntry, ch: Channel, et: number): void {
    const { source } = entry;
    if (!source.request || ch.error || !this.universe) return;
    const behind = source.prefetch?.behind ?? DEFAULT_BEHIND;
    const ahead = source.prefetch?.ahead ?? DEFAULT_AHEAD;
    const bound = (iv: CoverageInterval) => (ch.declared ? clip([iv], ch.declared) : [iv]);
    const want = bound({ start: et - behind, end: et + ahead });
    if (want.length === 0) return;
    // Obsolete: requests the window no longer overlaps. Their answers would be
    // dropped anyway; aborting lets the host stop the work.
    for (const req of ch.inflight) {
      if (req.window.end < want[0].start || req.window.start > want[0].end) {
        req.controller.abort();
        ch.inflight.delete(req);
      }
    }
    // A window that just failed counts as held until its retry is due.
    const backoff = ch.failure && this.now() - ch.failure.at < RETRY_AFTER_MS ? [ch.failure.window] : [];
    const held = [...ch.loaded, ...[...ch.inflight].map((r) => r.window), ...backoff];
    // Hysteresis: refill only once the inner half of the window is uncovered,
    // so steady playback asks for chunks rather than a sliver per frame.
    const inner = bound({ start: et - behind / 2, end: et + ahead / 2 });
    if (inner.every((iv) => covers(held, iv))) return;
    let missing = want;
    for (const h of held) missing = missing.flatMap((m) => subtract([m], h));
    for (const window of missing) if (window.end > window.start) this.fetch(entry, ch, window);
  }

  private fetch(entry: SourceEntry, ch: Channel, window: CoverageInterval): void {
    const controller = new AbortController();
    const req = { window, controller };
    ch.inflight.add(req);
    let pending: Promise<SuppliedBatch>;
    try {
      pending = Promise.resolve(entry.source.request!(ch.kind, window, controller.signal));
    } catch (err) {
      pending = Promise.reject(err);
    }
    const current = () => !controller.signal.aborted && this.entries.get(entry.source.id) === entry && !this.disposed;
    pending.then(
      (batch) => {
        if (!current()) return;
        ch.inflight.delete(req);
        try {
          this.ingest(entry, ch, batch);
          // An answer narrower than the request leaves a hole; back off rather
          // than re-requesting it every frame.
          if (!covers(ch.loaded, window)) throw new Error('the answer did not cover the requested window');
        } catch (err) {
          this.fail(entry, ch, window, err);
        }
      },
      (err) => {
        if (!current()) return;
        ch.inflight.delete(req);
        this.fail(entry, ch, window, err);
      },
    );
  }

  private fail(entry: SourceEntry, ch: Channel, window: CoverageInterval, err: unknown): void {
    ch.failure = { window, message: `Source request failed: ${err instanceof Error ? err.message : String(err)}`, at: this.now() };
    this.emit({ sourceId: entry.source.id, channel: ch.kind });
  }

  /** Validate a whole batch, then apply it. An invalid batch changes nothing. */
  private ingest(entry: SourceEntry, ch: Channel, data: SuppliedBatch): void {
    const what = `source ${entry.source.id} ${ch.kind} batch`;
    if (!data || (data.authority !== 'host' && data.authority !== 'exploratory') || !data.provenance || typeof data.provenance.id !== 'string') {
      throw new Error(`${what} must be PluginData (HostDataAdapter.supply or exploratoryData) with provenance`);
    }
    const batch = data.value;
    if (!batch || !batch.window || !Array.isArray(batch.samples)) throw new Error(`${what} needs a window and samples`);
    const scale = ch.convention.timeScale;
    const window = { start: toEt(batch.window.start, scale, `${what} window`), end: toEt(batch.window.end, scale, `${what} window`) };
    if (window.end < window.start) throw new Error(`${what}: window ends before it starts`);
    const parsed: { t: number; v: number[] }[] = [];
    for (const [n, s] of batch.samples.entries()) {
      const t = toEt(s?.t, scale, `${what} sample ${n}`);
      if (t < window.start || t > window.end) throw new Error(`${what} sample ${n} lies outside the batch window`);
      parsed.push({ t, v: ch.kind === 'position' ? this.normalizePosition(s as PositionSample, `${what} sample ${n}`, ch) : normalizeQuaternion(s as AttitudeSample, `${what} sample ${n}`, ch.convention as AttitudeConvention) });
    }
    parsed.sort((a, b) => a.t - b.t);
    for (let k = 1; k < parsed.length; k++) if (parsed[k].t === parsed[k - 1].t) throw new Error(`${what}: duplicate sample time ${parsed[k].t}`);

    const meta: SampleMeta = Object.freeze({ authority: data.authority, provenance: data.provenance, classification: data.provenance.classification });
    const planned = meta.classification === 'planned';
    // Predicted data never overwrites observed data; everything else, latest wins.
    const replace = planned ? ch.observed.reduce<CoverageInterval[]>((rest, o) => rest.flatMap((r) => subtract([r], o)), [window]) : [window];
    // Observed instants, boundaries included, are shielded from predicted data.
    const shielded = (t: number) => planned && within(ch.observed, t);
    const keep = (t: number) => !within([window], t) || shielded(t);
    const incoming = parsed.filter((p) => !shielded(p.t));
    const times: number[] = [], values: number[][] = [], metas: SampleMeta[] = [];
    let a = 0, b = 0;
    while (a < ch.times.length || b < incoming.length) {
      const takeOld = b >= incoming.length || (a < ch.times.length && ch.times[a] < incoming[b].t);
      if (takeOld) {
        if (keep(ch.times[a])) { times.push(ch.times[a]); values.push(ch.values[a]); metas.push(ch.meta[a]); }
        a++;
      } else {
        times.push(incoming[b].t); values.push(incoming[b].v); metas.push(meta);
        b++;
      }
    }
    ch.times = times; ch.values = values; ch.meta = metas;
    ch.loaded = union(ch.loaded, window);
    // An empty answer is the source saying "nothing here": a hard break.
    ch.segments = parsed.length ? union(ch.segments, window) : replace.reduce((segs, r) => segs.flatMap((x) => subtract([x], r)), ch.segments);
    if (!planned) ch.observed = union(ch.observed, window);
    if (ch.failure && ch.failure.window.start >= window.start && ch.failure.window.end <= window.end) ch.failure = undefined;
    this.evict(entry, ch);
    this.changed(entry, ch.kind);
  }

  private normalizePosition(s: PositionSample, what: string, ch: Channel): number[] {
    const c = ch.convention as PositionConvention;
    const p = finiteVector(s?.position, 3, `${what} position`);
    const v = finiteVector(s?.velocity, 3, `${what} velocity`);
    const ps = c.positionUnits === 'm' ? 1e-3 : 1;
    const vs = c.velocityUnits === 'm/s' ? 1e-3 : 1;
    return [p[0] * ps, p[1] * ps, p[2] * ps, v[0] * vs, v[1] * vs, v[2] * vs];
  }

  /** Bound memory: drop the samples farthest from the playhead and forget those windows were loaded. */
  private evict(entry: SourceEntry, ch: Channel): void {
    const max = entry.source.maxSamples ?? DEFAULT_MAX_SAMPLES;
    if (ch.times.length <= max) return;
    const focus = this.focusEt ?? ch.times[ch.times.length - 1];
    let lo = 0, hi = ch.times.length;
    while (hi - lo > max) {
      if (Math.abs(ch.times[lo] - focus) > Math.abs(ch.times[hi - 1] - focus)) lo++; else hi--;
    }
    const keepFrom = lo > 0 ? ch.times[lo] : -Infinity;
    const keepTo = hi < ch.times.length ? ch.times[hi - 1] : Infinity;
    ch.times = ch.times.slice(lo, hi); ch.values = ch.values.slice(lo, hi); ch.meta = ch.meta.slice(lo, hi);
    ch.loaded = clip(ch.loaded, { start: keepFrom, end: keepTo });
    ch.segments = clip(ch.segments, { start: keepFrom, end: keepTo });
    ch.observed = clip(ch.observed, { start: keepFrom, end: keepTo });
  }

  private prepare(source: MissionStateSource, generation: number): SourceEntry {
    if (!source.position && !source.attitude) throw new Error(`mission-state source "${source.id}" declares neither position nor attitude`);
    if (source.request !== undefined && typeof source.request !== 'function') throw new Error(`source ${source.id}.request must be a function`);
    if (source.subscribe !== undefined && typeof source.subscribe !== 'function') throw new Error(`source ${source.id}.subscribe must be a function`);
    const bound = (value: unknown, what: string, min: number, integer = false) => {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value)))) {
        throw new Error(`source ${source.id}.${what} must be ${integer ? 'an integer' : 'a finite number'} >= ${min}; got ${JSON.stringify(value)}`);
      }
    };
    bound(source.maxSamples, 'maxSamples', 2, true);
    bound(source.prefetch?.behind, 'prefetch.behind', 0);
    bound(source.prefetch?.ahead, 'prefetch.ahead', 0);
    bound(source.staleAfterMs, 'staleAfterMs', 0);
    const entry = new SourceEntry(source, generation);
    if (source.position) entry.channels.position = new Channel('position', validatePosition(source.position, source.id));
    if (source.attitude) entry.channels.attitude = new Channel('attitude', validateAttitude(source.attitude, source.id));
    for (const ch of Object.values(entry.channels)) {
      const declared = source.coverage?.[ch.kind];
      if (declared) {
        const iv = { start: toEt(declared.start, ch.convention.timeScale, `source ${source.id} ${ch.kind} coverage`), end: toEt(declared.end, ch.convention.timeScale, `source ${source.id} ${ch.kind} coverage`) };
        if (iv.end < iv.start) throw new Error(`source ${source.id} ${ch.kind} coverage ends before it starts`);
        ch.declared = iv;
      }
    }
    return entry;
  }

  /** Install `source`; the entry it replaces is released only once the newcomer is validated and subscribed. */
  private install(source: MissionStateSource, replacing?: SourceEntry): void {
    const entry = this.prepare(source, ++this.generation);
    this.entries.set(source.id, entry);
    this.validateBinding(entry);
    if (source.subscribe) {
      entry.connection = 'live';
      entry.lastPush = this.now();
      const current = () => this.entries.get(source.id) === entry && !this.disposed;
      const sink: MissionStateSink = {
        push: (channel, batch) => {
          if (!current()) return;
          const ch = entry.channels[channel];
          if (!ch) throw new Error(`source ${source.id} declares no ${channel}`);
          this.ingest(entry, ch, batch);
          entry.lastPush = this.now();
        },
        setConnection: (state) => {
          if (!current()) return;
          entry.connection = oneOf(state, ['live', 'disconnected'], `source ${source.id} connection`);
          if (state === 'live') entry.lastPush = this.now();
          this.emit({ sourceId: source.id });
        },
        extendCoverage: (channel, end) => {
          if (!current()) return;
          const ch = entry.channels[channel];
          if (!ch) throw new Error(`source ${source.id} declares no ${channel}`);
          const et = toEt(end, ch.convention.timeScale, `source ${source.id} ${channel} coverage`);
          ch.declared = { start: Math.min(ch.declared?.start ?? et, et), end: Math.max(ch.declared?.end ?? et, et) };
          this.emit({ sourceId: source.id, channel });
        },
      };
      try {
        entry.unsubscribe = source.subscribe(sink);
      } catch (err) {
        // The previous source (if any) keeps working, untouched.
        if (replacing) this.entries.set(source.id, replacing); else this.entries.delete(source.id);
        throw err;
      }
    }
    if (replacing) this.release(replacing);
    this.invalidateBodies(source.id);
    this.emit({ sourceId: source.id });
    if (this.focusEt !== null) this.focus(this.focusEt);
  }

  private release(entry: SourceEntry): void {
    for (const ch of Object.values(entry.channels)) ch.abortAll();
    clearTimeout(entry.invalidateTimer);
    try { entry.unsubscribe?.(); } catch (err) { console.warn(`[Cosmolabe] mission-state source ${entry.source.id} unsubscribe failed:`, err); }
    entry.unsubscribe = undefined;
  }

  /**
   * Check a source against the catalog bodies bound to it: the centre must be
   * the item's `center`, a declared `trajectoryFrame` must agree, and every
   * frame must resolve. A mismatch makes the channel unavailable with the
   * reason, rather than being reinterpreted.
   */
  private validateBinding(entry: SourceEntry): void {
    const u = this.universe;
    for (const ch of Object.values(entry.channels)) ch.error = undefined;
    if (!u) return;
    const id = entry.source.id;
    const pos = entry.channels.position, att = entry.channels.attitude;
    const resolvable = (frame: string) => u.frames.get(frame) !== undefined && u.frames.isResolvable(frame, u.time);
    for (const body of u.getAllBodies()) {
      if (pos && body.trajectory instanceof MissionStateTrajectory && body.trajectory.sourceId === id) {
        const c = pos.convention as PositionConvention;
        if (body.parentName !== c.center) pos.error = `Source "${id}" positions are relative to ${c.center}, but ${body.name}'s catalog center is ${body.parentName ?? 'none'}.`;
        else if (body.declaredFrame && !u.frames.sameFrame(body.declaredFrame, c.frame)) pos.error = `Source "${id}" positions are in ${c.frame}, but ${body.name} declares trajectoryFrame ${body.declaredFrame}.`;
        else if (!resolvable(c.frame)) pos.error = `Frame ${c.frame} (source "${id}") cannot be resolved in this scene.`;
      }
      if (att && body.rotation instanceof MissionStateRotation && body.rotation.sourceId === id) {
        const c = att.convention as AttitudeConvention;
        if (!resolvable(c.referenceFrame)) att.error = `Frame ${c.referenceFrame} (source "${id}" attitude) cannot be resolved in this scene.`;
      }
    }
    for (const ch of Object.values(entry.channels)) {
      if (ch.error) { ch.abortAll(); console.warn(`[Cosmolabe] ${ch.error}`); }
    }
  }

  private changed(entry: SourceEntry, kind: MissionStateChannel): void {
    if (kind === 'position' && entry.invalidateTimer === undefined) {
      // Trails resample on invalidation; coalesce a live feed's batches.
      entry.invalidateTimer = setTimeout(() => {
        entry.invalidateTimer = undefined;
        if (this.entries.get(entry.source.id) === entry) this.invalidateBodies(entry.source.id);
      }, this.invalidateDelayMs);
    }
    this.emit({ sourceId: entry.source.id, channel: kind });
  }

  /** Re-announce the bound bodies' trajectories so trail caches for those bodies alone are rebuilt. */
  private invalidateBodies(id: string): void {
    for (const body of this.universe?.getAllBodies() ?? []) {
      if (body.trajectory instanceof MissionStateTrajectory && body.trajectory.sourceId === id) body.setTrajectory(body.trajectory);
    }
  }

  private emit(change: MissionStateChange): void {
    for (const listener of this.listeners) {
      try { listener(change); } catch (err) { console.error('[Cosmolabe] mission-state listener failed:', err); }
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('MissionStateManager has been disposed');
  }
}

function normalizeQuaternion(s: AttitudeSample, what: string, c: AttitudeConvention): number[] {
  const raw = finiteVector(s?.quaternion, 4, `${what} quaternion`);
  let q = c.quaternionOrder === 'scalar-first' ? [raw[0], raw[1], raw[2], raw[3]] : [raw[3], raw[0], raw[1], raw[2]];
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (Math.abs(n - 1) > QUATERNION_NORM_TOLERANCE) throw new Error(`${what} quaternion is not unit length (|q| = ${n})`);
  q = q.map((x) => x / n);
  // RotationModel's convention is reference→body; a body→reference quaternion is its conjugate.
  return c.direction === 'reference-to-body' ? q : [q[0], -q[1], -q[2], -q[3]];
}

/** Interpolation may blend the same authority and classification only. */
const compatible = (a: SampleMeta, b: SampleMeta) => a.authority === b.authority && a.classification === b.classification;

/**
 * Whether samples `i` and `i + 1` may be interpolated between: close enough,
 * inside one served segment, and of compatible provenance.
 */
function linked(ch: Channel, i: number): boolean {
  if (i < 0 || i + 1 >= ch.times.length) return false;
  const a = ch.times[i], b = ch.times[i + 1];
  return b - a <= ch.convention.maxSampleSpacing
    && ch.segments.some((s) => s.start <= a && b <= s.end)
    && compatible(ch.meta[i], ch.meta[i + 1]);
}

/** The contiguous evaluable run containing sample `i`. */
function runAround(ch: Channel, i: number): CoverageInterval {
  let a = i, b = i;
  while (linked(ch, a - 1)) a--;
  while (linked(ch, b)) b++;
  return { start: ch.times[a], end: ch.times[b] };
}

function evaluableRuns(ch: Channel): CoverageInterval[] {
  const runs: CoverageInterval[] = [];
  for (let i = 0; i < ch.times.length;) {
    const run = runAround(ch, i);
    runs.push(run);
    i = floorIndex(ch.times, run.end) + 1;
  }
  return runs;
}

/** The evaluable runs on either side of an epoch with no data — what a fault display names. */
function nearestRuns(ch: Channel, et: number): CoverageInterval[] {
  if (ch.error || ch.times.length === 0) return [];
  const i = floorIndex(ch.times, et);
  const out: CoverageInterval[] = [];
  if (i >= 0) out.push(runAround(ch, i));
  if (i + 1 < ch.times.length) out.push(runAround(ch, i + 1));
  return out;
}

/** A body trajectory read from a host mission-state source. */
export class MissionStateTrajectory implements Trajectory {
  constructor(private readonly manager: MissionStateManager, readonly sourceId: string) {}
  get frame(): string | undefined { return this.manager.positionConvention(this.sourceId)?.frame; }
  get startTime(): number | undefined { return this.manager.extent(this.sourceId, 'position')?.start; }
  get endTime(): number | undefined { return this.manager.extent(this.sourceId, 'position')?.end; }
  stateAt(et: number): CartesianState { return this.manager.evaluatePosition(this.sourceId, et); }
  availabilityAt(et: number): StateAvailability { return this.manager.availability(this.sourceId, 'position', et); }
}

/** A body attitude read from a host mission-state source; throws `StateUnavailableError` outside its data. */
export class MissionStateRotation implements RotationModel {
  constructor(private readonly manager: MissionStateManager, readonly sourceId: string) {}
  get sourceFrame(): string { return this.manager.attitudeConvention(this.sourceId)?.referenceFrame ?? 'ECLIPJ2000'; }
  get bodyFixedFrame(): string | undefined { return this.manager.attitudeConvention(this.sourceId)?.bodyFrame; }
  rotationAt(et: number): Quaternion { return this.manager.evaluateAttitude(this.sourceId, et); }
  availabilityAt(et: number): StateAvailability { return this.manager.availability(this.sourceId, 'attitude', et); }
}

