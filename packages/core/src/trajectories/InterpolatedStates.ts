import type { Vec3 } from '@spicecraft/spice';
import type { CartesianState, Trajectory } from './Trajectory.js';

export interface StateRecord {
  et: number;
  position: Vec3;
  velocity: Vec3;
}

export class InterpolatedStatesTrajectory implements Trajectory {
  private readonly records: StateRecord[];

  constructor(records: StateRecord[]) {
    this.records = [...records].sort((a, b) => a.et - b.et);
    if (this.records.length < 2) throw new Error('InterpolatedStates requires at least 2 records');
  }

  get startTime(): number { return this.records[0].et; }
  get endTime(): number { return this.records[this.records.length - 1].et; }

  stateAt(et: number): CartesianState {
    const { records } = this;

    // Clamp to range
    if (et <= records[0].et) return { position: [...records[0].position] as Vec3, velocity: [...records[0].velocity] as Vec3 };
    if (et >= records[records.length - 1].et) {
      const last = records[records.length - 1];
      return { position: [...last.position] as Vec3, velocity: [...last.velocity] as Vec3 };
    }

    // Binary search for bracket
    let lo = 0, hi = records.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (records[mid].et <= et) lo = mid; else hi = mid;
    }

    const r0 = records[lo];
    const r1 = records[hi];
    const dt = r1.et - r0.et;
    const t = (et - r0.et) / dt;

    // Cubic Hermite interpolation using position + velocity at both endpoints.
    // h00(t) = 2t³ - 3t² + 1, h10(t) = t³ - 2t² + t
    // h01(t) = -2t³ + 3t²,    h11(t) = t³ - t²
    // p(t) = h00*p0 + h10*dt*v0 + h01*p1 + h11*dt*v1
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = (t3 - 2 * t2 + t) * dt;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = (t3 - t2) * dt;

    const position: Vec3 = [
      h00 * r0.position[0] + h10 * r0.velocity[0] + h01 * r1.position[0] + h11 * r1.velocity[0],
      h00 * r0.position[1] + h10 * r0.velocity[1] + h01 * r1.position[1] + h11 * r1.velocity[1],
      h00 * r0.position[2] + h10 * r0.velocity[2] + h01 * r1.position[2] + h11 * r1.velocity[2],
    ];

    // Velocity: derivative of Hermite = h00'*p0 + h10'*dt*v0 + h01'*p1 + h11'*dt*v1, divided by dt
    const dh00 = (6 * t2 - 6 * t) / dt;
    const dh10 = 3 * t2 - 4 * t + 1;
    const dh01 = (-6 * t2 + 6 * t) / dt;
    const dh11 = 3 * t2 - 2 * t;

    const velocity: Vec3 = [
      dh00 * r0.position[0] + dh10 * r0.velocity[0] + dh01 * r1.position[0] + dh11 * r1.velocity[0],
      dh00 * r0.position[1] + dh10 * r0.velocity[1] + dh01 * r1.position[1] + dh11 * r1.velocity[1],
      dh00 * r0.position[2] + dh10 * r0.velocity[2] + dh01 * r1.position[2] + dh11 * r1.velocity[2],
    ];

    return { position, velocity };
  }
}
