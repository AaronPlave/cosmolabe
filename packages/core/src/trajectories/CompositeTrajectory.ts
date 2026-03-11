import type { CartesianState, Trajectory } from './Trajectory.js';

export interface TrajectoryArc {
  trajectory: Trajectory;
  startTime: number;
  endTime: number;
  /** Center body name for this arc (positions are relative to this body) */
  centerName?: string;
}

export class CompositeTrajectory implements Trajectory {
  constructor(readonly arcs: readonly TrajectoryArc[]) {
    if (arcs.length === 0) throw new Error('CompositeTrajectory requires at least one arc');
  }

  get startTime(): number { return this.arcs[0].startTime; }
  get endTime(): number { return this.arcs[this.arcs.length - 1].endTime; }

  stateAt(et: number): CartesianState {
    return this.arcAt(et).trajectory.stateAt(et);
  }

  /** Return the active arc for a given time */
  arcAt(et: number): TrajectoryArc {
    for (const arc of this.arcs) {
      if (et >= arc.startTime && et <= arc.endTime) {
        return arc;
      }
    }
    if (et < this.arcs[0].startTime) return this.arcs[0];
    return this.arcs[this.arcs.length - 1];
  }
}
