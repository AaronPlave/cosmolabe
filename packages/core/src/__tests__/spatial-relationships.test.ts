import { describe, expect, it } from 'vitest';
import { Body, FixedPointTrajectory, FixedRotation, Universe, resolveSpatialEndpoint, resolveSpatialRelationship, formatSpatialDistance } from '../index.js';

describe('spatial relationships', () => {
  it('resolves entity endpoints through the absolute parent chain', () => {
    const universe = new Universe();
    universe.addBody(new Body({ name: 'Earth', trajectory: new FixedPointTrajectory([100, 0, 0]) }));
    universe.addBody(new Body({ name: 'Probe', parentName: 'Earth', trajectory: new FixedPointTrajectory([0, 20, 0]) }));
    expect(resolveSpatialEndpoint(universe, { kind: 'entity', bodyName: 'Probe' }, 0)).toEqual([100, 20, 0]);
  });

  it('computes Euclidean distance and a three-endpoint angle', () => {
    const universe = new Universe();
    for (const [name, position] of [['A', [1, 0, 0]], ['V', [0, 0, 0]], ['B', [0, 1, 0]]] as const) {
      universe.addBody(new Body({ name, trajectory: new FixedPointTrajectory([...position]) }));
    }
    const distance = resolveSpatialRelationship(universe, {
      id: 'd', kind: 'distance', source: { kind: 'entity', bodyName: 'A' }, target: { kind: 'entity', bodyName: 'B' },
    }, 0);
    expect(distance?.distanceKm).toBeCloseTo(Math.SQRT2);
    const angle = resolveSpatialRelationship(universe, {
      id: 'a', kind: 'angle', source: { kind: 'entity', bodyName: 'A' }, vertex: { kind: 'entity', bodyName: 'V' }, target: { kind: 'entity', bodyName: 'B' },
    }, 0);
    expect(angle?.angleDeg).toBeCloseTo(90);
  });

  it('uses engineering units', () => {
    expect(formatSpatialDistance(0.25)).toBe('250 m');
    expect(formatSpatialDistance(149_597_870.7)).toBe('1.000 AU');
  });

  it('rotates exact body-fixed points into the world frame', () => {
    const universe = new Universe();
    universe.addBody(new Body({
      name: 'Body', trajectory: new FixedPointTrajectory([10, 0, 0]),
      rotation: new FixedRotation([Math.SQRT1_2, 0, 0, -Math.SQRT1_2], 'ECLIPJ2000'),
    }));
    const point = resolveSpatialEndpoint(universe, { kind: 'body-fixed', bodyName: 'Body', positionKm: [1, 0, 0] }, 0);
    expect(point?.[0]).toBeCloseTo(10);
    expect(point?.[1]).toBeCloseTo(1);
  });

  it('rejects unavailable ephemerides, frames, and attitudes', () => {
    const universe = new Universe();
    universe.addBody(new Body({ name: 'Bad', trajectory: new FixedPointTrajectory([NaN, 0, 0]) }));
    universe.addBody(new Body({ name: 'No attitude', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    expect(resolveSpatialEndpoint(universe, { kind: 'entity', bodyName: 'Bad' }, 0)).toBeNull();
    expect(resolveSpatialEndpoint(universe, { kind: 'coordinate', frame: 'NOT_A_FRAME', positionKm: [1, 2, 3] }, 0)).toBeNull();
    expect(resolveSpatialEndpoint(universe, { kind: 'body-fixed', bodyName: 'No attitude', positionKm: [1, 0, 0] }, 0)).toBeNull();
  });

  it('transforms coordinates and body-fixed attitudes from a non-world source frame', () => {
    const universe = new Universe();
    universe.addBody(new Body({
      name: 'Equatorial', trajectory: new FixedPointTrajectory([0, 0, 0]),
      rotation: new FixedRotation([1, 0, 0, 0], 'EquatorJ2000'),
    }));
    const coordinate = resolveSpatialEndpoint(universe, { kind: 'coordinate', frame: 'EquatorJ2000', positionKm: [0, 1, 0] }, 0);
    const surface = resolveSpatialEndpoint(universe, { kind: 'body-fixed', bodyName: 'Equatorial', positionKm: [0, 1, 0] }, 0);
    expect(coordinate?.[1]).toBeCloseTo(0.917482, 5);
    expect(coordinate?.[2]).toBeCloseTo(-0.397777, 5);
    surface?.forEach((value, index) => expect(value).toBeCloseTo(coordinate![index]));
  });

  it('returns unavailable when ephemeris or rotation coverage throws', () => {
    const universe = new Universe();
    universe.addBody(new Body({
      name: 'Missing attitude', trajectory: new FixedPointTrajectory([0, 0, 0]),
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => { throw new Error('No coverage'); } },
    }));
    universe.addBody(new Body({
      name: 'Missing position', trajectory: { stateAt: () => { throw new Error('No coverage'); } },
    }));
    expect(resolveSpatialEndpoint(universe, { kind: 'body-fixed', bodyName: 'Missing attitude', positionKm: [1, 0, 0] }, 0)).toBeNull();
    expect(resolveSpatialEndpoint(universe, { kind: 'entity', bodyName: 'Missing position' }, 0)).toBeNull();
  });

  it('reports a coincident angle leg as undefined', () => {
    const universe = new Universe();
    universe.addBody(new Body({ name: 'V', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    universe.addBody(new Body({ name: 'B', trajectory: new FixedPointTrajectory([0, 1, 0]) }));
    const angle = resolveSpatialRelationship(universe, {
      id: 'degenerate', kind: 'angle',
      source: { kind: 'entity', bodyName: 'V' }, vertex: { kind: 'entity', bodyName: 'V' }, target: { kind: 'entity', bodyName: 'B' },
    }, 0);
    expect(angle?.angleDeg).toBeUndefined();
  });
});
