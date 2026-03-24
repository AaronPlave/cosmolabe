import type { Vec3 } from '@spicecraft/spice';
import type { CartesianState, Trajectory } from './Trajectory.js';
import { twoline2satrec, propagate } from 'satellite.js';
import type { SatRec } from 'satellite.js';

export interface TLEData {
  line1: string;
  line2: string;
}

// J2000 epoch in milliseconds (2000-01-01T12:00:00 UTC)
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/**
 * Trajectory from Two-Line Element set using SGP4/SDP4 propagation via satellite.js.
 *
 * Position/velocity are in TEME frame (km, km/s). TEME is close to J2000
 * for visualization; precise conversion requires SPICE pxform('TEME','J2000',et).
 */
export class TLETrajectory implements Trajectory {
  private readonly satrec: SatRec;
  /** ET of the TLE epoch */
  readonly epochEt: number;
  /** SGP4 is typically valid ±7 days from epoch; we expose ±30 days for visualization */
  readonly startTime: number;
  readonly endTime: number;
  /** Orbital period in seconds, derived from TLE mean motion */
  readonly period: number;

  constructor(tle: TLEData) {
    this.satrec = twoline2satrec(tle.line1, tle.line2);
    // Extract epoch from satrec: jdsatepoch + jdsatepochF give the Julian Date
    const epochJd = (this.satrec as any).jdsatepoch + ((this.satrec as any).jdsatepochF ?? 0);
    // Convert Julian Date to ET: JD 2451545.0 = J2000 epoch (ET=0)
    this.epochEt = (epochJd - 2451545.0) * 86400;
    this.startTime = this.epochEt - 30 * 86400;
    this.endTime = this.epochEt + 30 * 86400;
    // Mean motion (rad/min) → period (seconds)
    const meanMotionRadMin = (this.satrec as any).no; // radians per minute
    this.period = meanMotionRadMin > 0 ? (2 * Math.PI / meanMotionRadMin) * 60 : 86400;
  }

  stateAt(et: number): CartesianState {
    // ET (seconds past J2000) → JavaScript Date
    const date = new Date(J2000_MS + et * 1000);
    const result = propagate(this.satrec, date);

    if (!result || !result.position || typeof result.position === 'boolean') {
      return { position: [0, 0, 0], velocity: [0, 0, 0] };
    }

    const pos = result.position;
    const vel = result.velocity as { x: number; y: number; z: number };

    return {
      position: [pos.x, pos.y, pos.z] as Vec3,
      velocity: [vel.x, vel.y, vel.z] as Vec3,
    };
  }
}
