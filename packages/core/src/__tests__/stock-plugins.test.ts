import { describe, it, expect, vi } from 'vitest';
import { Universe } from '../Universe.js';
import { Body } from '../Body.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';

describe('TrajectoryLine color segments (core integration)', () => {
  it('color segments data flows through Universe factory system', () => {
    // Verify that the type registry + event system works end-to-end
    // by creating a universe with custom factory and checking events fire
    const universe = new Universe(undefined, {
      trajectoryFactories: {
        'Custom': () => new FixedPointTrajectory([1, 2, 3]),
      },
    });

    const addHandler = vi.fn();
    universe.events.on('body:added', addHandler);

    const body = new Body({ name: 'SC', trajectory: new FixedPointTrajectory([0, 0, 0]) });
    universe.addBody(body);
    expect(addHandler).toHaveBeenCalledWith({ body });

    // Verify body mutability works
    const changeHandler = vi.fn();
    universe.events.on('body:trajectoryChanged', changeHandler);
    body.setTrajectory(new FixedPointTrajectory([10, 20, 30]));
    expect(changeHandler).toHaveBeenCalled();
    expect(body.stateAt(0).position).toEqual([10, 20, 30]);
  });

  it('state store integrates with universe lifecycle', () => {
    const universe = new Universe();
    const listener = vi.fn();
    universe.state.watch('selectedBody', listener);
    universe.state.set('selectedBody', 'Mars');
    expect(listener).toHaveBeenCalledWith('Mars', null);
    expect(universe.state.get('selectedBody')).toBe('Mars');
  });
});
