import { describe, it, expect } from 'vitest';
import { InterpolatedStatesTrajectory } from '../trajectories/InterpolatedStates.js';

describe('InterpolatedStatesTrajectory', () => {
  const records = [
    { et: 0, position: [100, 0, 0] as [number, number, number], velocity: [0, 10, 0] as [number, number, number] },
    { et: 10, position: [100, 100, 0] as [number, number, number], velocity: [0, 10, 0] as [number, number, number] },
    { et: 20, position: [100, 200, 50] as [number, number, number], velocity: [0, 10, 5] as [number, number, number] },
  ];

  it('returns exact record at sample time', () => {
    const traj = new InterpolatedStatesTrajectory(records);
    const state = traj.stateAt(0);
    expect(state.position).toEqual([100, 0, 0]);
  });

  it('interpolates between samples', () => {
    const traj = new InterpolatedStatesTrajectory(records);
    const state = traj.stateAt(5);
    expect(state.position[0]).toBeCloseTo(100);
    expect(state.position[1]).toBeCloseTo(50);
    expect(state.position[2]).toBeCloseTo(0);
  });

  it('holds a display pose before start but refuses scientific extrapolation', () => {
    const traj = new InterpolatedStatesTrajectory(records);
    expect(traj.stateAt(-10).position.every(Number.isNaN)).toBe(true);
    expect(traj.availabilityAt(-10)).toMatchObject({ available: false, reason: 'before-coverage' });
    const state = traj.displayStateAt(-10);
    expect(state.position).toEqual([100, 0, 0]);
  });

  it('holds a display pose after end but refuses scientific extrapolation', () => {
    const traj = new InterpolatedStatesTrajectory(records);
    expect(traj.stateAt(100).position.every(Number.isNaN)).toBe(true);
    expect(traj.availabilityAt(100)).toMatchObject({ available: false, reason: 'after-coverage' });
    const state = traj.displayStateAt(100);
    expect(state.position).toEqual([100, 200, 50]);
  });

  it('reports time bounds', () => {
    const traj = new InterpolatedStatesTrajectory(records);
    expect(traj.startTime).toBe(0);
    expect(traj.endTime).toBe(20);
  });

  it('throws with fewer than 2 records', () => {
    expect(() => new InterpolatedStatesTrajectory([records[0]])).toThrow();
  });
});
