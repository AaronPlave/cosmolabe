export type {
  EtInterval,
  EtSeconds,
  EventMetric,
  EventParamSpec,
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
  EVENT_ROLES,
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
export { EventKindRegistry, defaultParams, requiredRoles } from './registry.js';

export type {
  ClosestApproachParams,
  DistanceRangeParams,
  OccultationParams,
  OccultationState,
} from './kinds/index.js';
export {
  BUILTIN_EVENT_KINDS,
  builtinEventKinds,
  closestApproachKind,
  distanceRangeKind,
  occultationKind,
  rangeAt,
  rangeExtremum,
  rangeMetric,
  registerBuiltinEventKinds,
} from './kinds/index.js';

export type { EventSearchOptions, EventSearchRunOptions } from './search.js';
export { EventSearch } from './search.js';
export { EventSearchProgress } from './progress.js';

export type { EventFocus, EventFocusAnchor, EventFocusTarget } from './focus.js';
export {
  applyEventFocus,
  eventNearest,
  eventOverlaps,
  eventTimelineSpan,
  focusForEvent,
} from './focus.js';
