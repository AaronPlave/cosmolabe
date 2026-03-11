import { describe, it, expect } from 'vitest';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';

describe('FixedPointTrajectory', () => {
  it('returns the fixed position at any time', () => {
    const traj = new FixedPointTrajectory([100, 200, 300]);
    expect(traj.stateAt(0).position).toEqual([100, 200, 300]);
    expect(traj.stateAt(999999).position).toEqual([100, 200, 300]);
  });

  it('always returns zero velocity', () => {
    const traj = new FixedPointTrajectory([100, 200, 300]);
    expect(traj.stateAt(0).velocity).toEqual([0, 0, 0]);
  });
});
