import type { SpiceInstance, Vec3 } from '@spicecraft/spice';
import type { CartesianState, Trajectory } from './Trajectory.js';

export class SpiceTrajectory implements Trajectory {
  private errorLogged = false;

  /** True if SPICE calls have failed for this trajectory */
  get failed(): boolean { return this.errorLogged; }

  constructor(
    private readonly spice: SpiceInstance,
    private readonly target: string,
    private readonly center: string,
    private readonly frame: string,
  ) {}

  stateAt(et: number): CartesianState {
    try {
      const result = this.spice.spkezr(this.target, et, this.frame, 'NONE', this.center);
      return {
        position: [result.state[0], result.state[1], result.state[2]] as Vec3,
        velocity: [result.state[3], result.state[4], result.state[5]] as Vec3,
      };
    } catch (e) {
      if (!this.errorLogged) {
        console.warn(`SPICE trajectory failed for ${this.target}: ${e instanceof Error ? e.message : e}`);
        this.errorLogged = true;
      }
      return { position: [NaN, NaN, NaN], velocity: [NaN, NaN, NaN] };
    }
  }
}
