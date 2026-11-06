/**
 * Time-indexed streamed imagery (#214).
 *
 * A temporal imagery layer depicts one *observation* (acquisition) day, which
 * is a different thing from the simulation epoch the Sun, bodies and
 * spacecraft are drawn at. Everything here is plain date arithmetic, kept free
 * of the tiles renderer so source-time resolution, throttling and cancellation
 * rules are testable on their own.
 *
 * Two layers of state:
 * - `resolveImageryTime` is a pure function: given a policy, the simulation
 *   instant and the source's availability range, which acquisition day (if
 *   any) should be on screen, and why.
 * - `ImageryTimeFollower` throttles *time-following* changes to the source
 *   cadence, so a fast playback or a scrub requests a handful of date buckets
 *   instead of one per frame.
 */

/** What the dated image depicts. Only acquisition-dated products are supported so far. */
export type ImageryTimeSemantics = 'acquisition' | 'valid';

/** Source cadence. Daily is the pilot; the field exists so others can follow. */
export type ImageryCadence = 'day';

/**
 * How the displayed day is chosen.
 *
 * - `fixed` — an explicit UTC date, independent of the simulation clock.
 * - `follow-simulation` — the simulation's UTC day, at the source cadence.
 * - `latest` — the newest day the provider says it has. Only meaningful when
 *   the provider's availability can be read (a WMTS time dimension); it is
 *   never guessed from the wall clock.
 */
export type ImageryTimePolicy = 'fixed' | 'follow-simulation' | 'latest';

/**
 * What a follow-mode layer does when the simulation day has no data:
 * `hide` shows nothing (the lower layers stay visible), `nearest` shows the
 * closest available day and labels it as such.
 */
export type ImageryOutOfRange = 'hide' | 'nearest';

/**
 * How the image's lighting relates to the simulated Sun. Daily true-colour
 * products have the *acquisition-time* Sun baked in. The renderer does not remove it: imagery tiles are still shaded by the simulated Sun, so the two lightings stack.
 */
export type ImageryIllumination = 'baked' | 'reflectance';

/** The optional temporal block of a `Globe.imagery` layer. */
export interface ImageryTemporalConfig {
  /** Default `acquisition`. */
  semantics?: ImageryTimeSemantics;
  /** Default `day`. */
  cadence?: ImageryCadence;
  /** Default: `fixed` when `date` is given, else `follow-simulation`. */
  policy?: ImageryTimePolicy;
  /** The UTC day shown by `fixed`, `YYYY-MM-DD`. Also the starting day if the viewer switches to fixed. */
  date?: string;
  /** First day the source has, `YYYY-MM-DD`. Discovered from a capabilities time dimension when present. */
  start?: string;
  /** Last day the source has, `YYYY-MM-DD` or `present`. Discovered from a capabilities time dimension when present. */
  end?: string;
  /** Days between an acquisition and its publication. The newest day is `today - latencyDays`. Default 0. */
  latencyDays?: number;
  /** Follow-mode behaviour outside `[start, end]`. Default `hide`. */
  outOfRange?: ImageryOutOfRange;
  /** Default `baked`: the image is lit as it was when acquired. */
  illumination?: ImageryIllumination;
}

/** Why a layer shows the day it shows, or nothing. */
export type ImageryTimeState =
  /** The requested day is the displayed day. */
  | 'exact'
  /** Out of range, so the nearest available day is shown instead. Label it. */
  | 'nearest'
  /** Requested day precedes the source's first day; nothing is shown. */
  | 'before-range'
  /** Requested day follows the source's last day; nothing is shown. */
  | 'after-range'
  /** Inside the source's range but in a gap its time dimension declares; nothing is shown. */
  | 'no-data'
  /** Requested day is later than the provider can have published; nothing is shown. */
  | 'not-yet-published'
  /** The configuration or requested date is not usable; nothing is shown. */
  | 'invalid';

/** The outcome of resolving a policy at one instant. */
export interface ResolvedImageryTime {
  policy: ImageryTimePolicy;
  /** The UTC day the policy asked for; null when it asks for none (`latest`, or invalid input). */
  requested: string | null;
  /** The acquisition day to show; null shows nothing. */
  date: string | null;
  state: ImageryTimeState;
  /** `date - requested` in days; 0 when either is null. */
  offsetDays: number;
}

/** The availability a policy resolves against, with the clock and latency already applied. */
export interface ImageryAvailability {
  start: string | null;
  end: string | null;
  /** Sorted, disjoint `[first, last]` runs of days the provider has, when it declares them. Days between runs are gaps. */
  intervals?: ReadonlyArray<readonly [string, string]>;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since the epoch for a `YYYY-MM-DD` string; null for anything that is not a real calendar day. */
export function dayNumber(date: string | null | undefined): number | null {
  const m = typeof date === 'string' ? DATE_RE.exec(date) : null;
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms)) return null;
  // Date.UTC rolls 2026-02-31 into March; require the round trip to match.
  return new Date(ms).toISOString().slice(0, 10) === date ? Math.round(ms / DAY_MS) : null;
}

