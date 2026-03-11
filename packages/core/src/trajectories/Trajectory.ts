import type { Vec3 } from '@spicecraft/spice';

export interface CartesianState {
  position: Vec3;
  velocity: Vec3;
}

export interface Trajectory {
  stateAt(et: number): CartesianState;
  readonly startTime?: number;
  readonly endTime?: number;
  /** Orbital period in seconds, if periodic */
  readonly period?: number;
}
