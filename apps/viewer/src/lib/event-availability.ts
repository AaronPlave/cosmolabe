/**
 * Event search availability: whether a search can run, and the default window
 * it should run over.
 *
 * Pure policy over what SPICE can say — kernel count, each body's SPK coverage,
 * light time between bodies — passed in rather than read from the scene, so it
 * is tested directly against fakes and against real kernels. The Event Finder
 * (`event-finder.svelte.ts`) wires it to the scene that is up.
 *
 * Two answers live here because they must agree: {@link eventSearchUnavailable}
 * says which windows GF can search, and {@link coverageWindow} picks the default
 * window, which must always be one of them. Both come from the same coverage
 * requirements — the GF boundary margin, and the light-time shift a corrected
 * target needs — so neither can promise what the other refuses.
 */
import type { EtInterval, EventParticipants, EventSearchFault } from '@cosmolabe/core';
import type { HeritageSpice } from '@cosmolabe/frames';
import { formatSeconds } from './event-query';

/**
 * Seconds of SPK coverage GF needs beyond each end of its confinement window.
 *
 * A direct state lookup is valid at an SPK endpoint, but gfdist may compute
 * observer state as much as two seconds outside its confinement window. NAIF
 * also requires callers to allow for round-off when assessing coverage, so an
 * exact two-second margin is itself a boundary case; one extra second is
 * reserved. Shared by the default window (which insets by it) and the
 * availability check (which requires it).
 */
export const GF_BOUNDARY_MARGIN = 3;

/**
 * Whether one coverage interval contains `window` plus the GF margin.
 *
 * Measured as differences with a microsecond of slack, because the default
 * window is built as `coverage.start + GF_BOUNDARY_MARGIN`, and floating-point
 * subtraction does not always give the margin back exactly: without the slack
 * the default window could be refused by its own inset.
 */
function coversWithMargin(coverage: EtInterval, window: EtInterval): boolean {
  return window.start - coverage.start >= GF_BOUNDARY_MARGIN - COVERAGE_SLACK
    && coverage.end - window.end >= GF_BOUNDARY_MARGIN - COVERAGE_SLACK;
}

/** Round-off allowance when comparing coverage edges; see {@link coversWithMargin}. */
const COVERAGE_SLACK = 1e-6;

/**
 * Extra fraction of the light time added to a light-time-shifted span.
 *
 * The light time is measured geometrically at the window edge, while SPICE
 * converges it at the corrected epoch; the two differ by about range rate / c
 * of the light time, under 1e-4 for anything in the solar system. Ten times
 * that keeps the check from passing a window SPICE will then reject.
 */
export const LIGHT_TIME_PAD = 1e-3;

/** A span whose ends may be unchecked (undefined). */
interface RequiredSpan {
  start?: number;
  end?: number;
}

/**
 * The epochs a light-time-corrected target's states are needed over, before
 * the GF margin: the window shifted by the light time at each edge, widened by
 * {@link LIGHT_TIME_PAD}. An edge whose light time is unknown falls back to
 * what the correction makes necessary regardless (the window's own start for
 * reception, its end for transmission) or is left unchecked.
 */
export function lightTimeSpan(
  window: EtInterval,
  direction: 'reception' | 'transmission',
  ltStart: number | undefined,
  ltEnd: number | undefined,
): RequiredSpan {
  if (direction === 'reception') {
    return {
      start: ltStart === undefined ? window.start : window.start - ltStart * (1 + LIGHT_TIME_PAD),
      end: ltEnd === undefined ? undefined : window.end - ltEnd * (1 - LIGHT_TIME_PAD),
    };
  }
  return {
    start: ltStart === undefined ? undefined : window.start + ltStart * (1 - LIGHT_TIME_PAD),
    end: ltEnd === undefined ? window.end : window.end + ltEnd * (1 + LIGHT_TIME_PAD),
  };
}

