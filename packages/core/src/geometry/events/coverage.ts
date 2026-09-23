import type { EtInterval, EtSeconds } from './types.js';

/**
 * Which time ranges a search can actually be computed over.
 *
 * "Kernel coverage" is not an answer to that. `spkcov` for the two bodies a
 * user picked says when each has *a* segment, but SPICE resolves a state by
 * walking from each segment to its center until the chains meet (or, under an
 * aberration correction, until both reach the solar-system barycenter). A
 * satellite kernel that gives Mars relative to the Mars barycenter covers
 * "Mars" for its whole span and still cannot answer for a single epoch when no
 * loaded kernel carries the barycenter itself. That is the failure the Event
 * Finder used to invite, and it is why this module works from segments.
 *
 * The derivation mirrors SPICE's own selection: per body, the highest-priority
 * segment covering an epoch is the one SPICE uses (last-loaded file first, last
 * segment in a file first), and its center is what the chain recurses to. Time
 * is cut into pieces at every segment boundary of every body that can appear in
 * a chain; within one piece every choice is fixed, so each piece is decided
 * once. The pieces that work, merged, are the usable windows — separately, so
 * a gap between them is never spanned.
 *
 * Deriving is not the same as verifying, so the result is then checked against
 * the calculation the search itself runs (`probe`) at each window's ends and
 * middle, and anything the derivation cannot model — a segment expressed in a
 * non-inertial frame whose orientation has coverage of its own, a light-time
 * margin with no way to measure light time — marks the answer as an estimate
 * rather than letting it promise more than it knows.
 */

/** One observer→target state a search evaluates, with its correction. */
export interface EventGeometryVector {
  target: string;
  observer: string;
  abcorr: string;
}

/** Everything a search's SPICE calculation depends on, beyond its window. */
export interface EventGeometryDependencies {
  vectors: readonly EventGeometryVector[];
  /** Body-fixed frames whose orientation the calculation reads. */
  frames?: readonly string[];
  /** Bodies whose tri-axial radii the calculation reads. */
  radii?: readonly string[];
}

/** One SPK segment descriptor. Structurally `HSpkSegment`/`SpkSegmentSummary`. */
export interface SpkSegmentInfo {
  body: number;
  center: number;
  frame: number;
  start: EtSeconds;
  end: EtSeconds;
}

/** What {@link assessEventCoverage} needs to know about the loaded kernels. */
export interface CoverageSource {
  bodn2c(name: string): number | null;
  bodc2n?(code: number): string | null;
  /** Every loaded SPK segment, lowest priority first. */
  spkSegments(): readonly SpkSegmentInfo[];
  /** Geometric one-way light time (s) between two bodies at `et`. */
  lightTime?(target: string, observer: string, et: EtSeconds): number;
  /**
   * Runs the calculation the search evaluates, at one epoch. Throws, with
   * SPICE's own message, when it cannot be computed there.
   */
  probe?(dependencies: EventGeometryDependencies, et: EtSeconds): void;
}

export interface CoverageAssessmentOptions {
  /** Formats an epoch for a message. Defaults to "ET <seconds>". */
  formatEt?: (et: EtSeconds) => string;
  /**
   * Seconds kept clear of every window edge. GF's derivative-based searches
   * evaluate states up to two seconds outside the confinement window, and
   * NAIF asks callers to allow for round-off at a coverage boundary, so the
   * default is three.
   */
  edgeMargin?: number;
}

export interface CoverageAssessment {
  /**
   * `available`: at least one window. `none`: the loaded kernels cannot
   * support this query at any time. `unknown`: the question could not be
   * asked (no segment listing, say), which is not the same as "none".
   */
  status: 'available' | 'none' | 'unknown';
  /** Disjoint, ascending, already inset by the edge margin. */
  windows: EtInterval[];
  /** False when the windows are an estimate; {@link caveats} says why. */
  exact: boolean;
  /** Why geometry is missing or limited, in terms a user can act on. */
  problems: string[];
  /** What the derivation could not establish. */
  caveats: string[];
}

const SSB = 0;
const DEFAULT_EDGE_MARGIN = 3;
/** Light-time samples per window when sizing the aberration margin. */
const LIGHT_TIME_SAMPLES = 64;

/** Built-in inertial frames have NAIF ids 1–21; states in them need no orientation data. */
function isInertialFrame(frame: number): boolean {
  return frame >= 1 && frame <= 21;
}

interface Effective {
  start: number;
  end: number;
  center: number;
  frame: number;
}