/** `YYYY-MM-DD` for a day number; null when out of the representable range. */
export function dayString(day: number): string | null {
  const ms = day * DAY_MS;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  const iso = new Date(ms).toISOString();
  // Years beyond 9999 serialise as +YYYYYY-..., which no tile service takes.
  return /^\d{4}-/.test(iso) ? iso.slice(0, 10) : null;
}

/** The UTC day containing an instant, as `YYYY-MM-DD`; null for a non-finite or unrepresentable instant. */
export function utcDay(ms: number): string | null {
  return Number.isFinite(ms) ? dayString(Math.floor(ms / DAY_MS)) : null;
}

/**
 * Days the source has, from a WMTS time dimension's `Value`s. GIBS publishes
 * ISO 8601 intervals such as `2002-07-04/2026-11-05/P1D`, and may list single
 * days. Returns the earliest and latest day over every entry that is daily
 * (or a single day); null when none can be read.
 */
export function parseTimeExtent(values: readonly string[]): ImageryAvailability | null {
  const runs: Array<[number, number]> = [];
  for (const raw of values) {
    for (const part of raw.split(',')) {
      const [a, b, period] = part.trim().split('/');
      const first = dayNumber(a?.slice(0, 10));
      if (first === null) continue;
      // A coarser period than a day is a different cadence; its gaps are not daily data.
      if (b !== undefined && period !== undefined && period !== 'P1D') continue;
      const last = b === undefined ? first : dayNumber(b.slice(0, 10));
      if (last === null || last < first) continue;
      runs.push([first, last]);
    }
  }
  if (!runs.length) return null;
  runs.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && run[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], run[1]);
    else merged.push([...run]);
  }
  const strings = merged.map(([f, l]) => [dayString(f), dayString(l)] as const)
    .filter((r): r is readonly [string, string] => r[0] !== null && r[1] !== null);
  if (!strings.length) return null;
  return { start: strings[0][0], end: strings[strings.length - 1][1], intervals: strings };
}

/** `requested` is the policy's day; `now` is the wall clock for the not-yet-published check. */
export function resolveImageryTime(
  config: ImageryTemporalConfig,
  policy: ImageryTimePolicy,
  fixedDate: string | null,
  simulationMs: number | null,
  availability: ImageryAvailability,
  nowMs: number,
): ResolvedImageryTime {
  const today = dayNumber(utcDay(nowMs));
  const lastPublished = today === null ? null : today - Math.max(0, Math.floor(config.latencyDays ?? 0));
  const start = dayNumber(availability.start);
  // Nothing can have been published after the wall clock, whatever the range says.
  const declaredEnd = dayNumber(availability.end);
  const end = declaredEnd === null ? lastPublished
    : lastPublished === null ? declaredEnd : Math.min(declaredEnd, lastPublished);
  const invalid = (requested: string | null): ResolvedImageryTime => ({ policy, requested, date: null, state: 'invalid', offsetDays: 0 });

  if (policy === 'latest') {
    // Availability must come from the provider; without it there is no honest answer.
    return declaredEnd === null || end === null ? invalid(null) : shown(policy, end, end, 'exact');
  }
  let requestedDay: number | null;
  if (policy === 'fixed') requestedDay = dayNumber(fixedDate);
  else requestedDay = simulationMs === null ? null : dayNumber(utcDay(simulationMs));
  if (requestedDay === null) return invalid(policy === 'fixed' ? fixedDate : null);

  const runs = (availability.intervals ?? []).map(([f, l]) => [dayNumber(f), dayNumber(l)] as const)
    .filter((r): r is readonly [number, number] => r[0] !== null && r[1] !== null)
    .map(([f, l]) => [f, end === null ? l : Math.min(l, end)] as const).filter(([f, l]) => f <= l);
  const outside = start !== null && requestedDay < start ? 'before-range'
    : end !== null && requestedDay > end
      ? (lastPublished !== null && requestedDay > lastPublished ? 'not-yet-published' : 'after-range')
      : runs.length && !runs.some(([f, l]) => requestedDay >= f && requestedDay <= l) ? 'no-data'
      : null;
  if (!outside) return shown(policy, requestedDay, requestedDay, 'exact');
  // An explicit date is the viewer's choice and is never swapped for another.
  if (policy === 'follow-simulation' && config.outOfRange === 'nearest') {
    let nearest: number | null = outside === 'before-range' ? start : end;
    if (runs.length) {
      // The closest available day; an earlier one wins a tie.
      let best = Infinity;
      for (const [f, l] of runs) {
        const day = Math.max(f, Math.min(l, requestedDay));
        if (Math.abs(day - requestedDay) < best) { best = Math.abs(day - requestedDay); nearest = day; }
      }
    }
    if (nearest !== null) return shown(policy, requestedDay, nearest, 'nearest');
  }
  return { policy, requested: dayString(requestedDay), date: null, state: outside, offsetDays: 0 };
}

