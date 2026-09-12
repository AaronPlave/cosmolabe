/**
 * Event finder state — the panel's reactive half.
 *
 * One search at a time: a form, its result, and which result is selected.
 * Everything kind-specific lives in the registered {@link EventKind}s, and
 * everything pure — building the query, formatting a metric — lives in
 * `event-query.ts`. What is left here is the wiring: a GF provider over the
 * viewer's SPICE instance, the async run with its in-flight bookkeeping, and
 * turning a selected event into simulation time plus a 3D highlight.
 */
import {
  EventSearch,
  applyEventFocus,
  builtinEventKinds,
  focusForEvent,
  type EventKind,
  type EventSearchFault,
  type GeometryEvent,
  type GeometryFinderProvider,
} from '@cosmolabe/core';
import type { AberrationCorrection, SpiceInstance } from '@cosmolabe/spice';
import { getSpice } from './loader';
import { buildQuery, formForKind, type EventQueryForm } from './event-query';
import { highlightBodies, selectBody, setTime, vs } from './viewer-state.svelte';

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
});

let sequence = 0;
/** Guards against an earlier search landing after a later one. */
let inFlight = 0;

/** The kind definition the form is currently configuring. */
export function currentKind(): EventKind<never> {
  return registry.get(ef.kind) ?? EVENT_KINDS[0];
}

/** The catalog's full time span — the window a fresh form searches. */
function catalogWindow() {
  return vs.scrubBaseMax > vs.scrubBaseMin
    ? { start: vs.scrubBaseMin, end: vs.scrubBaseMax }
    : { start: vs.et, end: vs.et + 86_400 };
}

/** Builds the form for the current kind, carrying over what still applies. */
export function resetForm() {
  ef.form = formForKind(currentKind(), catalogWindow(), ef.form ?? undefined);
}

/** Switches kind, keeping shared roles and params filled in. */
export function setKind(kind: string) {
  if (!registry.has(kind)) return;
  ef.kind = kind;
  ef.form = formForKind(currentKind(), catalogWindow(), ef.form ?? undefined);
  clearResults();
}

export function setRole(role: string, body: string) {
  if (!ef.form) return;
  if (body) ef.form.bodies[role as keyof typeof ef.form.bodies] = body;
  else delete ef.form.bodies[role as keyof typeof ef.form.bodies];
  clearResults();
}

export function setParam(key: string, value: string) {
  if (!ef.form) return;
  ef.form.params[key] = value;
  clearResults();
}

export function setWindow(startEt: number, endEt: number) {
  if (!ef.form) return;
  ef.form.startEt = startEt;
  ef.form.endEt = endEt;
  clearResults();
}

export function setStep(step: number) {
  if (!ef.form) return;
  ef.form.step = step;
  clearResults();
}

/**
 * Drops the previous result whenever the query changes.
 *
 * A results list that outlives the query that produced it is worse than an
 * empty one: the rows still look like answers, and nothing on screen says they
 * answer a question the form no longer asks.
 */
function clearResults() {
  ef.events = [];
  ef.fault = null;
  ef.searched = false;
  ef.selectedId = null;
}

/** Runs the configured search, replacing the previous result. */
export async function runSearch() {
  if (!ef.form) resetForm();
  const form = ef.form;
  if (!form) return;

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

  const kind = currentKind();
  const search = new EventSearch({ registry, provider: spiceGeometryFinder(spice) });
  const token = ++inFlight;

  ef.running = true;
  ef.selectedId = null;
  try {
    const result = await search.run(buildQuery(kind, form, `q${++sequence}`));
    if (token !== inFlight) return; // a later search already answered

    if (result.ok) {
      ef.events = result.events;
      ef.fault = null;
    } else {
      ef.events = [];
      ef.fault = result.fault;
    }
    ef.searched = result.ok;
  } finally {
    if (token === inFlight) ef.running = false;
  }
}

/**
 * Selects a result: moves simulation time to it and identifies its bodies in
 * the 3D view.
 *
 * The mapping from event to time-and-bodies is `focusForEvent`'s, not the
 * panel's — every kind gets the same behavior, including the ones that do not
 * exist yet.
 */
export function selectEvent(event: GeometryEvent) {
  ef.selectedId = event.id;
  applyEventFocus(focusForEvent(event, 'start'), {
    setTime,
    selectBody,
    highlightBodies,
  });
}

/** Clears the selection and the highlight it applied. */
export function clearSelection() {
  ef.selectedId = null;
  highlightBodies([]);
}
