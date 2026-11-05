/**
 * Shared viewer-side analysis state.
 *
 * The core model is deliberately framework-free; this module is the small
 * Svelte adapter that gives every viewer surface the same live playhead,
 * relationship, time span, configured items, and derived results.
 */
import {
  type AnalysisContext,
  type AnalysisQuantity,
  type ConfiguredAnalysisItem,
  type ConfiguredContinuousProfile,
  type ConfiguredEventQuery,
  type EventQueryConfiguration,
  type GeometryEvent,
  type ResolvedContinuousProfile,
  resolveContinuousProfile,
  resolveEventQuery,
  type EventQuery,
} from '@cosmolabe/core';
import { untrack } from 'svelte';
import { vs, emit, sceneId } from './viewer-state.svelte';
import { resetTimeline } from './timeline.svelte';
import { resettable } from './session.svelte';
import { analysisResultGuards } from './trajectory-analysis-identity';
import { eventQuerySignature } from './event-query-signature';

export const analysis = $state({
  bodies: {} as AnalysisContext['bodies'],
  reference: { frame: 'J2000', abcorr: 'LT+S' } as AnalysisContext['reference'],
  items: [] as ConfiguredAnalysisItem[],
  quantities: [] as AnalysisQuantity[],
  eventResults: {} as Record<string, GeometryEvent[]>,
  eventResultRuns: {} as Record<string, { revision: number; scene: number; kernels: number; kernelCount: number; query: EventQuery; contextFrame: string; complete: boolean }>,
  /** Catalog activity intervals, independent of computed event searches and
   * their optional 3D explanatory overlays. */
  catalogActivities: [] as GeometryEvent[],
});
resettable(analysis);

let itemSequence = 0;
let resultSequence = 0;

/** Context inputs only, so checking a batch cannot recurse through its own results. */
function queryContext(): AnalysisContext {
  return { bodies: analysis.bodies, reference: analysis.reference,
    window: { start: vs.scrubBaseMin, end: vs.scrubBaseMax }, currentTime: 0, quantities: [], eventResults: [] };
}
export function currentEventResultRun(id: string) {
  const run = analysis.eventResultRuns[id], item = configuredItem(id);
  return run && item?.type === 'event-query' && run.complete && run.scene === sceneId()
    && run.kernels === vs.kernelRevision && run.kernelCount === vs.kernelCount
    && (analysis.eventResults[id] ?? []).every(event => !event.trajectoryAnalysis || analysisResultGuards.get(`${id}/${event.id}`)?.())
    && run.contextFrame === analysis.reference.frame
    && eventQuerySignature(run.query) === eventQuerySignature(resolveEventQuery(item, queryContext())) ? run : null;
}

/** The live context consumed by event, timeline, measurement, and 3D surfaces. */
export function analysisContext(): AnalysisContext {
  const enabledEventIds = new Set(
    analysis.items
      .filter((item) => item.type === 'event-query' && item.enabled)
      .map((item) => item.id),
  );

  return {
    bodies: { ...analysis.bodies },
    reference: { ...analysis.reference },
    window: { start: vs.scrubBaseMin, end: vs.scrubBaseMax },
    currentTime: vs.et,
    quantities: analysis.quantities,
    // Visibility is a presentation concern; enabled is the participation
    // boundary shared by 3D, measurement, and other analysis consumers.
    eventResults: Object.entries(analysis.eventResults)
      .filter(([id]) => enabledEventIds.has(id) && currentEventResultRun(id))
      .flatMap(([, events]) => events),
  };
}

export function configuredItem(id: string): ConfiguredAnalysisItem | undefined {
  return analysis.items.find((item) => item.id === id);
}

export function createConfiguredEventQuery(
  query: EventQueryConfiguration,
  label: string,
  windowMode: ConfiguredEventQuery['windowMode'] = 'automatic',
  id?: string,
): ConfiguredEventQuery {
  let identity = id;
  if (identity === undefined) {
    do { identity = `event-query-${++itemSequence}`; } while (analysis.items.some(item => item.id === identity));
  }
  if (Object.hasOwn(Object.prototype, identity) || analysis.items.some(item => item.id === identity)) throw new Error('Event query ID is reserved or already in use');
  const item: ConfiguredEventQuery = {
    id: identity,
    type: 'event-query',
    label,
    enabled: true,
    visible: true,
    query,
    windowMode,
  };
  analysis.items.push(item);
  emit('events', {});
  return item;
}

export function createConfiguredProfile(
  profile: ConfiguredContinuousProfile['profile'],
  label: string,
  id?: string,
): ConfiguredContinuousProfile {
  let identity = id;
  if (identity === undefined) {
    do { identity = `continuous-profile-${++itemSequence}`; } while (configuredItem(identity));
  }
  if (Object.hasOwn(Object.prototype, identity) || configuredItem(identity)) throw new Error('Profile ID is reserved or already in use');
  const item: ConfiguredContinuousProfile = {
    id: identity,
    type: 'continuous-profile',
    label,
    enabled: true,
    visible: true,
    profile,
  };
  analysis.items.push(item);
  emit('events', {});
  return item;
}

