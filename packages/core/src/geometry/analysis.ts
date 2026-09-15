import type {
  EtInterval,
  EtSeconds,
  EventParticipants,
  EventQuery,
  GeometryEvent,
} from './events/types.js';

/** Frame and light-time conventions shared by analysis consumers. */
export interface AnalysisReferenceContext {
  /** Reference frame used when a quantity does not choose one explicitly. */
  frame: string;
  /** Default SPICE aberration correction for geometry calculations. */
  abcorr?: string;
}

/** A geometry value already derived at one instant. */
export interface AnalysisQuantity {
  id: string;
  quantity: string;
  et: EtSeconds;
  value: number;
  unit?: string;
  bodies: EventParticipants;
}

/**
 * The relationship all analysis surfaces currently have in common.
 *
 * This is intentionally a snapshot rather than a state-management object.
 * Hosts own reactivity and expose the same snapshot to the timeline, result
 * panels, measurements, and 3D view so none of those surfaces invents another
 * playhead, time window, or observer/target selection.
 */
export interface AnalysisContext {
  bodies: EventParticipants;
  reference: AnalysisReferenceContext;
  window: EtInterval;
  currentTime: EtSeconds;
  quantities: readonly AnalysisQuantity[];
  eventResults: readonly GeometryEvent[];
}

interface ConfiguredAnalysisItemBase {
  /** Stable identity across edits, executions, and UI consumers. */
  id: string;
  label: string;
  /** Whether this definition participates in analysis work. */
  enabled: boolean;
  /** Whether a timeline or other presentation surface should show it. */
  visible: boolean;
}

/**
 * An event search before context defaults are applied.
 *
 * Bodies and the window are optional here, but remain required on EventQuery:
 * calculation code therefore receives a complete request while configured
 * items can inherit the active relationship and analysis span.
 */
export type EventQueryConfiguration<P = Record<string, unknown>> =
  Omit<EventQuery<P>, 'id' | 'bodies' | 'window'> & {
    bodies?: EventParticipants;
    window?: EtInterval;
  };

export interface ConfiguredEventQuery<P = Record<string, unknown>>
  extends ConfiguredAnalysisItemBase {
  type: 'event-query';
  query: EventQueryConfiguration<P>;
  /** Whether the stored window follows scene/body coverage or was chosen by the user. */
  windowMode?: 'automatic' | 'explicit';
}

/** A time-series definition. Sampling and rendering belong to its consumer. */
export interface ContinuousProfileConfiguration {
  /** Stable quantity vocabulary, e.g. `range` or `phase-angle`. */
  quantity: string;
  bodies?: EventParticipants;
  window?: EtInterval;
  frame?: string;
  abcorr?: string;
  /** Requested sample spacing in seconds, when the sampler supports it. */
  step?: EtSeconds;
}

export interface ConfiguredContinuousProfile extends ConfiguredAnalysisItemBase {
  type: 'continuous-profile';
  profile: ContinuousProfileConfiguration;
}

export type ConfiguredAnalysisItem = ConfiguredEventQuery | ConfiguredContinuousProfile;

/** A profile definition with all shared defaults made explicit. */
export interface ResolvedContinuousProfile extends ContinuousProfileConfiguration {
  bodies: EventParticipants;
  window: EtInterval;
  frame: string;
  abcorr?: string;
}

/** Resolve a configured event search into the existing calculation boundary. */
export function resolveEventQuery<P>(
  item: ConfiguredEventQuery<P>,
  context: AnalysisContext,
): EventQuery<P> {
  return {
    ...item.query,
    id: item.id,
    bodies: { ...context.bodies, ...item.query.bodies },
    window: item.query.window ? { ...item.query.window } : { ...context.window },
    abcorr: item.query.abcorr ?? context.reference.abcorr,
  };
}

/** Resolve a profile without pretending its samples are geometry events. */
export function resolveContinuousProfile(
  item: ConfiguredContinuousProfile,
  context: AnalysisContext,
): ResolvedContinuousProfile {
  return {
    ...item.profile,
    bodies: { ...context.bodies, ...item.profile.bodies },
    window: item.profile.window ? { ...item.profile.window } : { ...context.window },
    frame: item.profile.frame ?? context.reference.frame,
    abcorr: item.profile.abcorr ?? context.reference.abcorr,
  };
}
