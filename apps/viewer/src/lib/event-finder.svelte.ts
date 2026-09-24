/**
 * Event finder state — the panel's reactive half.
 *
 * One search at a time: a form, its result, and which result is selected.
 * Everything kind-specific lives in the registered {@link EventKind}s, and
 * everything pure — building the query, formatting a metric — lives in
 * `event-query.ts`. What is left here is the wiring: choosing a GF provider,
 * the async run with its in-flight bookkeeping and cancellation, and turning a
 * selected event into simulation time plus a 3D highlight.
 *
 * Searches run in a SPICE worker of their own whenever the scene has one. That
 * is not an optimisation: CSPICE's GF routines are synchronous, so a search on
 * the main thread freezes the viewer — no camera, no scrubber, not even a
 * spinner — for as long as it runs, which a one-minute step over a multi-year
 * window makes seconds. It is a worker of its own rather than the trajectory
 * cache's so that cancelling a search may terminate it, and so that a long
 * search does not starve the cache builds queued behind it. The main-thread
 * provider stays as the fallback for scenes with no worker (test mode, and
 * kernel-free catalogs).
 */
import {
  EventSearch,
  applyEventFocus,
  assessEventCoverage,
  eventGeometry,
  windowOutsideCoverage,
  builtinEventKinds,
  defaultParams,
  eventEnd,
  eventStart,
  focusForEvent,
  resolveEventQuery,
  type ConfiguredEventQuery,
  type EtInterval,
  type EventKind,
  type EventParticipants,
  type EventSearchFault,
  type GeometryEvent,
  type GeometryFinderProvider,
  type AberrationCorrection,
  type CoverageAssessment,
  type CoverageSource,
  type SpkSegmentInfo,
} from '@cosmolabe/core';
import type { HeritageSpice } from '@cosmolabe/frames';
import { GeometrySearchCancelled, type GeometrySearchProgress } from '@cosmolabe/three';
import { geometryScopeForWindow, getGeometryWorker, getSpice } from './loader';
import {
  activeEventAtTime,
  buildQuery,
  formForKind,
  type EventQueryForm,
  type EventSortMode,
} from './event-query';
import {
  analysis,
  analysisContext,
  configuredItem,
  createConfiguredEventQuery,
  resetAnalysis,
  setConfiguredItemVisible,
  setConfiguredItemEnabled,
  setEventResults,
  updateConfiguredEventQuery,
} from './analysis.svelte';
import {
  etToUtcString,
  getRenderer,
  highlightBodies,
  onViewerEvent,
  selectBody,
  setTime,
  vs,
} from './viewer-state.svelte';

/** The kinds the panel offers. Registered once; the picker reads this. */
const registry = builtinEventKinds();

export const EVENT_KINDS: EventKind<never>[] = registry.list();

/**
 * The viewer's SPICE instance as a GF provider.
 *
 * `HeritageSpice` already satisfies the GF half of the interface structurally,
 * which is the point of the boundary's signatures mirroring `gf*_c`. Only
 * `range` is added: GF says *when* a distance condition held and never *how
 * far*, so the number a closest-approach result is about comes from one
 * `spkpos`, measured with SPICE's own `vnorm` rather than a hand-rolled norm.
 */
export function spiceGeometryFinder(spice: HeritageSpice): GeometryFinderProvider {
  return {
    gfdist: (target, abcorr, observer, relate, refval, adjust, step, cnfine) =>
      spice.gfdist(target, abcorr, observer, relate, refval, adjust, step, cnfine),
    gfsep: (t1, s1, f1, t2, s2, f2, abcorr, observer, relate, refval, adjust, step, cnfine) =>
      spice.gfsep(t1, s1, f1, t2, s2, f2, abcorr, observer, relate, refval, adjust, step, cnfine),
    gfoclt: (occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, cnfine) =>
      spice.gfoclt(occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, cnfine),
    gfposc: (target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, cnfine) =>
      spice.gfposc(target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, cnfine),
    // J2000 only has to be a frame every kernel set can chain to: the magnitude
    // of the observer→target vector does not depend on the frame it is
    // expressed in.
    range: (target, abcorr, observer, et) =>
      spice.vnorm(spice.spkpos(target, et, 'J2000', abcorr as AberrationCorrection, observer).position),
  };
}