/**
 * A body's segments resolved into the disjoint intervals SPICE would actually
 * use, each with the center and frame of the segment that wins there.
 */
function effectiveIntervals(segments: readonly SpkSegmentInfo[]): Effective[] {
  const claimed: Effective[] = [];
  // Highest priority first, so every later segment only fills what is left.
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    // A zero-length segment answers for one instant, which no search can use.
    if (!(seg.end > seg.start)) continue;
    let cursor = seg.start;
    const pieces: Effective[] = [];
    for (const c of claimed) {
      if (c.end < cursor) continue;
      if (c.start > seg.end) break;
      if (c.start > cursor) pieces.push({ start: cursor, end: c.start, center: seg.center, frame: seg.frame });
      cursor = Math.max(cursor, c.end);
    }
    if (cursor < seg.end) pieces.push({ start: cursor, end: seg.end, center: seg.center, frame: seg.frame });
    for (const p of pieces) {
      if (p.end <= p.start) continue;
      const at = claimed.findIndex((c) => c.start >= p.end);
      claimed.splice(at < 0 ? claimed.length : at, 0, p);
    }
  }
  return claimed;
}

/** The effective interval containing `t`, by binary search. */
function selectAt(list: readonly Effective[], t: number): Effective | undefined {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = list[mid]!;
    if (t < e.start) hi = mid - 1;
    else if (t > e.end) lo = mid + 1;
    else return e;
  }
  return undefined;
}

interface Chain {
  /** Nodes from the body outward, the body first. */
  nodes: number[];
  /** Frames of the segments the chain used. */
  frames: number[];
}

function mergeAdjacent(windows: EtInterval[]): EtInterval[] {
  windows.sort((a, b) => a.start - b.start);
  const out: EtInterval[] = [];
  for (const w of windows) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

function intersect(a: readonly EtInterval[], b: readonly EtInterval[]): EtInterval[] {
  const out: EtInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start);
    const end = Math.min(a[i]!.end, b[j]!.end);
    if (end > start) out.push({ start, end });
    if (a[i]!.end < b[j]!.end) i++;
    else j++;
  }
  return out;
}

/** Whether a correction evaluates the target at a light-time-shifted epoch, and which way. */
function lightTimeDirection(abcorr: string): -1 | 0 | 1 {
  const c = abcorr.trim().toUpperCase();
  if (c === 'NONE' || c === '') return 0;
  return c.startsWith('X') ? 1 : -1;
}

/**
 * The windows over which `dependencies` can be computed with the loaded
 * kernels, derived from segments and checked by the search's own calculation.
 */
