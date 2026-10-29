/** UI and host use the same semantic operations over the current catalog snapshot. */
import { adjacentActivity, type MissionActivity } from '@cosmolabe/core';
import type { ScriptActivityFilter } from '@cosmolabe/control';
import { vs, setTime, getRenderer } from './viewer-state.svelte';
import { isSelectedEvent, selectEventForInspection } from './event-finder.svelte';
import { activityEvent } from './mission-activities';

export function listActivities(filter: ScriptActivityFilter = {}): MissionActivity[] {
  return vs.activities.filter(a => (!filter.vehicle || a.vehicle === filter.vehicle) && (!filter.kind || a.kind === filter.kind));
}
export function getActivity(id: string) { return vs.activities.find(a => a.id === id); }
export function getSelectedActivity() { return vs.activities.find(a => isSelectedEvent(activityEvent(a))); }
export function selectActivity(id: string): boolean {
  const a = getActivity(id);
  if (!a || a.enabled === false) return false;
  selectEventForInspection(activityEvent(a));
  return true;
}
export function seekActivity(id: string, edge: 'start' | 'end' = 'start'): boolean {
  const a = getActivity(id);
  if (!a || a.enabled === false || !getRenderer() || (edge !== 'start' && edge !== 'end')) return false;
  setTime(a[edge]);
  return true;
}
export function navigateActivity(direction: 'previous' | 'next', filter: ScriptActivityFilter = {}): boolean {
  if (direction !== 'previous' && direction !== 'next') return false;
  const a = adjacentActivity(listActivities(filter).filter(a => a.enabled !== false), vs.et, direction === 'next' ? 1 : -1, getSelectedActivity()?.id);
  return a ? selectActivity(a.id) : false;
}
