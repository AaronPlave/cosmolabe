import type { Vec3 } from '@spicecraft/spice';
import type { CartesianState, Trajectory } from './Trajectory.js';

export class FixedPointTrajectory implements Trajectory {
  constructor(private readonly position: Vec3) {}

  stateAt(_et: number): CartesianState {
    return {
      position: [...this.position] as Vec3,
      velocity: [0, 0, 0],
    };
  }
}
