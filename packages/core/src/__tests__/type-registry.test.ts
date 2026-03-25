import { describe, it, expect, vi } from 'vitest';
import { Universe } from '../Universe.js';
import { CatalogLoader } from '../catalog/CatalogLoader.js';
import type { CatalogJson, TrajectoryFactory, RotationFactory } from '../catalog/CatalogLoader.js';
import type { Trajectory, CartesianState } from '../trajectories/Trajectory.js';
import type { RotationModel, Quaternion } from '../rotations/RotationModel.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';

class CustomTrajectory implements Trajectory {
  stateAt(et: number): CartesianState {
    return { position: [100, 200, 300], velocity: [0, 0, 0] };
  }
}

class CustomRotation implements RotationModel {
  rotationAt(et: number): Quaternion {
    return [1, 0, 0, 0];
  }
}

describe('Type Registry', () => {
  it('custom trajectory factory is used for registered type', () => {
    const factory: TrajectoryFactory = vi.fn(() => new CustomTrajectory());
    const loader = new CatalogLoader({
      trajectoryFactories: { 'MyCustom': factory },
    });
    const catalog: CatalogJson = {
      items: [{ name: 'TestBody', center: 'Sun', trajectory: { type: 'MyCustom' } }],
    };
    const result = loader.load(catalog);
    expect(factory).toHaveBeenCalled();
    const body = result.bodies.find(b => b.name === 'TestBody');
    expect(body).toBeDefined();
    const state = body!.stateAt(0);
    expect(state.position).toEqual([100, 200, 300]);
  });

  it('custom factory can override built-in types', () => {
    const factory: TrajectoryFactory = () => new CustomTrajectory();
    const loader = new CatalogLoader({
      trajectoryFactories: { 'FixedPoint': factory },
    });
    const catalog: CatalogJson = {
      items: [{ name: 'TestBody', center: 'Sun', trajectory: { type: 'FixedPoint', position: [1, 2, 3] } }],
    };
    const result = loader.load(catalog);
    const body = result.bodies.find(b => b.name === 'TestBody');
    // Custom factory returns [100,200,300] instead of the catalog's [1,2,3]
    expect(body!.stateAt(0).position).toEqual([100, 200, 300]);
  });

  it('factory returning undefined falls through to built-in', () => {
    const factory: TrajectoryFactory = () => undefined;
    const loader = new CatalogLoader({
      trajectoryFactories: { 'FixedPoint': factory },
    });
    const catalog: CatalogJson = {
      items: [{ name: 'TestBody', center: 'Sun', trajectory: { type: 'FixedPoint', position: [5, 6, 7] } }],
    };
    const result = loader.load(catalog);
    const body = result.bodies.find(b => b.name === 'TestBody');
    expect(body!.stateAt(0).position).toEqual([5, 6, 7]);
  });

  it('unknown type with no factory returns FixedPoint default', () => {
    const loader = new CatalogLoader({});
    const catalog: CatalogJson = {
      items: [{ name: 'TestBody', center: 'Sun', trajectory: { type: 'NoSuchType' } }],
    };
    const result = loader.load(catalog);
    const body = result.bodies.find(b => b.name === 'TestBody');
    expect(body!.stateAt(0).position).toEqual([0, 0, 0]);
  });

  it('custom rotation factory is used for registered type', () => {
    const factory: RotationFactory = vi.fn(() => new CustomRotation());
    const loader = new CatalogLoader({
      rotationFactories: { 'MyRotation': factory },
    });
    const catalog: CatalogJson = {
      items: [{ name: 'TestBody', center: 'Sun', trajectory: { type: 'FixedPoint' }, rotationModel: { type: 'MyRotation' } }],
    };
    const result = loader.load(catalog);
    expect(factory).toHaveBeenCalled();
    const body = result.bodies.find(b => b.name === 'TestBody');
    expect(body!.rotationAt(0)).toEqual([1, 0, 0, 0]);
  });

  it('factories are threaded through Universe options', () => {
    const factory: TrajectoryFactory = () => new CustomTrajectory();
    const universe = new Universe(undefined, {
      trajectoryFactories: { 'MyCustom': factory },
    });
    universe.loadCatalog({
      items: [{ name: 'TestBody', center: 'Sun', trajectory: { type: 'MyCustom' } }],
    });
    const body = universe.getBody('TestBody');
    expect(body).toBeDefined();
    expect(body!.stateAt(0).position).toEqual([100, 200, 300]);
  });
});
