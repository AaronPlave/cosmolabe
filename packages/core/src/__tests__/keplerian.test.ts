import { describe, it, expect } from 'vitest';
import { KeplerianTrajectory } from '../trajectories/Keplerian.js';

describe('KeplerianTrajectory', () => {
  const MU_EARTH = 398600.4418;

  it('returns correct position for circular orbit at epoch', () => {
    const traj = new KeplerianTrajectory({
      semiMajorAxis: 7000,
      eccentricity: 0,
      inclination: 0,
      raan: 0,
      argPeriapsis: 0,
      meanAnomalyAtEpoch: 0,
      epoch: 0,
      mu: MU_EARTH,
    });

    const state = traj.stateAt(0);
    expect(state.position[0]).toBeCloseTo(7000, 1);
    expect(state.position[1]).toBeCloseTo(0, 1);
    expect(state.position[2]).toBeCloseTo(0, 1);

    // Circular velocity = sqrt(mu/a) ≈ 7.546 km/s
    const vCirc = Math.sqrt(MU_EARTH / 7000);
    expect(state.velocity[0]).toBeCloseTo(0, 1);
    expect(state.velocity[1]).toBeCloseTo(vCirc, 2);
    expect(state.velocity[2]).toBeCloseTo(0, 1);
  });

  it('returns opposite position after half period', () => {
    const a = 7000;
    const traj = new KeplerianTrajectory({
      semiMajorAxis: a,
      eccentricity: 0,
      inclination: 0,
      raan: 0,
      argPeriapsis: 0,
      meanAnomalyAtEpoch: 0,
      epoch: 0,
      mu: MU_EARTH,
    });

    const period = 2 * Math.PI * Math.sqrt(a ** 3 / MU_EARTH);
    const state = traj.stateAt(period / 2);
    expect(state.position[0]).toBeCloseTo(-7000, 0);
    expect(state.position[1]).toBeCloseTo(0, 0);
  });

  it('returns to start after full period', () => {
    const a = 7000;
    const traj = new KeplerianTrajectory({
      semiMajorAxis: a,
      eccentricity: 0.1,
      inclination: 0,
      raan: 0,
      argPeriapsis: 0,
      meanAnomalyAtEpoch: 0,
      epoch: 0,
      mu: MU_EARTH,
    });

    const period = 2 * Math.PI * Math.sqrt(a ** 3 / MU_EARTH);
    const s0 = traj.stateAt(0);
    const s1 = traj.stateAt(period);
    expect(s1.position[0]).toBeCloseTo(s0.position[0], 3);
    expect(s1.position[1]).toBeCloseTo(s0.position[1], 3);
    expect(s1.position[2]).toBeCloseTo(s0.position[2], 3);
  });

  it('respects eccentricity — periapsis distance is a*(1-e)', () => {
    const a = 10000;
    const e = 0.5;
    const traj = new KeplerianTrajectory({
      semiMajorAxis: a,
      eccentricity: e,
      inclination: 0,
      raan: 0,
      argPeriapsis: 0,
      meanAnomalyAtEpoch: 0,  // At periapsis
      epoch: 0,
      mu: MU_EARTH,
    });

    const state = traj.stateAt(0);
    const dist = Math.sqrt(state.position[0] ** 2 + state.position[1] ** 2 + state.position[2] ** 2);
    expect(dist).toBeCloseTo(a * (1 - e), 1); // 5000 km
  });

  it('handles inclined orbit', () => {
    const traj = new KeplerianTrajectory({
      semiMajorAxis: 7000,
      eccentricity: 0,
      inclination: Math.PI / 6, // 30 degrees
      raan: 0,
      argPeriapsis: 0,
      meanAnomalyAtEpoch: Math.PI / 2, // 90 degrees — should have Z component
      epoch: 0,
      mu: MU_EARTH,
    });

    const state = traj.stateAt(0);
    // At 90° true anomaly in a 30° inclined orbit, Z should be nonzero
    expect(Math.abs(state.position[2])).toBeGreaterThan(100);
  });
});