/** Whether one coverage interval contains a required span plus the GF margin. */
function coversSpan(coverage: EtInterval, span: RequiredSpan): boolean {
  return (span.start === undefined || span.start - coverage.start >= GF_BOUNDARY_MARGIN - COVERAGE_SLACK)
    && (span.end === undefined || coverage.end - span.end >= GF_BOUNDARY_MARGIN - COVERAGE_SLACK);
}

/**
 * Which way a SPICE aberration correction moves the epochs a target's state is
 * needed at: earlier for reception (`LT`, `CN`, with or without `+S`), later
 * for transmission (`XLT`, `XCN`), not at all for `NONE`.
 */
export function lightTimeDirection(abcorr: string): 'none' | 'reception' | 'transmission' {
  const value = abcorr.trim().toUpperCase();
  if (value.startsWith('XLT') || value.startsWith('XCN')) return 'transmission';
  if (value.startsWith('LT') || value.startsWith('CN')) return 'reception';
  return 'none';
}

/**
 * What SPICE can say about one catalog body's ephemeris.
 *
 * - `unnamed`: SPICE cannot resolve the body to a NAIF id at all.
 * - an interval list: the body's coverage across every furnished SPK, which is
 *   empty when SPICE knows the name but no loaded SPK carries its states.
 * - `unknown`: coverage could not be read, which is not evidence of no
 *   coverage, so it refuses nothing.
 */
export type BodyEphemeris = 'unnamed' | 'unknown' | EtInterval[];

/**
 * Why an event search cannot run in this scene, or null when it can.
 *
 * Every event kind is a composition of SPICE Geometry Finder calls, and GF sees
 * only what the furnished kernels describe. That makes event search a SPICE
 * feature, deliberately: a catalog that furnishes no kernels — Earth–Moon, ISS,
 * the Keplerian inner planets, Ingenuity at Jezero, MoonFall — moves its bodies
 * on Keplerian, TLE or analytic models SPICE cannot see, and the finder says so
 * rather than substituting a sampled search whose accuracy would differ by
 * catalog without saying so. (The viewer once had such a fallback, the measure
 * tool's sampled close-approach list; it is gone, and this is the decision that
 * replaced it.) Continuous profiles on the timeline still sample those
 * catalogs: a profile is a display of a quantity, not a claim about when an
 * event happened.
 *
 * Kernels being loaded is not enough, because catalogs mix: Io in `io-volcanos`
 * is a built-in analytic trajectory, while the only SPK its base catalog loads
 * is de440s, which carries planets and the Moon but no Galilean satellites. So
 * the check is per body and per window — each chosen body must have SPK
 * coverage of the whole search window — rather than whether SPICE recognises
 * the body's name.
 *
 * "Whole" is what a confinement window needs: GF evaluates states across all
 * of it, plus {@link GF_BOUNDARY_MARGIN} beyond each end, so coverage that only
 * overlaps the window fails just as surely as none, only later. `spkcov`
 * reports merged, ascending intervals, so the window is covered exactly when
 * one interval contains it — which refuses an internal coverage gap too.
 *
 * That containment is exact only where states are needed at the window's own
 * epochs: the observer always, and every body when the search applies no
 * aberration correction. With light-time correction, GF needs a target's
 * states at light-time-corrected epochs — earlier than the window for a
 * reception correction (`LT`, `CN`), later for a transmission one (`XLT`,
 * `XCN`) — by the light time (NAIF, GF required reading, "Required SPICE
 * kernels"). So for those bodies the required span is shifted by the light time
 * measured at each window edge, `lightTime(target, observer, et)`: one-way light
 * time changes far slower than one second per second, so the epoch the window's
 * start needs is `start − lt(start)` (reception) to within a part in ten
 * thousand, and the span is padded by {@link LIGHT_TIME_PAD} of the light time
 * on top of the GF margin. Where a light time cannot be measured (no observer
 * chosen, or no geometric state at that edge), only what the correction makes
 * necessary regardless is checked — coverage opening before the window for
 * reception, closing after it for transmission — and anything subtler is left
 * to the provider's structured fault rather than promised.
 *
 * Pure, so the policy is tested directly: `kernelCount` is what the pool holds,
 * `bodies` the chosen roles, `window` the search window (null before there is
 * one), `ephemeris` what SPICE says about a catalog body, `abcorr` the
 * aberration correction the search will actually run with, `lightTime` the
 * one-way light time (s) between two bodies at an epoch, when it can be had.
 */
