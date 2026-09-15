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
 * Searches run in the SPICE worker whenever the scene has one. That is not an
 * optimisation: CSPICE's GF routines are synchronous, so a search on the main
 * thread freezes the viewer — no camera, no scrubber, not even a spinner —
 * for as long as it runs, which a one-minute step over a multi-year window
 * makes seconds. The worker already has the catalog's kernels furnished for
 * the trajectory caches, so the search costs no loading of its own. The
 * main-thread provider stays as the fallback for scenes with no worker (test
 * mode, and kernel-free catalogs).
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
  type ConfiguredEventQuery,
  type EtInterval,
  type EventKind,
  type EventParticipants,
  type EventSearchFault,
  type GeometryEvent,
  type GeometryFinderProvider,
} from '@cosmolabe/core';
import type { AberrationCorrection, SpiceInstance } from '@cosmolabe/spice';
import { GeometrySearchCancelled } from '@cosmolabe/three';
import { getCacheWorker, getSpice } from './loader';
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
import { getRenderer, highlightBodies, onViewerEvent, selectBody, setTime, vs } from './viewer-state.svelte';

/** The kinds the panel offers. Registered once; the picker reads this. */
const registry = builtinEventKinds();

export const EVENT_KINDS: EventKind<never>[] = registry.list();

/**
 * The viewer's SPICE instance as a GF provider.
 *
 * `SpiceInstance` already satisfies the GF half of the interface structurally,
 * which is the point of the boundary's signatures mirroring `gf*_c`. Only
 * `range` is added: GF says *when* a distance condition held and never *how
 * far*, so the number a closest-approach result is about comes from one
 * `spkpos`, measured with SPICE's own `vnorm` rather than a hand-rolled norm.
 */
export function spiceGeometryFinder(spice: SpiceInstance): GeometryFinderProvider {
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
  readonly cancelled: boolean;
}

/**
 * The provider this search will use: the worker's when there is one, the main
 * thread's when there is not.
 *
 * The two answer identically — the worker runs the same heritage adapter over
 * the same kernels, with the arguments passed through untouched — so the choice
 * is about where the time is spent, not about what comes back.
 */
function beginSearch(spice: SpiceInstance): RunningSearch {
  const worker = getCacheWorker();
  if (worker) return worker.geometrySearch();

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
  spice: Pick<SpiceInstance, 'bodn2c' | 'spkcov'>,
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

export const ef = $state({
  /** The kind being configured. */
  kind: EVENT_KINDS[0].kind,
  /** Bodies, params, window and step, as the form holds them. */
  form: null as EventQueryForm | null,
  /** True while a search is in flight. */
  running: false,
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

/** The window a fresh form searches: the catalog span, trimmed to coverage. */
function defaultWindow(bodies: EventParticipants = {}): EtInterval {
  const span = catalogWindow();
  const spice = getSpice();
  if (!spice) return span;

  const covered = coverageWindow(spice, bodies, span);
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
  ef.form = formForKind(currentKind(), defaultWindow(previous?.bodies), previous);
  syncWindowToBodies();
  syncConfiguredQuery();
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

  const item = syncConfiguredQuery();
  if (!item || !item.enabled) return;
  // A search the user has replaced is work nobody wants done; stopping it also
  // frees the worker for the one they do want.
  active?.cancel();

  const running = beginSearch(spice);
  active = running;
  const search = new EventSearch({ registry, provider: running.provider });
  const token = ++inFlight;

  ef.running = true;
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
    if (active === running) {
      active = null;
      ef.running = false;
    }
  }
}

/**
 * Abandons the running search.
 *
 * What stops is every call the search has not made yet. A CSPICE call already
 * under way finishes either way — it is synchronous, and there is no point at
 * which it could be interrupted — but on the worker path the viewer is not
 * waiting on it, and its answer is discarded.
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
  resetAnalysis();
}

// Scene loads are the only thing that replaces the kernels and the body list
// underneath a result set. Subscribed at module scope rather than from the
// panel: results have to be invalidated whether or not anyone has it open.
onViewerEvent('load', () => resetForScene());