export function assessEventCoverage(
  dependencies: EventGeometryDependencies,
  source: CoverageSource,
  options: CoverageAssessmentOptions = {},
): CoverageAssessment {
  const formatEt = options.formatEt ?? ((et: number) => `ET ${et.toFixed(3)}`);
  const edgeMargin = options.edgeMargin ?? DEFAULT_EDGE_MARGIN;
  const problems: string[] = [];
  const caveats: string[] = [];

  let segments: readonly SpkSegmentInfo[];
  try {
    segments = source.spkSegments();
  } catch (cause) {
    return {
      status: 'unknown',
      windows: [],
      exact: false,
      problems: [],
      caveats: [`The loaded ephemeris segments could not be listed: ${message(cause)}`],
    };
  }

  const nameOf = (id: number): string => {
    let name: string | null = null;
    try {
      name = source.bodc2n?.(id) ?? null;
    } catch {
      name = null;
    }
    return name ? `${name} (${id})` : `body ${id}`;
  };

  // Group by body, preserving priority order.
  const byBody = new Map<number, SpkSegmentInfo[]>();
  for (const seg of segments) {
    let list = byBody.get(seg.body);
    if (!list) byBody.set(seg.body, (list = []));
    list.push(seg);
  }
  const effective = new Map<number, Effective[]>();
  const effectiveOf = (id: number): Effective[] => {
    let e = effective.get(id);
    if (!e) effective.set(id, (e = effectiveIntervals(byBody.get(id) ?? [])));
    return e;
  };

  const chainAt = (id: number, t: number): Chain => {
    const nodes = [id];
    const frames: number[] = [];
    let current = id;
    for (;;) {
      if (current === SSB) break;
      const e = selectAt(effectiveOf(current), t);
      if (!e) break;
      frames.push(e.frame);
      // A cycle means the kernels describe no route out; SPICE would fail too.
      if (nodes.includes(e.center)) break;
      nodes.push(e.center);
      current = e.center;
    }
    return { nodes, frames };
  };

  /** Every segment boundary of every body a chain from `roots` can reach. */
  const breakpointsFrom = (roots: readonly number[]): number[] => {
    const seen = new Set<number>();
    const queue = [...roots];
    const points = new Set<number>();
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of effectiveOf(id)) {
        points.add(e.start);
        points.add(e.end);
        if (!seen.has(e.center)) queue.push(e.center);
      }
    }
    return [...points].sort((a, b) => a - b);
  };

  /** Pieces between consecutive breakpoints where `ok(midpoint)` holds, merged. */
  const windowsWhere = (roots: readonly number[], ok: (t: number) => boolean): EtInterval[] => {
    const points = breakpointsFrom(roots);
    const out: EtInterval[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      if (ok((a + b) / 2)) out.push({ start: a, end: b });
    }
    return mergeAdjacent(out);
  };

  const noninertial = new Set<number>();
  const noteFrames = (chain: Chain) => {
    for (const f of chain.frames) if (!isInertialFrame(f)) noninertial.add(f);
  };

  /** Why `id`'s chain fails somewhere it has segments of its own, in words. */
  const explainChain = (id: number, requireSsb: boolean, partner?: number): void => {
    const own = effectiveOf(id);
    if (own.length === 0) {
      if (id !== SSB) problems.push(`No loaded ephemeris (SPK) carries ${nameOf(id)}.`);
      return;
    }
    const stops = new Set<number>();
    for (const e of own) {
      const chain = chainAt(id, (e.start + e.end) / 2);
      const last = chain.nodes[chain.nodes.length - 1]!;
      if (requireSsb && last !== SSB) stops.add(last);
      if (!requireSsb && partner !== undefined && last !== SSB) {
        const other = chainAt(partner, (e.start + e.end) / 2);
        if (!other.nodes.some((n) => chain.nodes.includes(n))) stops.add(last);
      }
    }
    for (const stop of stops) {
      if (stop === id) continue;
      const via = chainAt(id, (own[0]!.start + own[0]!.end) / 2).nodes;
      const route = via.slice(0, via.indexOf(stop) + 1).map(nameOf).join(' → ');
      problems.push(
        effectiveOf(stop).length === 0
          ? `${nameOf(id)} is given relative to ${nameOf(stop)} (${route}), but no loaded SPK carries ${nameOf(stop)}.`
          : `${nameOf(id)} is given relative to ${nameOf(stop)} (${route}), and ${nameOf(stop)}'s loaded coverage does not span ${nameOf(id)}'s.`,
      );
    }
  };

  const describeSpan = (windows: readonly EtInterval[]): string =>
    windows.length === 0
      ? 'no epochs'
      : windows.length === 1
        ? `${formatEt(windows[0]!.start)} – ${formatEt(windows[0]!.end)}`
        : `${windows.length} separate intervals from ${formatEt(windows[0]!.start)} to ${formatEt(windows[windows.length - 1]!.end)}`;

  let usable: EtInterval[] | null = null;

  for (const vector of dependencies.vectors) {
    const target = resolveId(source, vector.target);
    const observer = resolveId(source, vector.observer);
    if (target === null || observer === null) {
      for (const [name, id] of [[vector.target, target], [vector.observer, observer]] as const) {
        if (id === null) problems.push(`SPICE does not recognise the body "${name}".`);
      }
      usable = [];
      continue;
    }
    if (target === observer) continue;

    const problemsBefore = problems.length;
    const direction = lightTimeDirection(vector.abcorr);
    let windows: EtInterval[];

    if (direction === 0) {
      // Geometric: SPICE only needs the two chains to meet.
      windows = windowsWhere([target, observer], (t) => {
        const a = chainAt(target, t);
        const b = chainAt(observer, t);
        const ok = a.nodes.some((n) => b.nodes.includes(n));
        if (ok) {
          noteFrames(a);
          noteFrames(b);
        }
        return ok;
      });
      if (windows.length === 0) {
        explainChain(target, false, observer);
        explainChain(observer, false, target);
      }
    } else {
      // Corrected: both states are taken relative to the barycenter, the
      // observer's at `t` and the target's at the light-time-shifted epoch.
      const reachesSsb = (id: number) => (t: number) => {
        const chain = chainAt(id, t);
        const ok = chain.nodes[chain.nodes.length - 1] === SSB;
        if (ok) noteFrames(chain);
        return ok;
      };
      const always = [{ start: -Infinity, end: Infinity }];
      const observerReach = observer === SSB ? always : windowsWhere([observer], reachesSsb(observer));
      const targetReach = target === SSB ? always : windowsWhere([target], reachesSsb(target));
      if (observerReach.length === 0) explainChain(observer, true);
      if (targetReach.length === 0) explainChain(target, true);

      const both = intersect(observerReach, targetReach);
      let ltMax = 0;
      if (both.length > 0) {
        if (source.lightTime) {
          for (const w of both) {
            for (let k = 0; k <= LIGHT_TIME_SAMPLES; k++) {
              const t = w.start + ((w.end - w.start) * k) / LIGHT_TIME_SAMPLES;
              try {
                ltMax = Math.max(ltMax, source.lightTime(vector.target, vector.observer, t));
              } catch {
                // An epoch the derivation says works but SPICE refuses is
                // caught by the probe below; here it only cannot size a margin.
              }
            }
          }
          // Light time varies between samples; pad for it rather than trust it.
          ltMax = ltMax * 1.01 + 1;
        } else {
          caveats.push(
            `The light-time margin for ${vector.abcorr} could not be measured, so window edges near ${vector.target}'s coverage may be optimistic.`,
          );
        }
      }
      // t is usable when t ∓ lt lands in the target's reach; with lt in
      // [0, ltMax] shrinking each target window by ltMax on the shifted side
      // is sufficient.
      const shifted = targetReach.map((w) =>
        direction < 0 ? { start: w.start + ltMax, end: w.end } : { start: w.start, end: w.end - ltMax })
        .filter((w) => w.end > w.start);
      windows = intersect(observerReach, shifted);
    }

    if (windows.length === 0 && problems.length === problemsBefore) {
      const tw = windowsWhere([target], (t) => chainAt(target, t).nodes.length > 1);
      const ow = windowsWhere([observer], (t) => chainAt(observer, t).nodes.length > 1);
      problems.push(
        `The loaded coverage of ${nameOf(target)} (${describeSpan(tw)}) and ${nameOf(observer)} (${describeSpan(ow)}) does not overlap.`,
      );
    }

    usable = usable === null ? windows : intersect(usable, windows);
  }

  let windows = (usable ?? [])
    .map((w) => ({ start: w.start + edgeMargin, end: w.end - edgeMargin }))
    .filter((w) => w.end > w.start && Number.isFinite(w.start) && Number.isFinite(w.end));

  for (const frame of noninertial) {
    caveats.push(
      `Some ephemeris is expressed in frame ${frame}, whose orientation coverage was not checked.`,
    );
  }

  // Verify: the derivation models SPICE, the probe *is* SPICE.
  if (source.probe && windows.length > 0) {
    const verified: EtInterval[] = [];
    for (const w of windows) {
      const epochs = [w.start, (w.start + w.end) / 2, w.end];
      let failure: unknown;
      for (const et of epochs) {
        try {
          source.probe(dependencies, et);
        } catch (cause) {
          failure = cause;
          problems.push(`SPICE could not evaluate this geometry at ${formatEt(et)}: ${message(cause)}`);
          break;
        }
      }
      if (failure === undefined) verified.push(w);
    }
    windows = verified;
  } else if (!source.probe && windows.length > 0) {
    caveats.push('The windows were derived from kernel segments but not checked against the search calculation.');
  }

  if (windows.length === 0 && problems.length === 0 && dependencies.vectors.length > 0) {
    problems.push('The loaded kernels share no interval long enough to search.');
  }

  return {
    status: windows.length > 0 ? 'available' : dependencies.vectors.length > 0 ? 'none' : 'unknown',
    windows,
    exact: caveats.length === 0,
    problems: [...new Set(problems)],
    caveats,
  };
}

function resolveId(source: CoverageSource, name: string): number | null {
  try {
    const code = source.bodn2c(name);
    if (code !== null && code !== undefined) return code;
  } catch {
    // fall through to a numeric reading
  }
  return /^-?\d+$/.test(name.trim()) ? Number(name.trim()) : null;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * How a requested window relates to the usable ones: entirely inside one,
 * or which parts fall outside.
 */
export function windowOutsideCoverage(
  requested: EtInterval,
  usable: readonly EtInterval[],
): EtInterval[] {
  const outside: EtInterval[] = [];
  let cursor = requested.start;
  for (const w of usable) {
    if (w.end < cursor) continue;
    if (w.start > requested.end) break;
    if (w.start > cursor) outside.push({ start: cursor, end: Math.min(w.start, requested.end) });
    cursor = Math.max(cursor, w.end);
    if (cursor >= requested.end) break;
  }
  if (cursor < requested.end) outside.push({ start: cursor, end: requested.end });
  return outside;
}