export function eventSearchUnavailable(
  kernelCount: number,
  bodies: EventParticipants,
  window: EtInterval | null,
  ephemeris: (name: string) => BodyEphemeris,
  abcorr = 'NONE',
  lightTime: (target: string, observer: string, et: number) => number | undefined = () => undefined,
): EventSearchFault | null {
  if (!(kernelCount > 0)) {
    return {
      code: 'unavailable',
      message: NO_KERNELS_MESSAGE,
    };
  }

  const direction = lightTimeDirection(abcorr);
  const unnamed: string[] = [];
  const uncovered: string[] = [];
  const outside: string[] = [];
  const corrected: { name: string; lt: number | undefined }[] = [];
  for (const name of new Set(Object.values(bodies).filter((n): n is string => !!n))) {
    const known = ephemeris(name);
    if (known === 'unknown') continue;
    if (known === 'unnamed') {
      unnamed.push(name);
      continue;
    }
    if (known.length === 0) {
      uncovered.push(name);
      continue;
    }
    if (!window) continue;

    // States at the window's own epochs: the observer always, everyone when
    // nothing is light-time corrected.
    if (name === bodies.observer || direction === 'none') {
      if (!known.some((c) => coversWithMargin(c, window))) outside.push(name);
      continue;
    }

    const observer = bodies.observer;
    const ltAt = (et: number) => {
      if (!observer) return undefined;
      const lt = lightTime(name, observer, et);
      return lt !== undefined && Number.isFinite(lt) && lt >= 0 ? lt : undefined;
    };
    const ltStart = ltAt(window.start);
    const ltEnd = ltAt(window.end);
    const required = lightTimeSpan(window, direction, ltStart, ltEnd);
    if (!known.some((c) => coversSpan(c, required))) {
      corrected.push({ name, lt: direction === 'reception' ? ltStart : ltEnd });
    }
  }

  const list = (names: string[]) => names.join(' and ');
  const them = (names: string[]) => (names.length === 1 ? 'it' : 'them');

  if (unnamed.length > 0) {
    return {
      code: 'unavailable',
      message: `SPICE cannot identify ${list(unnamed)}, so no loaded kernel describes ${them(unnamed)} and events involving ${them(unnamed)} cannot be searched.`,
    };
  }
  if (uncovered.length > 0) {
    const its = uncovered.length === 1 ? 'its position' : 'their positions';
    return {
      code: 'unavailable',
      message: `No loaded SPK has ephemeris for ${list(uncovered)}, so ${its} in this scene ${uncovered.length === 1 ? 'does' : 'do'} not come from SPICE and events involving ${them(uncovered)} cannot be searched.`,
    };
  }
  if (outside.length > 0) {
    return {
      code: 'unavailable',
      message: `The loaded SPKs do not cover ${list(outside)} for the whole search window, which GF needs (plus a few seconds beyond each end). Move the window inside ${outside.length === 1 ? 'its' : 'their'} coverage.`,
    };
  }
  if (corrected.length > 0) {
    const [first] = corrected;
    const before = direction === 'reception';
    const shift = first.lt === undefined
      ? `${before ? 'before the search window opens' : 'after the search window closes'}, by the light time`
      : `about ${formatSeconds(first.lt)} ${before ? 'before' : 'after'} the search window`;
    return {
      code: 'unavailable',
      message: `The loaded SPKs do not cover ${list(corrected.map((c) => c.name))} at the epochs this light-time-corrected search (${abcorr}) needs: SPICE evaluates ${corrected.length === 1 ? 'its' : 'their'} states ${shift}. ${before ? 'Start the window later.' : 'End the window sooner.'}`,
    };
  }

  return null;
}