/**
 * One search's provider, plus the means to abandon it.
 *
 * Cancellation is what makes a long search survivable rather than merely
 * non-freezing: a superseded or cancelled search stops making calls instead of
 * running to completion and having its answer thrown away.
 */
interface RunningSearch {
  provider: GeometryFinderProvider;
  cancel(): void;
  /**
   * The whole search is over, however it ended.
   *
   * Said here because this is the only layer that knows: below it a search is
   * an unpredictable sequence of provider calls, and the last is
   * indistinguishable from the rest. The worker path uses it to decide when its
   * worker may be released.
   */
  finish(): void;
  readonly cancelled: boolean;
}

/**
 * Progress of the geometry call currently running, or null when there is none
 * to be had.
 *
 * Null on the main-thread path: the fraction comes from CSPICE's own progress
 * reporter, which only the general GF entry points accept, and only the worker's
 * adapter calls those. A search without it shows an indeterminate spinner, which
 * is what every search showed before.
 */
export type SearchProgress = GeometrySearchProgress | null;

/**
 * The provider this search will use: the worker's when there is one, the main
 * thread's when there is not.
 *
 * The two answer identically — the worker runs the same heritage adapter over
 * the same kernels, with the arguments passed through untouched — so the choice
 * is about where the time is spent, not about what comes back.
 */
function beginSearch(spice: HeritageSpice, window: EtInterval): RunningSearch {
  const worker = getGeometryWorker();
  if (worker) {
    // Only the search that owns the panel writes to it. A superseded search can
    // still report for a moment before it stops, and its progress is nobody's.
    let self: RunningSearch | null = null;
    self = worker.search({
      // The window is what decides which kernels the worker needs: an SPK whose
      // coverage misses it cannot contribute to the answer, and the geometry
      // worker holds its own copy of everything it is given. For a mission-length
      // catalog that is the difference between a second copy of the catalog and a
      // second copy of the two files this search can actually reach.
      scope: geometryScopeForWindow(window),
      onProgress: (progress) => {
        if (active === self) ef.progress = progress;
      },
    });
    return self;
  }

  // No worker: the calls block, and nothing can change that. Cancelling still
  // stops the *next* call, which is why the guard is here rather than only in
  // `runSearch` — a kind that searches an extremum inside each interval it
  // found would otherwise keep going after the user gave up.
  let cancelled = false;
  const base = spiceGeometryFinder(spice);
  const guard = <T extends (...args: never[]) => unknown>(fn: T): T =>
    ((...args: never[]) => {
      if (cancelled) throw new GeometrySearchCancelled();
      return fn(...args);
    }) as T;

  return {
    get cancelled() { return cancelled; },
    cancel() { cancelled = true; },
    // Nothing to release: these calls run on the main thread's own instance,
    // which the viewer keeps for as long as the scene is loaded.
    finish() {},
    provider: {
      gfdist: guard(base.gfdist),
      gfsep: guard(base.gfsep),
      gfoclt: guard(base.gfoclt),
      gfposc: guard(base.gfposc),
      range: guard(base.range!),
    },
  };
}

/**
 * The span the chosen bodies actually have ephemeris for, intersected with the
 * catalog's own span.
 *
 * Without this the finder defaults to the scrubber's full range, which for the
 * Clipper catalog starts about a day before the trajectory kernel does — so the
 * first search a user runs fails with a raw SPICE "insufficient ephemeris data"
 * for a window they never chose. Coverage is a fact SPICE can state (`spkcov`),
 * so the default window respects it instead of making the user discover it.
 *
 * Bodies SPICE cannot name, or that no SPK covers, constrain nothing: a
 * Keplerian body in a kernel-free catalog is not a reason to refuse a window.
 */
