import type { Vec3 } from '../spice-injection.js';

export interface CartesianState {
  position: Vec3;
  velocity: Vec3;
}

export interface Trajectory {
  stateAt(et: number): CartesianState;
  readonly startTime?: number;
  readonly endTime?: number;
  /**
   * Orbital period in seconds, if periodic. MUST be set for periodic
   * trajectories — the renderer's trajectory cache uses it to bound its
   * sampling range to one orbit. Caching multi-period closed loops causes
   * Visvalingam simplification to drop entire orbital regions, leaving
   * trails that look stubby or empty in some time windows.
   */
  readonly period?: number;
  /**
   * The frame `stateAt` positions and velocities are expressed in, by name
   * (`TEME`, `J2000`, `ECLIPJ2000`, `IAU_MARS`, `BODY_FIXED`, …), when the
   * trajectory knows it intrinsically — SGP4 output is TEME whatever a catalog
   * says. Resolved through `FrameRegistry`. Undefined when the frame is a
   * property of the data rather than the class (Keplerian elements, `.xyzv`
   * samples); the catalog's `trajectoryFrame` supplies it then.
   */
  readonly frame?: string;
}
