import type { DataProvenance } from './plugins/PluginData.js';

/**
 * Why state cannot be evaluated at an epoch (#43's structured-fault direction).
 *
 * Kept to the distinctions a person or host acts on differently: data that is
 * still being fetched, data that does not exist there, a feed that went quiet,
 * and a configuration that cannot be honoured. Never "use the last value".
 */
export type UnavailableReason =
  /** Inside what the source can serve, not loaded yet (requested or queued). */
  | 'pending'
  | 'before-coverage'
  | 'after-coverage'
  /** Inside a loaded window, with no samples close enough to interpolate. */
  | 'gap'
  /** After the last sample of a live feed that reported disconnection. */
  | 'disconnected'
  /** After the last sample of a connected live feed that has stopped updating. */
  | 'stale'
  /** The body names a source the host has not supplied. */
  | 'unbound'
  /** The source was rejected (frame, centre, convention) or a request failed. */
  | 'error'
  /** This body's own state is fine; something it is placed relative to is not. */
  | 'dependency';

/** An inclusive ET interval, seconds past J2000 TDB. */
export interface CoverageInterval { readonly start: number; readonly end: number }

/**
 * Whether a state product can be evaluated at one epoch, and why not.
 *
 * Shared by every consumer — renderer, inspector, trails, sensors, host reads —
 * so they agree: a model that reports unavailable also returns NaN from
 * `stateAt` or throws {@link StateUnavailableError} from `rotationAt`.
 */
export interface StateAvailability {
  readonly available: boolean;
  readonly reason?: UnavailableReason;
  readonly message?: string;
  readonly sourceId?: string;
  /** Evaluable intervals nearest the epoch, ET. */
  readonly coverage?: readonly CoverageInterval[];
  /** The classification of the supplying product (#179): `planned` is predicted. */
  readonly classification?: DataProvenance['classification'];
  readonly authority?: 'host' | 'exploratory';
  readonly provenance?: DataProvenance;
}

/**
 * Thrown by a `RotationModel` that has no attitude at the requested epoch.
 *
 * Throwing is the existing convention for unavailable attitude (SPICE `pxform`
 * throws outside CK coverage); this subclass carries the reason, so a consumer
 * can hide or flag the orientation rather than hold the last good one.
 */
export class StateUnavailableError extends Error {
  constructor(readonly availability: StateAvailability) {
    super(availability.message ?? `State unavailable (${availability.reason ?? 'unknown'})`);
    this.name = 'StateUnavailableError';
  }
}