function shown(policy: ImageryTimePolicy, requested: number, date: number, state: ImageryTimeState): ResolvedImageryTime {
  const d = dayString(date);
  return d === null
    ? { policy, requested: dayString(requested), date: null, state: 'invalid', offsetDays: 0 }
    : { policy, requested: dayString(requested), date: d, state, offsetDays: date - requested };
}

/** A layer's source-time state, as the viewer controls see it. */
export interface ImageryLayerTime {
  semantics: ImageryTimeSemantics;
  cadence: ImageryCadence;
  policy: ImageryTimePolicy;
  /** Policies this layer can switch to. */
  policies: ImageryTimePolicy[];
  illumination: ImageryIllumination;
  outOfRange: ImageryOutOfRange;
  /** The UTC day the policy asks for; null when it asks for none. */
  requestedDate: string | null;
  /** The acquisition day on screen (or loading); null when nothing is shown. */
  date: string | null;
  state: ImageryTimeState;
  /** `date - requestedDate` in days. Non-zero means the displayed day is not the requested one. */
  offsetDays: number;
  /** What the source has. `source` says who declared it: the catalog, the provider's capabilities, or neither (the clock bounds the end). */
  range: ImageryAvailability & { source: 'catalog' | 'provider' | 'clock' };
  /** A different resolution (a newer day, or none) is waiting out the throttle, so what is on screen is about to change. */
  pending: boolean;
  /** The day it will change to; null when `pending` is false or the change is to showing nothing. */
  pendingDate: string | null;
  /** Times the layer's source has been replaced by a different day. */
  switches: number;
}

/** How aggressively time-following changes are applied. */
export interface ImageryTimeThrottle {
  /** A new day must hold this long before it is committed (debounce). */
  settleMs: number;
  /** At least this long between two commits. */
  minIntervalMs: number;
  /** Commit the newest day anyway after this long without one, so playback still advances. */
  maxWaitMs: number;
}

export const DEFAULT_IMAGERY_THROTTLE: ImageryTimeThrottle = { settleMs: 400, minIntervalMs: 1000, maxWaitMs: 3000 };

/**
 * Decides when a follow-mode layer commits to a new displayed day. A day that
 * changes every frame (fast playback, scrubbing) is debounced; one that keeps
 * changing still commits at most every `maxWaitMs`, and never twice within
 * `minIntervalMs`. The committed identity is the displayed `date` (or the
 * reason nothing is shown), so a change of `requested` alone is not a commit.
 */
export class ImageryTimeFollower {
  private committed: ResolvedImageryTime | null = null;
  private lastCommitAt = -Infinity;
  private pendingKey: string | null = null;
  private pendingSince = 0;
  private pendingResolved: ResolvedImageryTime | null = null;
  /** Commits made, for diagnostics and request-budget tests. */
  commits = 0;

  constructor(private readonly throttle: ImageryTimeThrottle = DEFAULT_IMAGERY_THROTTLE) {}

  private static key(r: ResolvedImageryTime): string {
    return r.date ?? `none:${r.state}`;
  }

  get current(): ResolvedImageryTime | null { return this.committed; }

  /**
   * Offer the newest resolution. Returns it when it becomes the committed one
   * and the layer must switch its source; null when nothing needs to change.
   * The committed record's `requested`/`offsetDays` stay current either way.
   */
  offer(next: ResolvedImageryTime, nowMs: number): ResolvedImageryTime | null {
    const key = ImageryTimeFollower.key(next);
    if (!this.committed) return this.commit(next, nowMs);
    if (key === ImageryTimeFollower.key(this.committed)) {
      this.pendingKey = null;
      this.committed = { ...this.committed, requested: next.requested, offsetDays: next.offsetDays, state: next.state };
      return null;
    }
    if (key !== this.pendingKey) { this.pendingKey = key; this.pendingSince = nowMs; }
    this.pendingResolved = next;
    const sinceCommit = nowMs - this.lastCommitAt;
    const settled = nowMs - this.pendingSince >= this.throttle.settleMs && sinceCommit >= this.throttle.minIntervalMs;
    if (settled || sinceCommit >= this.throttle.maxWaitMs) return this.commit(next, nowMs);
    return null;
  }

  /** Apply immediately: an explicit viewer choice is not throttled. Returns the commit, or null if nothing changed. */
  force(next: ResolvedImageryTime, nowMs: number): ResolvedImageryTime | null {
    const changed = !this.committed || ImageryTimeFollower.key(next) !== ImageryTimeFollower.key(this.committed);
    if (!changed) { this.committed = next; this.pendingKey = null; return null; }
    return this.commit(next, nowMs);
  }

  /** Whether a different day is waiting out the throttle. */
  get pending(): boolean { return this.pendingKey !== null; }

  /** The day waiting out the throttle; null when none, or when it would show nothing. */
  get pendingDate(): string | null { return this.pendingKey !== null ? this.pendingResolved?.date ?? null : null; }

  private commit(next: ResolvedImageryTime, nowMs: number): ResolvedImageryTime {
    this.committed = next;
    this.pendingKey = null;
    this.lastCommitAt = nowMs;
    this.commits++;
    return next;
  }
}
