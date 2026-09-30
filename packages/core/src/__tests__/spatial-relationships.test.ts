import { describe, expect, it } from 'vitest';
import { Body, FixedPointTrajectory, Universe, resolveSpatialEndpoint, resolveSpatialRelationship, formatSpatialDistance } from '../index.js';

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
      universe.addBody(new Body({ name, trajectory: new FixedPointTrajectory(position) }));
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
});
