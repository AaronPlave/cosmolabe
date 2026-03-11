import type { Vec3 } from '@spicecraft/spice';
import type { CartesianState, Trajectory } from './Trajectory.js';

export interface KeplerianElements {
  semiMajorAxis: number;  // km
  eccentricity: number;
  inclination: number;    // radians
  raan: number;           // radians (right ascension of ascending node)
  argPeriapsis: number;   // radians
  meanAnomalyAtEpoch: number; // radians
  epoch: number;          // ET seconds
  mu: number;             // km^3/s^2
}

export class KeplerianTrajectory implements Trajectory {
  readonly period: number;

  constructor(private readonly elements: KeplerianElements) {
    const { semiMajorAxis: a, mu } = elements;
    this.period = (a > 0 && mu > 0) ? 2 * Math.PI * Math.sqrt(a * a * a / mu) : 0;
  }

  stateAt(et: number): CartesianState {
    const { semiMajorAxis: a, eccentricity: e, inclination: i, raan: Omega, argPeriapsis: omega, meanAnomalyAtEpoch: M0, epoch: t0, mu } = this.elements;

    // Guard: can't propagate without mu or semi-major axis
    if (mu <= 0 || a <= 0) {
      return { position: [0, 0, 0], velocity: [0, 0, 0] };
    }

    // Mean motion
    const n = Math.sqrt(mu / (a * a * a));

    // Mean anomaly at time t
    let M = M0 + n * (et - t0);
    // Normalize to [0, 2pi)
    M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    // Solve Kepler's equation: M = E - e*sin(E) via Newton-Raphson
    let E = M;
    for (let iter = 0; iter < 30; iter++) {
      const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-12) break;
    }

    // True anomaly
    const cosE = Math.cos(E);
    const sinE = Math.sin(E);
    const nu = Math.atan2(Math.sqrt(1 - e * e) * sinE, cosE - e);

    // Distance
    const r = a * (1 - e * cosE);

    // Position and velocity in perifocal frame
    const cosNu = Math.cos(nu);
    const sinNu = Math.sin(nu);
    const p = a * (1 - e * e); // semi-latus rectum

    const pqw_pos: Vec3 = [r * cosNu, r * sinNu, 0];
    const sqrtMuOverP = Math.sqrt(mu / p);
    const pqw_vel: Vec3 = [-sqrtMuOverP * sinNu, sqrtMuOverP * (e + cosNu), 0];

    // Rotation matrix from perifocal to inertial (3-1-3 rotation: -omega, -i, -Omega)
    const cosO = Math.cos(Omega);
    const sinO = Math.sin(Omega);
    const cosI = Math.cos(i);
    const sinI = Math.sin(i);
    const cosW = Math.cos(omega);
    const sinW = Math.sin(omega);

    // Combined rotation matrix elements
    const r11 = cosO * cosW - sinO * sinW * cosI;
    const r12 = -cosO * sinW - sinO * cosW * cosI;
    const r21 = sinO * cosW + cosO * sinW * cosI;
    const r22 = -sinO * sinW + cosO * cosW * cosI;
    const r31 = sinW * sinI;
    const r32 = cosW * sinI;

    const position: Vec3 = [
      r11 * pqw_pos[0] + r12 * pqw_pos[1],
      r21 * pqw_pos[0] + r22 * pqw_pos[1],
      r31 * pqw_pos[0] + r32 * pqw_pos[1],
    ];

    const velocity: Vec3 = [
      r11 * pqw_vel[0] + r12 * pqw_vel[1],
      r21 * pqw_vel[0] + r22 * pqw_vel[1],
      r31 * pqw_vel[0] + r32 * pqw_vel[1],
    ];

    return { position, velocity };
  }
}
