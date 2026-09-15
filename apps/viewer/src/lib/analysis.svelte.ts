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
} from '@cosmolabe/core';
import { vs } from './viewer-state.svelte';

export const analysis = $state({
  bodies: {} as AnalysisContext['bodies'],
  reference: { frame: 'J2000', abcorr: 'LT+S' } as AnalysisContext['reference'],
  items: [] as ConfiguredAnalysisItem[],
  quantities: [] as AnalysisQuantity[],
  eventResults: {} as Record<string, GeometryEvent[]>,
});

let itemSequence = 0;

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
      .filter(([id]) => enabledEventIds.has(id))
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
): ConfiguredEventQuery {
  const item: ConfiguredEventQuery = {
    id: `event-query-${++itemSequence}`,
    type: 'event-query',
    label,
    enabled: true,
    visible: true,
    query,
    windowMode,
  };
  analysis.items.push(item);
  return item;
}

export function createConfiguredProfile(
  profile: ConfiguredContinuousProfile['profile'],
  label: string,
): ConfiguredContinuousProfile {
  const item: ConfiguredContinuousProfile = {
    id: `continuous-profile-${++itemSequence}`,
    type: 'continuous-profile',
    label,
    enabled: true,
    visible: true,
    profile,
  };
  analysis.items.push(item);
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
  return item;
}

export function setConfiguredItemEnabled(id: string, enabled: boolean) {
  const item = configuredItem(id);
  if (item) item.enabled = enabled;
}

export function setConfiguredItemVisible(id: string, visible: boolean) {
  const item = configuredItem(id);
  if (item) item.visible = visible;
}

export function setEventResults(id: string, events: readonly GeometryEvent[]) {
  analysis.eventResults[id] = [...events];
}

/** Events the timeline should draw; disabled and hidden items remain configured. */
export function visibleTimelineEvents(): GeometryEvent[] {
  return analysis.items.flatMap((item) =>
    item.type === 'event-query' && item.enabled && item.visible
      ? (analysis.eventResults[item.id] ?? [])
      : [],
  );
}

/** Scene-owned analysis state must never leak into the next catalog. */
export function resetAnalysis() {
  analysis.bodies = {};
  analysis.items.length = 0;
  analysis.quantities.length = 0;
  analysis.eventResults = {};
}