export function coverageWindow(
  spice: Pick<HeritageSpice, 'bodn2c' | 'spkcov'>,
  bodies: EventParticipants,
  span: EtInterval,
): EtInterval {
  let { start, end } = span;
  let coverageStart = -Infinity;
  let coverageEnd = Infinity;
  let hasCoverage = false;

  for (const name of Object.values(bodies)) {
    if (!name) continue;
    try {
      const id = spice.bodn2c(name);
      if (id == null) continue;
      const windows = spice.spkcov(id);
      if (windows.length === 0) continue;

      // The outer bounds, not each segment: a gap inside coverage is a fault to
      // report when a search hits it, not a reason to narrow the default.
      const bodyStart = Math.min(...windows.map((w) => w.start));
      const bodyEnd = Math.max(...windows.map((w) => w.end));
      coverageStart = Math.max(coverageStart, bodyStart);
      coverageEnd = Math.min(coverageEnd, bodyEnd);
      start = Math.max(start, bodyStart);
      end = Math.min(end, bodyEnd);
      hasCoverage = true;
    } catch {
      // bodn2c/spkcov throwing means we know nothing about this body's
      // coverage, which is not the same as it having none.
    }
  }

  // A direct state lookup is valid at an SPK endpoint, but gfdist may compute
  // observer state as much as two seconds outside its confinement window.
  // NAIF also requires callers to allow for round-off when assessing coverage,
  // so an exact two-second inset is itself a boundary case. Reserve one extra
  // second, and only on an edge the automatic window actually touches. This is
  // defensive coverage handling; the practical two-year default above is what
  // prevents huge catalog-wide searches in normal use.
  const gfBoundaryInset = 3;
  if (hasCoverage && start === coverageStart) start += gfBoundaryInset;
  if (hasCoverage && end === coverageEnd) end -= gfBoundaryInset;

  return end > start ? { start, end } : span;
}

/**
 * The loaded kernels as a {@link CoverageSource}: their segments, and the
 * calculation a search evaluates, run at one epoch.
 *
 * The probe is the search's own geometry, not a stand-in for it: the GF
 * distance and occultation finders read each observer→target state through
 * the same `spkez` path `spkpos` takes, with the same correction, and GFOCLT
 * additionally reads each body's body-fixed frame and radii.
 */
export function spiceCoverageSource(
  spice: Pick<HeritageSpice, 'bodn2c' | 'bodc2n' | 'spkSegments' | 'spkpos' | 'pxform' | 'bodvrd'>
    & Partial<Pick<HeritageSpice, 'totalLoaded'>>,
): CoverageSource {
  return {
    bodn2c: (name) => spice.bodn2c(name),
    bodc2n: (code) => spice.bodc2n(code),
    spkSegments: () => loadedSegments(spice),
    lightTime: (target, observer, et) => spice.spkpos(target, et, 'J2000', 'NONE', observer).lightTime,
    // The edge solver: swap the roles and ask SPICE for the converged light
    // time from the target's side. Reception reads the target at t - lt, so
    // the observer epoch for target epoch τ is the arrival time of a signal
    // the target emits at τ (XCN); transmission, the departure time of one
    // the target receives at τ (CN).
    observerEpochFor: (vector, targetEt) => {
      const reception = !vector.abcorr.trim().toUpperCase().startsWith('X');
      const { lightTime } = spice.spkpos(
        vector.observer, targetEt, 'J2000', reception ? 'XCN' : 'CN', vector.target,
      );
      return reception ? targetEt + lightTime : targetEt - lightTime;
    },
    correctedLightTime: (vector, et) =>
      spice.spkpos(vector.target, et, 'J2000', vector.abcorr as AberrationCorrection, vector.observer).lightTime,
    probe: (dependencies, et) => {
      for (const v of dependencies.vectors) {
        spice.spkpos(v.target, et, 'J2000', v.abcorr as AberrationCorrection, v.observer);
      }
      for (const frame of dependencies.frames ?? []) spice.pxform(frame, 'J2000', et);
      for (const body of dependencies.radii ?? []) spice.bodvrd(body, 'RADII');
    },
  };
}

/**
 * Segment listings, kept per SPICE instance and kernel count.
 *
 * The listing is a walk over every loaded SPK's descriptors, and the
 * suggestion is recomputed on every body or kind change. A scene load replaces
 * the instance, and a dropped kernel changes its count, so neither can leave a
 * stale listing behind.
 */
const segmentCache = new WeakMap<object, { count: number; segments: readonly SpkSegmentInfo[] }>();

function loadedSegments(
  spice: Pick<HeritageSpice, 'spkSegments'> & Partial<Pick<HeritageSpice, 'totalLoaded'>>,
): readonly SpkSegmentInfo[] {
  const count = spice.totalLoaded?.() ?? -1;
  const cached = segmentCache.get(spice);
  if (cached && cached.count === count) return cached.segments;
  const segments = spice.spkSegments();
  segmentCache.set(spice, { count, segments });
  return segments;
}

