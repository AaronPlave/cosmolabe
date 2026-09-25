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
  builtinEventKinds,
  defaultParams,
  eventEnd,
  eventStart,
  focusForEvent,
  resolveEventQuery,
  SpiceTrajectory,
  type ConfiguredEventQuery,
  type EtInterval,
  type EventKind,
  type EventParticipants,
  type EventSearchFault,
  type GeometryEvent,
  type GeometryFinderProvider,
  type AberrationCorrection,
} from '@cosmolabe/core';
import type { HeritageSpice } from '@cosmolabe/frames';
import { GeometrySearchCancelled, type GeometrySearchProgress } from '@cosmolabe/three';
import { geometryScopeForWindow, getGeometryWorker, getSpice, getUniverse } from './loader';
import {
  activeEventAtTime,
  buildQuery,
  eventCalloutLines,
  eventSceneAnnotationLines,
  formForKind,
  type EventQueryForm,
  type EventSortMode,
} from './event-query';
import {
  analysis,
  analysisContext,
  configuredItem,
  createConfiguredEventQuery,
  removeConfiguredItem,
  resetAnalysis,
  setConfiguredItemVisible,
  setConfiguredItemEnabled,
  setEventResults,
  updateConfiguredEventQuery,
} from './analysis.svelte';
import { etToUtcString, getRenderer, highlightBodies, onViewerEvent, selectBody, setTime, vs } from './viewer-state.svelte';

/** The kinds the panel offers. Registered once; the picker reads this. */
const registry = builtinEventKinds();

export const EVENT_KINDS: EventKind<never>[] = registry.list();

/**
 * The name SPICE should be given for a catalog body.
 *
 * The finder's form, its results and the 3D highlight all speak catalog display
 * names, but a display name is not a SPICE name: the Psyche frames kernel maps
 * `PSYCHE` to the asteroid (2000016) while the catalog's "Psyche" is the
 * spacecraft (-255), so passing the name through silently measured the wrong
 * object. The catalog already says which SPICE object a body is — its `naifId`,
 * or the target of its SPICE trajectory — and only a body that says neither
 * falls back to its name.
 */
export function spiceNameForBody(
  body: { naifId?: number; trajectory?: unknown } | undefined,
  name: string,
): string {
  if (body?.naifId != null) return String(body.naifId);
  if (body?.trajectory instanceof SpiceTrajectory) return body.trajectory.spiceTarget;
  return name;
}

/** Display name → SPICE name for the scene that is up. */
function sceneSpiceName(name: string): string {
  return spiceNameForBody(getUniverse()?.getBody(name), name);
}

/**
 * A provider that takes catalog display names and hands SPICE the bodies they
 * mean. Only body arguments are translated; frames and shapes pass untouched.
 */