/** What the finder says in a catalog with no kernels. Exported for tests. */
export const NO_KERNELS_MESSAGE =
  'Event search needs SPICE kernels, and this catalog furnishes none: its bodies move on Keplerian, TLE or analytic models that SPICE\'s Geometry Finder cannot see. Open a catalog that declares kernels, or drop kernels onto the viewer.';

/**
 * {@link BodyEphemeris} for a catalog body, read from a SPICE instance.
 *
 * The id comes the same way the search's own does — the catalog's NAIF id or
 * SPICE trajectory target first, the display name last — so the body checked
 * is the body searched. Exported for the real-kernel test.
 */
export function spiceEphemeris(
  spice: Pick<HeritageSpice, 'bodn2c' | 'spkcov'>,
  spiceName: string,
): BodyEphemeris {
  let id: number | null;
  try {
    id = /^-?\d+$/.test(spiceName) ? Number(spiceName) : spice.bodn2c(spiceName);
  } catch {
    return 'unnamed';
  }
  if (id == null) return 'unnamed';
  // The solar system barycentre is the root every SPK chain ends at: it is a
  // segment centre, never a segment target, so it has no coverage of its own.
  if (id === 0) return [{ start: -Infinity, end: Infinity }];
  try {
    return spice.spkcov(id);
  } catch {
    return 'unknown';
  }
}

/** Speed of light, km/s — the same exact value CSPICE's `clight_c` returns. */
const C_KM_S = 299_792.458;

/**
 * One-way geometric light time (s) between two bodies at `et`, or undefined
 * when SPICE has no geometric state for either there. Exported for the
 * real-kernel test.
 */
export function spiceLightTime(
  spice: Pick<HeritageSpice, 'spkpos' | 'vnorm'>,
  target: string,
  observer: string,
  et: number,
): number | undefined {
  try {
    return spice.vnorm(spice.spkpos(target, et, 'J2000', 'NONE', observer).position) / C_KM_S;
  } catch {
    return undefined;
  }
}

/**
 * The span the chosen bodies actually have ephemeris for, intersected with the
 * catalog's own span — the default search window.
 *
 * Without this the finder defaults to the scrubber's full range, which for the
 * Clipper catalog starts about a day before the trajectory kernel does — so the
 * first search a user runs fails with a raw SPICE "insufficient ephemeris data"
 * for a window they never chose. Coverage is a fact SPICE can state (`spkcov`),
 * so the default window respects it instead of making the user discover it.
 *
 * Each body's edge is set by the same requirement {@link eventSearchUnavailable}
 * checks, so the default is always a window the check accepts:
 *
 * - the observer, and every body when the search is not light-time corrected,
 *   need states at the window's own epochs, so the window sits inside their
 *   coverage by {@link GF_BOUNDARY_MARGIN};
 * - a light-time-corrected target needs states one light time earlier
 *   (reception) or later (transmission), so the edge on that side moves in by
 *   the light time measured there, padded by {@link LIGHT_TIME_PAD}. The other
 *   edge keeps the plain margin, which is conservative by at most one light
 *   time. Light time is re-measured at the moved edge until it stands, since
 *   moving the edge changes the distance; it changes far slower than one second
 *   per second, so this settles in a step or two. Light times are only measured
 *   once every body's plain coverage has clipped the window, so the result is
 *   the same whichever order the roles were chosen in.
 *
 * Where a light time cannot be measured the body falls back to the plain
 * margin, as the check does. Bodies SPICE cannot name, or that no SPK covers,
 * constrain nothing: a Keplerian body in a kernel-free catalog is not a reason
 * to refuse a window. A gap inside a body's coverage is not avoided here — the
 * outer bounds are used, and the check says so if the window spans the gap.
 */