/** Recompute the suggestion, for when kernels were furnished into the running scene. */
export function refreshCoverage(): void {
  syncCoverage();
}

/**
 * Recompute the suggestion if kernels changed since it was computed.
 *
 * The comparison is against the count stored with the suggestion itself, not
 * a watcher's memory, so it holds across the panel being closed: kernels
 * dropped while the Event Finder was unmounted are caught the moment it
 * mounts again (and before any search runs).
 */
export function ensureCoverageCurrent(): void {
  if (ef.form && ef.coverageKernelCount !== vs.kernelCount) syncCoverage();
}

export const ef = $state({
  /** The kind being configured. */
  kind: EVENT_KINDS[0].kind,
  /** Bodies, params, window and step, as the form holds them. */
  form: null as EventQueryForm | null,
  /** True while a search is in flight. */
  running: false,
  /**
   * How far the running search's current geometry call has got, or null when
   * the path it is running on cannot say. See {@link SearchProgress}: it is the
   * fraction of one call's window, not of the search, so it can restart —
   * a determinate bar for the step, never a prediction of the whole.
   */
  progress: null as SearchProgress,
  /** Results of the last completed search, chronological. */
  events: [] as GeometryEvent[],
  /** Why the last search could not run. Null when it ran, even if it found nothing. */
  fault: null as EventSearchFault | null,
  /** True once a search has completed, so "no results" reads as an answer. */
  searched: false,
  /** Id of the selected result, or null. */
  selectedId: null as string | null,
  /** Id of the occultation currently represented at the live playhead. */
  activeId: null as string | null,
  /**
   * Display order. Chronological by default, since that is how a mission reads;
   * `metric` answers "which was the closest?" instead. Held here rather than in
   * the component so it survives the panel being closed and reopened.
   */
  sort: 'time' as EventSortMode,
  /** Why a search that ran found nothing, when the kind can say. */
  hint: null as string | null,
  /** True once the user has set the window themselves; stops it being re-derived. */
  windowPinned: false,
  /** Set when the default window was trimmed to the bodies' kernel coverage. */
  windowTrimmed: false,
  /** Stable configured-query identity shared with timeline and later analysis surfaces. */
  configuredId: null as string | null,
  /**
   * When the current query can actually be computed with the loaded kernels,
   * or null when that cannot be assessed (no kernels, bodies not yet chosen,
   * a kind that declares no geometry). See {@link assessEventCoverage}.
   */
  coverage: null as CoverageAssessment | null,
  /** `vs.kernelCount` when {@link coverage} was computed; see `ensureCoverageCurrent`. */
  coverageKernelCount: null as number | null,
});

/** Guards against an earlier search landing after a later one. */
let inFlight = 0;
/** The search currently running, so it can be stopped. */
let active: RunningSearch | null = null;
/** Event currently represented by the renderer's single explanatory overlay. */
let displayedOccultation: GeometryEvent | null = null;

function displayOccultation(event: GeometryEvent | null): void {
  const renderer = getRenderer();
  if (!renderer) return;
  // Result ids are positional within a search and may recur after a rerun.
  // Object identity distinguishes the newly minted result from the stale one.
  if (event === displayedOccultation) return;

  if (!event) {
    renderer.setOccultationGeometry(null);
    displayedOccultation = null;
    return;
  }

  const { observer, front, back } = event.bodies;
  const displayed = observer && front && back && renderer.setOccultationGeometry({
    observer,
    front,
    back,
    state: event.state,
    startEt: eventStart(event),
    endEt: eventEnd(event),
  });
  displayedOccultation = displayed ? event : null;
}

/**
 * Keep explanatory geometry attached to time, not to a stale result click.
 * Selection is only a tie-breaker for overlapping intervals; enabled cached
 * results appear automatically during playback and timeline scrubbing.
 */
export function syncOccultationGeometryAtTime(): GeometryEvent | undefined {
  const activeEvent = activeEventAtTime(
    analysisContext().eventResults.filter((event) => event.kind === 'occultation'),
    vs.et,
    ef.selectedId,
  );
  const activeId = activeEvent?.id ?? null;
  if (ef.activeId !== activeId) ef.activeId = activeId;
  displayOccultation(activeEvent ?? null);
  return activeEvent;
}

