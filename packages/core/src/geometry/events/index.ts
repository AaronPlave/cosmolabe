export type {
  EtInterval,
  EtSeconds,
  EventMetric,
  EventParticipants,
  EventQuery,
  EventRole,
  EventRoleSpec,
  EventSearchFault,
  EventSearchFaultCode,
  EventSearchResult,
  EventTemporality,
  GeometryEvent,
  InstantEvent,
  IntervalEvent,
} from './types.js';
export {
  compareEvents,
  eventBodies,
  eventDuration,
  eventEnd,
  eventMidpoint,
  eventStart,
  isIntervalEvent,
} from './types.js';

export type {
  Awaitable,
  CspiceWasmGeometryFinder,
  GeometryFinderProvider,
} from './provider.js';
export { cspiceWasmGeometryFinder } from './provider.js';

export type { EventKind, EventKindContext, ResolvedEventQuery } from './registry.js';
export { EventKindRegistry, requiredRoles } from './registry.js';

export type { EventSearchOptions } from './search.js';
export { EventSearch } from './search.js';

export type { EventFocus, EventFocusAnchor, EventFocusTarget } from './focus.js';
export {
  applyEventFocus,
  eventNearest,
  eventOverlaps,
  eventTimelineSpan,
  focusForEvent,
} from './focus.js';
