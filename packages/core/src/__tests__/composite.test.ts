import { describe, it, expect } from 'vitest';
import { CompositeTrajectory } from '../trajectories/CompositeTrajectory.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';

describe('CompositeTrajectory', () => {
  it('delegates to correct arc based on time', () => {
    const arc1 = new FixedPointTrajectory([100, 0, 0]);
    const arc2 = new FixedPointTrajectory([200, 0, 0]);

    const composite = new CompositeTrajectory([
      { trajectory: arc1, startTime: 0, endTime: 10 },
      { trajectory: arc2, startTime: 10, endTime: 20 },
    ]);

    expect(composite.stateAt(5).position[0]).toBe(100);
    expect(composite.stateAt(15).position[0]).toBe(200);
  });

  it('falls back to nearest arc for out-of-range times', () => {
    const arc1 = new FixedPointTrajectory([100, 0, 0]);
    const composite = new CompositeTrajectory([
      { trajectory: arc1, startTime: 10, endTime: 20 },
    ]);

    expect(composite.stateAt(0).position[0]).toBe(100);
    expect(composite.stateAt(100).position[0]).toBe(100);
  });

  it('throws with empty arcs', () => {
    expect(() => new CompositeTrajectory([])).toThrow();
  });
});
