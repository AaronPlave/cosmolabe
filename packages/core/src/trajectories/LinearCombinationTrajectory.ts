import type { Trajectory, CartesianState } from './Trajectory.js';
import type { Vec3 } from '@cosmolabe/spice';

/**
 * Weighted linear combination of two trajectories.
 * state(t) = w0 * traj0(t) + w1 * traj1(t)
 *
 * Used by Cosmographia to compute center-relative positions:
 * e.g. Enceladus relative to Saturn = 1.0 * enceladus.cheb + (-1.0) * saturn.cheb
 */
export class LinearCombinationTrajectory implements Trajectory {
  private readonly traj0: Trajectory;
  private readonly traj1: Trajectory;
  private readonly w0: number;
  private readonly w1: number;
  private _period?: number;

  get startTime(): number | undefined {
    const s0 = this.traj0.startTime;
    const s1 = this.traj1.startTime;
    if (s0 != null && s1 != null) return Math.max(s0, s1);
    return s0 ?? s1;
  }

  get endTime(): number | undefined {
    const e0 = this.traj0.endTime;
    const e1 = this.traj1.endTime;
    if (e0 != null && e1 != null) return Math.min(e0, e1);
    return e0 ?? e1;
  }

  get period(): number | undefined { return this._period; }

  constructor(traj0: Trajectory, w0: number, traj1: Trajectory, w1: number) {
    this.traj0 = traj0;
    this.w0 = w0;
    this.traj1 = traj1;
    this.w1 = w1;
  }

  setPeriod(p: number): void {
    this._period = p;
  }

  stateAt(et: number): CartesianState {
    const s0 = this.traj0.stateAt(et);
    const s1 = this.traj1.stateAt(et);

    const position: Vec3 = [
      this.w0 * s0.position[0] + this.w1 * s1.position[0],
      this.w0 * s0.position[1] + this.w1 * s1.position[1],
      this.w0 * s0.position[2] + this.w1 * s1.position[2],
    ];
    const velocity: Vec3 = [
      this.w0 * s0.velocity[0] + this.w1 * s1.velocity[0],
      this.w0 * s0.velocity[1] + this.w1 * s1.velocity[1],
      this.w0 * s0.velocity[2] + this.w1 * s1.velocity[2],
    ];

    return { position, velocity };
  }
}