export function coverageWindow(
  spice: Pick<HeritageSpice, 'bodn2c' | 'spkcov'>,
  bodies: EventParticipants,
  span: EtInterval,
  toSpice: (name: string) => string = (name) => name,
  abcorr = 'NONE',
  lightTime: (target: string, observer: string, et: number) => number | undefined = () => undefined,
): EtInterval {
  const direction = lightTimeDirection(abcorr);
  const observer = bodies.observer;

  // Pass 1: every body's coverage, clipped by the plain margin. These shared
  // bounds come first so that no light time is measured at an epoch some other
  // body's coverage will later exclude: a lookup there can fail (the observer
  // has no state yet) and would leave the target on its plain margin, which is
  // how the result came to depend on the order the roles were chosen in.
  const covered: { name: string; start: number; end: number }[] = [];
  let { start, end } = span;
  for (const name of new Set(Object.values(bodies).filter((n): n is string => !!n))) {
    let windows: EtInterval[];
    try {
      const spiceName = toSpice(name);
      const id = /^-?\d+$/.test(spiceName) ? Number(spiceName) : spice.bodn2c(spiceName);
      if (id == null) continue;
      windows = spice.spkcov(id);
    } catch {
      // bodn2c/spkcov throwing means we know nothing about this body's
      // coverage, which is not the same as it having none.
      continue;
    }
    if (windows.length === 0) continue;

    // The outer bounds, not each segment: a gap inside coverage is a fault to
    // report when a search hits it, not a reason to narrow the default.
    const bodyStart = Math.min(...windows.map((w) => w.start));
    const bodyEnd = Math.max(...windows.map((w) => w.end));
    covered.push({ name, start: bodyStart, end: bodyEnd });
    start = Math.max(start, bodyStart + GF_BOUNDARY_MARGIN);
    end = Math.min(end, bodyEnd - GF_BOUNDARY_MARGIN);
  }
  if (!(end > start)) return span;

  // Pass 2: each light-time-corrected target's edge, settled from the shared
  // bounds rather than from wherever earlier targets left it, and the tightest
  // taken. Since t − lt(t) only increases with t, the edges a target accepts
  // form a half-line, so the tightest settled edge satisfies every target and
  // the result does not depend on the order they are visited in.
  if (direction !== 'none' && observer) {
    const geometricStart = start;
    const geometricEnd = end;
    for (const body of covered) {
      if (body.name === observer) continue;
      const lt = (et: number) => {
        const value = lightTime(body.name, observer, et);
        return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
      };
      if (direction === 'reception') {
        const edge = settleEdge(geometricStart, +1, (et) => {
          const value = lt(et);
          return value === undefined ? undefined : body.start + GF_BOUNDARY_MARGIN + value * (1 + LIGHT_TIME_PAD);
        });
        if (edge !== undefined) start = Math.max(start, edge);
      } else {
        const edge = settleEdge(geometricEnd, -1, (et) => {
          const value = lt(et);
          return value === undefined ? undefined : body.end - GF_BOUNDARY_MARGIN - value * (1 + LIGHT_TIME_PAD);
        });
        if (edge !== undefined) end = Math.min(end, edge);
      }
    }
  }

  return end > start ? { start, end } : span;
}

/**
 * Moves a window edge (`sign` +1 moves a start later, −1 an end earlier) until
 * it satisfies `bound`, the edge position its own light time requires. Returns
 * undefined when a light time cannot be measured at the edge.
 *
 * Each step re-measures at the moved edge, and a microsecond nudge keeps the
 * result on the safe side of floating-point round-off, so the check, measuring
 * the light time again at that same epoch, finds it satisfied.
 */
function settleEdge(
  from: number,
  sign: 1 | -1,
  bound: (et: number) => number | undefined,
): number | undefined {
  let edge = from;
  for (let step = 0; step < 8; step++) {
    const required = bound(edge);
    if (required === undefined) return undefined;
    if (sign * (edge - required) >= 0) return edge;
    edge = required + sign * COVERAGE_SLACK;
  }
  return edge;
}
