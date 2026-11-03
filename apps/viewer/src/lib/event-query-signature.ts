import { builtinEventKinds, defaultParams, EVENT_ROLES, type EventQuery } from '@cosmolabe/core';
const registry = builtinEventKinds();
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Effective query inputs, independent of JSON property order and display labels. */
export function eventQuerySignature(query: EventQuery): string {
  const kind = registry.get(query.kind);
  const params = { ...(kind ? defaultParams(kind) : {}), ...query.params };
  return JSON.stringify([query.id, query.kind, EVENT_ROLES.map(role => query.bodies[role] ?? null),
    query.window.start, query.window.end, query.step ?? kind?.defaultStep, query.abcorr ?? kind?.defaultAbcorr ?? 'NONE',
    Object.keys(params).sort().map(key => [key, params[key]]), canonical(query.trajectoryAnalysis ?? null)]);
}