/** The kind definition the form is currently configuring. */
export function currentKind(): EventKind<never> {
  return registry.get(ef.kind) ?? EVENT_KINDS[0];
}

const MAX_DEFAULT_SEARCH_SPAN = 2 * 365.25 * 86_400;
const MAX_OCCULTATION_DEFAULT_SEARCH_SPAN = 90 * 86_400;

/**
 * Keep an automatic search window interactive on century-scale kernels.
 * The full catalog remains available through the form's explicit `all` action.
 */
export function practicalSearchWindow(
  span: EtInterval,
  currentTime: number,
  maxSpan = MAX_DEFAULT_SEARCH_SPAN,
): EtInterval {
  const duration = span.end - span.start;
  if (!(duration > maxSpan)) return { ...span };

  const half = maxSpan / 2;
  const center = Math.max(span.start + half, Math.min(span.end - half, currentTime));
  return { start: center - half, end: center + half };
}

/** The practical default inside the catalog's full time span. */
function catalogWindow(): EtInterval {
  const span = vs.scrubBaseMax > vs.scrubBaseMin
    ? { start: vs.scrubBaseMin, end: vs.scrubBaseMax }
    : { start: vs.et, end: vs.et + 86_400 };
  const maxSpan = ef.kind === 'occultation'
    ? MAX_OCCULTATION_DEFAULT_SEARCH_SPAN
    : MAX_DEFAULT_SEARCH_SPAN;
  return practicalSearchWindow(span, vs.et, maxSpan);
}

/**
 * Whether the query `kind` would run with `bodies` can be computed, and when.
 *
 * Params are left to the kind's defaults: no built-in kind's geometry depends
 * on them, and the ones that will (an instrument, a frame) are a matter for
 * the kind's own `geometry`.
 */
function assessFor(kind: EventKind<never>, bodies: EventParticipants): CoverageAssessment | null {
  const spice = getSpice();
  if (!spice) return null;
  const geometry = eventGeometry(
    { id: 'coverage', kind: kind.kind, bodies, window: { start: 0, end: 1 } },
    kind,
  );
  if (!geometry) return null;
  try {
    return assessEventCoverage(geometry, spiceCoverageSource(spice), {
      formatEt: (et) => etToUtcString(et),
    });
  } catch {
    // An assessment that fails is not an assessment of "none": fall back to
    // the plain per-body coverage, as before there was one.
    return null;
  }
}

/** Recompute the suggestion for the form as it now stands. */
function syncCoverage(): void {
  ef.coverage = ef.form ? assessFor(currentKind(), ef.form.bodies) : null;
  ef.coverageKernelCount = vs.kernelCount;
}

/**
 * The usable window a default should use, clipped to `span`: the one holding
 * the current time if any does, else the one sharing most time with `span`.
 * Undefined when none overlaps.
 */
function bestUsableWithin(
  usable: readonly EtInterval[],
  span: EtInterval,
  now: number,
): EtInterval | undefined {
  let best: EtInterval | undefined;
  for (const w of usable) {
    const start = Math.max(w.start, span.start);
    const end = Math.min(w.end, span.end);
    if (!(end > start)) continue;
    if (start <= now && now <= end) return { start, end };
    if (!best || end - start > best.end - best.start) best = { start, end };
  }
  return best;
}

/**
 * The window a fresh form searches: the catalog span, trimmed to where the
 * query can actually be computed.
 *
 * With an assessment, that is the usable window overlapping the catalog span
 * most — one window, never an envelope across a gap. Without one, it falls
 * back to the chosen bodies' own SPK coverage.
 */
function defaultWindow(bodies: EventParticipants = {}): EtInterval {
  const span = catalogWindow();
  const spice = getSpice();
  if (!spice) return span;

  const assessment = assessFor(currentKind(), bodies);
  if (assessment?.status === 'available') {
    const best = bestUsableWithin(assessment.windows, span, vs.et);
    if (best) {
      ef.windowTrimmed = best.start > span.start || best.end < span.end;
      return best;
    }
  }

  const covered = coverageWindow(spice, bodies, span);
  ef.windowTrimmed = covered.start > span.start || covered.end < span.end;
  return covered;
}

/**
 * The parts of the form's window that fall outside every usable window, so a
 * search can be warned about before it runs rather than after SPICE refuses.
 * Empty when the window is fine or there is no assessment to judge it by.
 */
