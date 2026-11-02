import { builtinEventKinds, defaultParams, EVENT_ROLES, type EventQuery } from '@cosmolabe/core';
const registry = builtinEventKinds();
/** Effective query inputs, independent of JSON property order and display labels. */
export function eventQuerySignature(query: EventQuery): string {
  const kind = registry.get(query.kind);
  const params = { ...(kind ? defaultParams(kind) : {}), ...query.params };
  return JSON.stringify([query.id, query.kind, EVENT_ROLES.map(role => query.bodies[role] ?? null),
    query.window.start, query.window.end, query.step ?? kind?.defaultStep, query.abcorr ?? kind?.defaultAbcorr ?? 'NONE',
    Object.keys(params).sort().map(key => [key, params[key]])]);
}
