import type { Vec3 } from '@cosmolabe/spice';

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
}