export function windowOutsideUsable(): EtInterval[] {
  if (!ef.form || !ef.coverage || ef.coverage.status === 'unknown') return [];
  return windowOutsideCoverage({ start: ef.form.startEt, end: ef.form.endEt }, ef.coverage.windows);
}

/**
 * Fill From and To with one usable window. Nothing is searched, and the
 * window counts as the user's: they chose it.
 */
export function useAvailableWindow(index: number) {
  const w = ef.coverage?.windows[index];
  if (!w) return;
  setWindow(w.start, w.end);
}

/**
 * Re-derives the window for the bodies now chosen, unless the user has set one.
 *
 * Picking the bodies is what determines which kernels matter, so the window
 * that suits them can only be known after the choice — but a window the user
 * typed is theirs and is never overwritten.
 */
function syncWindowToBodies() {
  if (!ef.form || ef.windowPinned) return;
  const { start, end } = defaultWindow(ef.form.bodies);
  ef.form.startEt = start;
  ef.form.endEt = end;
}

/** Builds the form for the current kind, carrying over what still applies. */
export function resetForm() {
  const previous = ef.form ?? undefined;
  // A user-chosen time range is independent of event type. Preserve it when
  // switching kinds; automatic windows are re-derived so kind-specific limits
  // (such as occultation's shorter practical span) still take effect.
  const window = ef.windowPinned && previous
    ? { start: previous.startEt, end: previous.endEt }
    : defaultWindow(previous?.bodies);
  ef.form = formForKind(currentKind(), window, previous);
  syncWindowToBodies();
  syncConfiguredQuery();
  syncCoverage();
}

/** The configured item backing the current form, if it has been established. */
export function currentConfiguredQuery(): ConfiguredEventQuery | undefined {
  if (!ef.configuredId) return undefined;
  const item = configuredItem(ef.configuredId);
  return item?.type === 'event-query' ? item : undefined;
}

/** Keep the editable form and the durable configured item on one identity. */
function syncConfiguredQuery(): ConfiguredEventQuery | undefined {
  if (!ef.form) return undefined;
  const kind = currentKind();
  const concrete = buildQuery(kind, ef.form, ef.configuredId ?? 'draft');
  const { id: _id, ...query } = concrete;
  const label = concrete.label ?? `${kind.label}: ${Object.values(concrete.bodies).join(' / ')}`;

  let item = ef.configuredId
    ? updateConfiguredEventQuery(
      ef.configuredId,
      query,
      label,
      ef.windowPinned ? 'explicit' : 'automatic',
    )
    : undefined;
  if (!item) {
    item = createConfiguredEventQuery(
      query,
      label,
      ef.windowPinned ? 'explicit' : 'automatic',
    );
    ef.configuredId = item.id;
  }

  // The currently edited relationship supplies defaults to other analysis
  // surfaces. Every configured item still carries overrides, so older items
  // and future comparison profiles do not get rewritten by this assignment.
  analysis.bodies = { ...concrete.bodies };
  return item;
}

export function setCurrentQueryVisible(visible: boolean) {
  if (ef.configuredId) setConfiguredItemVisible(ef.configuredId, visible);
}

/** Every durable event category, in creation order, for the shared timeline controls. */
export function configuredEventQueries(): ConfiguredEventQuery[] {
  return analysis.items.filter((item): item is ConfiguredEventQuery => item.type === 'event-query');
}

export function setConfiguredQueryEnabled(id: string, enabled: boolean) {
  setConfiguredItemEnabled(id, enabled);
}

export function setConfiguredQueryVisible(id: string, visible: boolean) {
  setConfiguredItemVisible(id, visible);
}

/** Start another independently cached event category without discarding this one. */
export function createNewSearch() {
  active?.cancel();
  inFlight++;
  const previous = ef.form ?? undefined;
  ef.configuredId = null;
  ef.windowPinned = false;
  ef.form = formForKind(currentKind(), defaultWindow(previous?.bodies), previous);
  ef.events = [];
  ef.fault = null;
  ef.hint = null;
  ef.searched = false;
  ef.selectedId = null;
  syncWindowToBodies();
  syncConfiguredQuery();
  syncCoverage();
  highlightBodies([]);
  syncOccultationGeometryAtTime();
}

