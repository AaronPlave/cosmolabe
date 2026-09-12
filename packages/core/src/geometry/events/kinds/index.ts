import { EventKindRegistry } from '../registry.js';
import { closestApproachKind } from './closest-approach.js';
import { distanceRangeKind } from './distance-range.js';

export type { ClosestApproachParams } from './closest-approach.js';
export { closestApproachKind } from './closest-approach.js';
export type { DistanceRangeParams } from './distance-range.js';
export { distanceRangeKind } from './distance-range.js';
export { rangeAt, rangeExtremum, rangeMetric } from './range-metrics.js';

/**
 * The event kinds Cosmolabe ships, in the order a picker should offer them.
 *
 * Both are distance searches over `gfdist`, which is the whole of the first
 * slice: occultation, eclipse, FOV access, phase angle and latitude crossings
 * are further entries in this list, not further subsystems.
 */
export const BUILTIN_EVENT_KINDS = [closestApproachKind, distanceRangeKind] as const;

/** A registry holding the built-in kinds — the usual starting point. */
export function builtinEventKinds(): EventKindRegistry {
  return registerBuiltinEventKinds(new EventKindRegistry());
}

/** Adds the built-in kinds to an existing registry, e.g. beside app-specific ones. */
export function registerBuiltinEventKinds(registry: EventKindRegistry): EventKindRegistry {
  // Registered one by one rather than in a loop over BUILTIN_EVENT_KINDS: each
  // kind carries its own params type, and a loop would erase them all to a cast.
  registry.register(closestApproachKind);
  registry.register(distanceRangeKind);
  return registry;
}