export function withSpiceNames(
  provider: GeometryFinderProvider,
  toSpice: (name: string) => string,
): GeometryFinderProvider {
  const range = provider.range;
  return {
    gfdist: (target, abcorr, observer, ...rest) =>
      provider.gfdist(toSpice(target), abcorr, toSpice(observer), ...rest),
    gfsep: (t1, s1, f1, t2, s2, f2, abcorr, observer, ...rest) =>
      provider.gfsep(toSpice(t1), s1, f1, toSpice(t2), s2, f2, abcorr, toSpice(observer), ...rest),
    gfoclt: (occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, ...rest) =>
      provider.gfoclt(occtyp, toSpice(front), fshape, fframe, toSpice(back), bshape, bframe, abcorr, toSpice(observer), ...rest),
    gfposc: (target, frame, abcorr, observer, ...rest) =>
      provider.gfposc(toSpice(target), frame, abcorr, toSpice(observer), ...rest),
    ...(range
      ? { range: (target: string, abcorr: string, observer: string, et: number) =>
          range(toSpice(target), abcorr, toSpice(observer), et) }
      : {}),
  };
}

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
  toSpice: (name: string) => string = (name) => name,
): EtInterval {
  let { start, end } = span;
  let coverageStart = -Infinity;
  let coverageEnd = Infinity;
  let hasCoverage = false;

  for (const name of Object.values(bodies)) {
    if (!name) continue;
    try {
      const spiceName = toSpice(name);
      const id = /^-?\d+$/.test(spiceName) ? Number(spiceName) : spice.bodn2c(spiceName);
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
  /**
   * The selected result, or null: an id and the query it belongs to. Result
   * ids are unique only within a query, so the pair is the identity — and it
   * is independent of which query the form is editing (`configuredId`), so
   * opening another search to edit does not drop the selection.
   */
  selectedId: null as string | null,
  selectedQueryId: null as string | null,
  /** Shared transient preview from scene, result list, or timeline. */
  previewId: null as string | null,
  previewQueryId: null as string | null,
  /** Id and query of the occultation represented at the live playhead. */
  activeId: null as string | null,
  activeQueryId: null as string | null,
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
  /**
   * The configured query the form is editing, or null for a draft. A draft is
   * not a saved search yet: it becomes one (a durable `ConfiguredEventQuery`,
   * with a timeline lane) when it is run. Zero searches is a valid state.
   */
  configuredId: null as string | null,
});

/** Guards against an earlier search landing after a later one. */
let inFlight = 0;
/** The search currently running, so it can be stopped. */
let active: RunningSearch | null = null;
/** Event currently represented by the renderer's single explanatory overlay. */
let displayedOccultation: GeometryEvent | null = null;
let unsubscribeSceneMarkerClick: (() => void) | null = null;
let unsubscribeSceneMarkerHover: (() => void) | null = null;

export function previewEvent(event: GeometryEvent | null, boundary?: 'start' | 'end'): void {
  ef.previewId = event?.id ?? null;
  ef.previewQueryId = event?.queryId ?? null;
  if (!event) {
    getRenderer()?.setEventPreview(null);
    return;
  }
  const lines = eventCalloutLines(event, { boundary, utc: etToUtcString });
  getRenderer()?.setEventPreview(event, lines.join('\n'), boundary);
}

/** Whether `event` is the selected result. */
export function isSelectedEvent(event: Pick<GeometryEvent, 'id' | 'queryId'>): boolean {
  return ef.selectedId === event.id && ef.selectedQueryId === event.queryId;
}

/** The selected result among `events`, if it is there. */
export function selectedEventOf<T extends Pick<GeometryEvent, 'id' | 'queryId'>>(events: readonly T[]): T | undefined {
  return ef.selectedId == null ? undefined : events.find(isSelectedEvent);
}

function setSelection(event: Pick<GeometryEvent, 'id' | 'queryId'> | null) {
  ef.selectedId = event?.id ?? null;
  ef.selectedQueryId = event?.queryId ?? null;
}

/** Drops the selection if it belongs to query `id`: its results are going. */
function dropSelectionIn(id: string | null): boolean {
  if (id == null || ef.selectedQueryId !== id) return false;
  setSelection(null);
  return true;
}

function syncEventResultsInScene(): void {
  const renderer = getRenderer();
  if (!renderer) return;
  const selected = selectedEventOf(analysisContext().eventResults) ?? null;
  // Brief: the global inspector carries the selection's full detail.
  const annotation = selected ? eventSceneAnnotationLines(selected).join('\n') : '';
  renderer.setEventResults(analysisContext().eventResults, selected, annotation);
}

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
    ef.selectedId && ef.selectedQueryId ? { id: ef.selectedId, queryId: ef.selectedQueryId } : null,
  );
  const activeId = activeEvent?.id ?? null;
  const activeQueryId = activeEvent?.queryId ?? null;
  if (ef.activeId !== activeId) ef.activeId = activeId;
  if (ef.activeQueryId !== activeQueryId) ef.activeQueryId = activeQueryId;
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

/** The window a fresh form searches: the catalog span, trimmed to coverage. */
function defaultWindow(bodies: EventParticipants = {}): EtInterval {
  const span = catalogWindow();
  const spice = getSpice();
  if (!spice) return span;

  const covered = coverageWindow(spice, bodies, span, sceneSpiceName);
  ef.windowTrimmed = covered.start > span.start || covered.end < span.end;
  return covered;
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
}

/** The configured item backing the current form, if it has been established. */
export function currentConfiguredQuery(): ConfiguredEventQuery | undefined {
  if (!ef.configuredId) return undefined;
  const item = configuredItem(ef.configuredId);
  return item?.type === 'event-query' ? item : undefined;
}

/**
 * Keep the editable form and the durable configured item on one identity.
 *
 * Editing a configured search updates it in place. A draft stays a draft —
 * only `persist` (running it) saves it as a search — so an open form
 * never materialises a search, or a lane, on its own.
 */