/** Reopen a configured category and its cached results for browsing or editing. */
export function openConfiguredQuery(id: string) {
  const item = configuredItem(id);
  if (!item || item.type !== 'event-query') return;
  const kind = registry.get(item.query.kind);
  if (!kind) return;

  active?.cancel();
  inFlight++;
  ef.kind = kind.kind;
  const window = item.query.window ?? catalogWindow();
  const form = formForKind(kind, window);
  form.bodies = { ...(item.query.bodies ?? {}) };
  form.params = Object.fromEntries(
    Object.entries(item.query.params ?? {}).map(([key, value]) => [key, String(value)]),
  );
  for (const [key, value] of Object.entries(defaultParams(kind))) {
    if (form.params[key] === undefined) form.params[key] = String(value);
  }
  form.step = item.query.step ?? kind.defaultStep;
  ef.form = form;
  ef.configuredId = id;
  ef.events = [...(analysis.eventResults[id] ?? [])];
  ef.searched = Object.prototype.hasOwnProperty.call(analysis.eventResults, id);
  ef.fault = null;
  ef.hint = null;
  ef.selectedId = null;
  // Old saved items have no provenance. Treat them as automatic: every
  // configured query stores a concrete window, so its mere presence cannot
  // mean the user explicitly pinned it.
  ef.windowPinned = item.windowMode === 'explicit';
  ef.windowTrimmed = false;
  syncCoverage();
  highlightBodies([]);
  syncOccultationGeometryAtTime();
}

/** Switches kind, keeping shared roles and params filled in. */
export function setKind(kind: string) {
  if (!registry.has(kind)) return;
  ef.kind = kind;
  resetForm();
  // Search-step completeness belongs to the kind. In particular, carrying the
  // closest-approach default (1 hour) into occultation misses short partial
  // ingress/egress phases that the occultation kind's 10-second default finds.
  if (ef.form) {
    ef.form.step = currentKind().defaultStep;
    syncConfiguredQuery();
  }
  clearResults();
}

export function setRole(role: string, body: string) {
  if (!ef.form) return;
  if (body) ef.form.bodies[role as keyof typeof ef.form.bodies] = body;
  else delete ef.form.bodies[role as keyof typeof ef.form.bodies];
  syncWindowToBodies();
  syncConfiguredQuery();
  syncCoverage();
  clearResults();
}

export function setParam(key: string, value: string) {
  if (!ef.form) return;
  ef.form.params[key] = value;
  syncConfiguredQuery();
  clearResults();
}

export function setWindow(startEt: number, endEt: number) {
  if (!ef.form) return;
  ef.form.startEt = startEt;
  ef.form.endEt = endEt;
  // The user has now said what they want searched; stop second-guessing it.
  ef.windowPinned = true;
  ef.windowTrimmed = false;
  syncConfiguredQuery();
  clearResults();
}

/** Drops a hand-set window and goes back to the default for the loaded coverage. */
export function resetWindow() {
  ef.windowPinned = false;
  syncWindowToBodies();
  syncConfiguredQuery();
  clearResults();
}

export function setSort(mode: EventSortMode) {
  ef.sort = mode;
}

export function setStep(step: number) {
  if (!ef.form) return;
  ef.form.step = step;
  syncConfiguredQuery();
  clearResults();
}

/**
 * Drops the previous result whenever the query changes.
 *
 * A results list that outlives the query that produced it is worse than an
 * empty one: the rows still look like answers, and nothing on screen says they
 * answer a question the form no longer asks. That applies to a result still on
 * its way as much as one already on screen, so a search in flight is abandoned
 * and its token retired here — otherwise editing the form mid-search leaves the
 * old answer to land afterwards, against a query nobody asked.
 */
function clearResults() {
  active?.cancel();
  inFlight++;
  ef.events = [];
  ef.fault = null;
  ef.hint = null;
  ef.searched = false;
  ef.selectedId = null;
  if (ef.configuredId) setEventResults(ef.configuredId, []);
}

