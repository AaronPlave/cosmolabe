import type { Vec3 } from '../spice-injection.js';
import type { CartesianState, Trajectory } from './Trajectory.js';

export class FixedPointTrajectory implements Trajectory {
  /** Set for points stated in a particular frame — `BODY_FIXED` for a
   *  catalog `FixedSpherical` surface point. */
  readonly frame?: string;

  constructor(private readonly position: Vec3, options: { frame?: string } = {}) {
    this.frame = options.frame;
  }

  stateAt(_et: number): CartesianState {
    return {
      position: [...this.position] as Vec3,
      velocity: [0, 0, 0],
    };
  }
}
