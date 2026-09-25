import type { CartesianState, Trajectory } from './Trajectory.js';
import type { TrajectoryPlotConfig } from '../Body.js';

export interface TrajectoryArc {
  trajectory: Trajectory;
  startTime: number;
  endTime: number;
  /** Center body name for this arc (positions are relative to this body) */
  centerName?: string;
  /** Frame this arc's states are expressed in (a `FrameRegistry` name). Falls
   *  back to the arc trajectory's own `frame`, then the body's. */
  frame?: string;
  /** Suppress the trajectory line for this arc while still using its
   *  samples for body positioning. Useful for landed / surface-locked
   *  arcs where the inertial-frame samples trace a body-rotation circle
   *  even though the spacecraft is stationary in the body-fixed frame —
   *  drawing that circle visually contradicts the "this thing is parked"
   *  story. Default true (line is drawn). */
  showLine?: boolean;
  /** Override the default sample count for the trajectory line. Useful
   *  for long-duration cruise arcs where the auto-derived count
   *  (clamped to 500) produces a faceted polygon at high eccentricity. */
  numKeySamples?: number;
  /** This arc's trail settings, overriding the body's `trajectoryPlot` field
   *  by field (a long trail for a cruise arc, a short one for an orbit phase). */
  plot?: TrajectoryPlotConfig;
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