/** Replace configuration without replacing the item's stable identity/state. */
export function updateConfiguredEventQuery(
  id: string,
  query: EventQueryConfiguration,
  label?: string,
  windowMode?: ConfiguredEventQuery['windowMode'],
): ConfiguredEventQuery | undefined {
  const item = configuredItem(id);
  if (!item || item.type !== 'event-query') return undefined;
  item.query = query;
  if (label !== undefined) item.label = label;
  if (windowMode !== undefined) item.windowMode = windowMode;
  emit('events', {});
  return item;
}

/** Replace a profile's configuration, keeping its id, flags and row position. */
export function updateConfiguredProfile(
  id: string,
  profile: ConfiguredContinuousProfile['profile'],
  label?: string,
): ConfiguredContinuousProfile | undefined {
  const item = configuredItem(id);
  if (!item || item.type !== 'continuous-profile') return undefined;
  item.profile = profile;
  if (label !== undefined) item.label = label;
  emit('events', {});
  return item;
}

/** Configured profiles in row order — the order the timeline stacks them in. */
export function configuredProfiles(): ConfiguredContinuousProfile[] {
  return analysis.items.filter(
    (item): item is ConfiguredContinuousProfile => item.type === 'continuous-profile',
  );
}

/**
 * Moves a profile one row up (`-1`) or down (`1`) among the enabled profiles —
 * the rows the timeline draws. Event queries and disabled profiles
 * interleaved in `items` keep their places.
 */
export function moveConfiguredProfile(id: string, delta: -1 | 1) {
  const profiles = configuredProfiles().filter((item) => item.enabled);
  const from = profiles.findIndex((item) => item.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= profiles.length) return;
  const a = analysis.items.indexOf(profiles[from]);
  const b = analysis.items.indexOf(profiles[to]);
  [analysis.items[a], analysis.items[b]] = [analysis.items[b], analysis.items[a]];
}

/**
 * Moves an event search one place among the other event searches —
 * lane order, overview band order, list order — leaving interleaved profile
 * items where they are.
 */
export function moveConfiguredEventQuery(id: string, delta: -1 | 1) {
  const queries = analysis.items.filter((item) => item.type === 'event-query');
  const from = queries.findIndex((item) => item.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= queries.length) return;
  const a = analysis.items.indexOf(queries[from]);
  const b = analysis.items.indexOf(queries[to]);
  [analysis.items[a], analysis.items[b]] = [analysis.items[b], analysis.items[a]];
}

/** Removes a configured item and anything derived from it. */
export function removeConfiguredItem(id: string) {
  const i = analysis.items.findIndex((item) => item.id === id);
  if (i >= 0) analysis.items.splice(i, 1);
  delete analysis.eventResults[id];
  delete analysis.eventResultRuns[id];
  emit('events', {});
}

/**
 * A profile with the shared defaults applied, for sampling.
 *
 * Goes through the core `resolveContinuousProfile` boundary but not through
 * `analysisContext()`: that reads the live playhead, and a sampler that
 * depended on it would resample the whole trace every frame of playback.
 */
export function resolveProfile(item: ConfiguredContinuousProfile): ResolvedContinuousProfile {
  return resolveContinuousProfile(item, {
    bodies: analysis.bodies,
    reference: analysis.reference,
    window: { start: vs.scrubBaseMin, end: vs.scrubBaseMax },
    currentTime: untrack(() => vs.et),
    quantities: [],
    eventResults: [],
  });
}

export function setConfiguredItemEnabled(id: string, enabled: boolean) {
  const item = configuredItem(id);
  if (item) item.enabled = enabled;
  emit('events', {});
}

export function setConfiguredItemVisible(id: string, visible: boolean) {
  const item = configuredItem(id);
  if (item) item.visible = visible;
  emit('events', {});
}

export function setEventResults(id: string, events: readonly GeometryEvent[], complete = true) {
  analysis.eventResults[id] = [...events];
  const item = configuredItem(id);
  if (item?.type === 'event-query') analysis.eventResultRuns[id] = {
    revision: ++resultSequence, scene: sceneId(), kernels: vs.kernelRevision, kernelCount: vs.kernelCount,
    query: JSON.parse(JSON.stringify(resolveEventQuery(item, queryContext()))),
    contextFrame: analysis.reference.frame ?? 'J2000', complete,
  };
  emit('events', {});
}

/** Events the timeline should draw; disabled and hidden items remain configured. */
export function visibleTimelineEvents(): GeometryEvent[] {
  return [...analysis.catalogActivities, ...analysis.items.flatMap((item) =>
    item.type === 'event-query' && item.enabled && item.visible && currentEventResultRun(item.id)
      ? (analysis.eventResults[item.id] ?? [])
      : [],
  )];
}

/** Selection includes hidden search results as well as catalog activities. */
export function allTimelineEvents(): GeometryEvent[] {
  return [...analysis.catalogActivities, ...analysisContext().eventResults];
}

export function setCatalogActivities(events: readonly GeometryEvent[]) {
  analysis.catalogActivities = [...events];
}

/** Scene-owned analysis state must never leak into the next catalog. */
export function resetAnalysis() {
  analysis.bodies = {};
  analysis.items.length = 0;
  analysis.quantities.length = 0;
  analysis.eventResults = {};
  analysis.eventResultRuns = {};
  analysis.catalogActivities = [];
  resetTimeline();
}
