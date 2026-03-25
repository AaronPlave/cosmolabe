import { describe, it, expect, vi } from 'vitest';
import { Body } from '../Body.js';
import { Universe } from '../Universe.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';
import type { Trajectory, CartesianState } from '../trajectories/Trajectory.js';
import type { RotationModel, Quaternion } from '../rotations/RotationModel.js';

class TrajectoryA implements Trajectory {
  stateAt(): CartesianState { return { position: [1, 2, 3], velocity: [0, 0, 0] }; }
}

class TrajectoryB implements Trajectory {
  stateAt(): CartesianState { return { position: [10, 20, 30], velocity: [0, 0, 0] }; }
}

class RotationA implements RotationModel {
  rotationAt(): Quaternion { return [1, 0, 0, 0]; }
}

class RotationB implements RotationModel {
  rotationAt(): Quaternion { return [0, 1, 0, 0]; }
}

describe('Body mutability', () => {
  it('setTrajectory changes the active trajectory', () => {
    const body = new Body({ name: 'Test', trajectory: new TrajectoryA() });
    expect(body.stateAt(0).position).toEqual([1, 2, 3]);
    body.setTrajectory(new TrajectoryB());
    expect(body.stateAt(0).position).toEqual([10, 20, 30]);
  });

  it('setRotation changes the active rotation', () => {
    const body = new Body({ name: 'Test', trajectory: new TrajectoryA(), rotation: new RotationA() });
    expect(body.rotationAt(0)).toEqual([1, 0, 0, 0]);
    body.setRotation(new RotationB());
    expect(body.rotationAt(0)).toEqual([0, 1, 0, 0]);
  });

  it('onChange callback fires on setTrajectory', () => {
    const body = new Body({ name: 'Test', trajectory: new TrajectoryA() });
    const cb = vi.fn();
    body.onChange = cb;
    body.setTrajectory(new TrajectoryB());
    expect(cb).toHaveBeenCalledWith(body, 'trajectory');
  });

  it('onChange callback fires on setRotation', () => {
    const body = new Body({ name: 'Test', trajectory: new TrajectoryA() });
    const cb = vi.fn();
    body.onChange = cb;
    body.setRotation(new RotationB());
    expect(cb).toHaveBeenCalledWith(body, 'rotation');
  });
});

describe('Universe body change events', () => {
  it('emits body:trajectoryChanged when body trajectory is swapped', () => {
    const universe = new Universe();
    const body = new Body({ name: 'SC', trajectory: new TrajectoryA() });
    universe.addBody(body);
    const handler = vi.fn();
    universe.events.on('body:trajectoryChanged', handler);
    body.setTrajectory(new TrajectoryB());
    expect(handler).toHaveBeenCalledWith({ body });
  });

  it('emits body:rotationChanged when body rotation is swapped', () => {
    const universe = new Universe();
    const body = new Body({ name: 'SC', trajectory: new TrajectoryA(), rotation: new RotationA() });
    universe.addBody(body);
    const handler = vi.fn();
    universe.events.on('body:rotationChanged', handler);
    body.setRotation(new RotationB());
    expect(handler).toHaveBeenCalledWith({ body });
  });

  it('wires onChange for bodies loaded via loadCatalog', () => {
    const universe = new Universe();
    universe.loadCatalog({
      items: [{ name: 'TestBody', center: 'Sun', trajectory: { type: 'FixedPoint', position: [1, 1, 1] } }],
    });
    const body = universe.getBody('TestBody')!;
    const handler = vi.fn();
    universe.events.on('body:trajectoryChanged', handler);
    body.setTrajectory(new TrajectoryB());
    expect(handler).toHaveBeenCalled();
  });
});