function syncConfiguredQuery(persist = false): ConfiguredEventQuery | undefined {
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
  if (!item && persist) {
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

/** Every durable event search, in creation order, for the shared timeline controls. */
export function configuredEventQueries(): ConfiguredEventQuery[] {
  return analysis.items.filter((item): item is ConfiguredEventQuery => item.type === 'event-query');
}

/**
 * Enables or disables a search in the analysis. Disabling takes its results
 * out of the analysis, so a preview or selection of one of them goes too —
 * unlike hiding it from the timeline (`setConfiguredQueryVisible`), which
 * leaves the selection valid.
 */
export function setConfiguredQueryEnabled(id: string, enabled: boolean) {
  setConfiguredItemEnabled(id, enabled);
  if (!enabled && ef.previewQueryId === id) previewEvent(null);
  if (!enabled && ef.selectedQueryId === id) {
    clearSelection();
    return;
  }
  syncEventResultsInScene();
}

export function setConfiguredQueryVisible(id: string, visible: boolean) {
  setConfiguredItemVisible(id, visible);
}

/**
 * Removes a configured event search and everything tied to it: its item
 * and cached results (so its timeline lane goes too), a selection or preview
 * of one of its results, and — if it was the search being edited — the
 * form, which moves to an adjacent search or, with none left, stays as
 * an unsaved draft: zero searches is a valid state.
 */
export function removeConfiguredQuery(id: string) {
  const queries = configuredEventQueries();
  const index = queries.findIndex((query) => query.id === id);
  if (index < 0) return;
  if (ef.previewQueryId === id) previewEvent(null);
  if (dropSelectionIn(id)) highlightBodies([]);
  const wasCurrent = ef.configuredId === id;
  if (wasCurrent) {
    active?.cancel();
    inFlight++;
    ef.configuredId = null;
  }
  removeConfiguredItem(id);
  if (wasCurrent) {
    const next = queries[index + 1] ?? queries[index - 1];
    if (next) {
      openConfiguredQuery(next.id);
      return;
    }
    // The last one: zero searches, and the form keeps the removed query's
    // settings as an unsaved draft rather than re-creating it.
    ef.events = [];
    ef.fault = null;
    ef.hint = null;
    ef.searched = false;
  }
  syncEventResultsInScene();
  syncOccultationGeometryAtTime();
}

/**
 * Start a draft for another event search, without discarding this one. It
 * is saved when it runs. An existing selection stays.
 */
export function createNewSearch() {
  previewEvent(null);
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
  syncWindowToBodies();
  syncConfiguredQuery();
  syncEventResultsInScene();
  syncOccultationGeometryAtTime();
}

/** Reopen a configured search and its cached results for browsing or editing. */
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
  // Opening a search to edit leaves the selection alone: it may belong to
  // any query, and stays until it is cleared or replaced.
  // Old saved items have no provenance. Treat them as automatic: every
  // configured query stores a concrete window, so its mere presence cannot
  // mean the user explicitly pinned it.
  ef.windowPinned = item.windowMode === 'explicit';
  ef.windowTrimmed = false;
  syncEventResultsInScene();
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

/** Drops a hand-set window and goes back to the coverage-trimmed default. */
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
  previewEvent(null);
  active?.cancel();
  inFlight++;
  ef.events = [];
  ef.fault = null;
  ef.hint = null;
  ef.searched = false;
  dropSelectionIn(ef.configuredId);
  if (ef.configuredId) setEventResults(ef.configuredId, []);
  syncEventResultsInScene();
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

  const item = syncConfiguredQuery(true);
  if (!item || !item.enabled) return;
  previewEvent(null);
  // A search the user has replaced is work nobody wants done; stopping it also
  // frees the worker for the one they do want.
  active?.cancel();

  const running = beginSearch(spice, { start: ef.form.startEt, end: ef.form.endEt });
  active = running;
  const search = new EventSearch({ registry, provider: withSpiceNames(running.provider, sceneSpiceName) });
  const token = ++inFlight;

  ef.running = true;
  ef.progress = null;
  dropSelectionIn(item.id);
  syncEventResultsInScene();
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
    syncEventResultsInScene();
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
export function selectEvent(event: GeometryEvent, anchor: 'start' | 'end' | 'middle' | number = 'start') {
  // Selecting inspects a result; it does not change which search the form
  // is editing. Editing is its own action (`openConfiguredQuery`, a lane
  // label). The selection is shown wherever it is, by the global inspector.
  setSelection(event);
  const focus = focusForEvent(event, typeof anchor === 'number' ? 'start' : anchor);
  if (typeof anchor === 'number') focus.et = Math.max(eventStart(event), Math.min(anchor, eventEnd(event)));
  applyEventFocus(focus, {
    setTime,
    selectBody,
    highlightBodies,
  });
  syncEventResultsInScene();
  syncOccultationGeometryAtTime();
}

/** Clears the selection and the highlight it applied. */
export function clearSelection() {
  setSelection(null);
  highlightBodies([]);
  syncEventResultsInScene();
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
  unsubscribeSceneMarkerClick?.();
  unsubscribeSceneMarkerClick = null;
  unsubscribeSceneMarkerHover?.();
  unsubscribeSceneMarkerHover = null;
  previewEvent(null);
  setSelection(null);
  // `clearResults` abandons the search in flight, which matters more here than
  // anywhere: the kernels it was running against are being replaced under it.
  clearResults();
  highlightBodies([]);
  displayOccultation(null);
  ef.form = null;
  ef.activeId = null;
  ef.activeQueryId = null;
  ef.windowPinned = false;
  ef.windowTrimmed = false;
  ef.configuredId = null;
  resetAnalysis();
}

// Scene loads are the only thing that replaces the kernels and the body list
// underneath a result set. Subscribed at module scope rather than from the
// panel: results have to be invalidated whether or not anyone has it open.
onViewerEvent('load', () => {
  resetForScene();
  unsubscribeSceneMarkerClick = getRenderer()?.events.on('event:click', ({ id, queryId, et }) => {
    const event = analysisContext().eventResults.find((item) => item.id === id && item.queryId === queryId);
    if (event) selectEvent(event, et);
  }) ?? null;
  unsubscribeSceneMarkerHover = getRenderer()?.events.on('event:hover', (hit) => {
    const event = hit ? analysisContext().eventResults.find((item) => item.id === hit.id && item.queryId === hit.queryId) : null;
    previewEvent(event ?? null, hit?.boundary);
  }) ?? null;
});