/** Runs the configured search, replacing the previous result. */
export async function runSearch() {
  if (!ef.form) resetForm();
  if (!ef.form) return;

  const spice = getSpice();
  if (!spice) {
    ef.events = [];
    ef.searched = false;
    ef.fault = {
      code: 'provider-error',
      message: 'no kernels are loaded yet',
    };
    return;
  }

  ensureCoverageCurrent();
  const item = syncConfiguredQuery();
  if (!item || !item.enabled) return;
  // A search the user has replaced is work nobody wants done; stopping it also
  // frees the worker for the one they do want.
  active?.cancel();

  const running = beginSearch(spice, { start: ef.form.startEt, end: ef.form.endEt });
  active = running;
  const search = new EventSearch({ registry, provider: running.provider });
  const token = ++inFlight;

  ef.running = true;
  ef.progress = null;
  ef.selectedId = null;
  try {
    // Resolution applies the shared context defaults but preserves this item's
    // explicit bodies/window, then enters the unchanged EventQuery boundary.
    const result = await search.run(resolveEventQuery(item, analysisContext()));
    // A later search already answered, or this one was abandoned. Either way
    // there is nothing to show — and a cancelled search's provider error is
    // the cancellation, not a fault worth putting on screen.
    if (token !== inFlight || running.cancelled) return;

    if (result.ok) {
      ef.events = result.events;
      setEventResults(item.id, result.events);
      ef.fault = null;
      ef.hint = result.hint ?? null;
    } else {
      ef.events = [];
      setEventResults(item.id, []);
      ef.fault = result.fault;
      ef.hint = null;
    }
    ef.searched = result.ok;
  } finally {
    // Ownership of the spinner follows `active`, not the token: a search
    // abandoned by an edit to the form has had its token retired, and checking
    // that instead would leave "Searching…" on screen forever. A search
    // superseded by a *newer* one leaves both alone — the new one owns them.
    // Every search says it is done, including one superseded by a newer search:
    // the claim on the worker is this search's to release either way, and the
    // newer one has already made its own.
    running.finish();
    if (active === running) {
      active = null;
      ef.running = false;
      ef.progress = null;
    }
  }
}

/**
 * Stops the running search.
 *
 * Every call it has not made yet stops, and on the worker path so does the one
 * CSPICE is executing right now — by terminating the geometry worker, which is
 * the one thing that stops synchronous wasm, since a worker blocked inside
 * CSPICE will not read its own message queue. So the executing call stops and
 * the next search does not queue behind an abandoned one.
 *
 * Terminating is survivable because searches have a worker of their own: the
 * trajectory caches are on another and are untouched. The next search rebuilds
 * it and re-furnishes, which is why cancelling one search and immediately
 * running another costs about a second.
 */
export function cancelSearch() {
  active?.cancel();
}

/**
 * Selects a result: moves simulation time to it and identifies its bodies in
 * the 3D view.
 *
 * The mapping from event to time-and-bodies is `focusForEvent`'s, not the
 * panel's — every kind gets the same behavior, including the ones that do not
 * exist yet.
 */
export function selectEvent(event: GeometryEvent, anchor: 'start' | 'end' | 'middle' = 'start') {
  if (event.queryId !== ef.configuredId) openConfiguredQuery(event.queryId);
  ef.selectedId = event.id;
  applyEventFocus(focusForEvent(event, anchor), {
    setTime,
    selectBody,
    highlightBodies,
  });
  syncOccultationGeometryAtTime();
}

/** Clears the selection and the highlight it applied. */
export function clearSelection() {
  ef.selectedId = null;
  highlightBodies([]);
  syncOccultationGeometryAtTime();
}

/**
 * Discards everything tied to the scene that just went away.
 *
 * Results outlive nothing: they name bodies from the previous catalog, sit at
 * epochs the new one may not cover, and were computed against kernels that have
 * since been replaced. Left alone they would keep looking like answers. The
 * form goes too, since its bodies and window belong to the old catalog — but
 * the kind and the sort order are preferences rather than data, so they stay.
 */
export function resetForScene() {
  // `clearResults` abandons the search in flight, which matters more here than
  // anywhere: the kernels it was running against are being replaced under it.
  clearResults();
  highlightBodies([]);
  displayOccultation(null);
  ef.form = null;
  ef.activeId = null;
  ef.windowPinned = false;
  ef.windowTrimmed = false;
  ef.configuredId = null;
  ef.coverage = null;
  ef.coverageKernelCount = null;
  resetAnalysis();
}

// Scene loads are the only thing that replaces the kernels and the body list
// underneath a result set. Subscribed at module scope rather than from the
// panel: results have to be invalidated whether or not anyone has it open.
onViewerEvent('load', () => resetForScene());
