import { describe, expect, it } from 'vitest';
import { Body, FixedPointTrajectory, FixedRotation, Universe, resolveSpatialEndpoint, resolveSpatialRelationship, formatSpatialDistance, formatSpatialSpeed, resolveFrameAxes, resolveVelocity, referenceRelationship, relationshipVectors, referenceVectorLabel, rotateVecByQuat } from '../index.js';

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

describe('reference geometry', () => {
  const moving = (position: (et: number) => [number, number, number]) => ({ stateAt: (et: number) => ({ position: position(et), velocity: [0, 0, 0] as [number, number, number] }) });
  const spinning = (radPerS: number) => ({
    sourceFrame: 'ECLIPJ2000',
    // Source → body-fixed by −θ about Z, so a body-fixed point turns by +θ in the world.
    rotationAt: (et: number) => [Math.cos(-radPerS * et / 2), 0, 0, Math.sin(-radPerS * et / 2)] as [number, number, number, number],
  });
  function scene() {
    const universe = new Universe();
    universe.addBody(new Body({ name: 'Sun', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    universe.addBody(new Body({ name: 'Earth', parentName: 'Sun', trajectory: moving(et => [1000, 30 * et, 0]), rotation: spinning(0.001) }));
    universe.addBody(new Body({ name: 'Probe', parentName: 'Earth', trajectory: moving(et => [7000, 0, 7.5 * et]) }));
    return universe;
  }

  it('measures velocity relative to the central body by default, or to a named reference', () => {
    const universe = scene();
    const local = resolveSpatialRelationship(universe, { id: 'v', kind: 'velocity', object: { kind: 'entity', bodyName: 'Probe' } }, 10);
    expect(local?.center).toEqual({ kind: 'entity', bodyName: 'Earth' });
    expect(local?.origin).toEqual([8000, 300, 75]);
    local?.velocityKmS.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 7.5][i], 9));
    expect(local?.speedKmS).toBeCloseTo(7.5);
    expect(local?.direction).toEqual([0, 0, 1]);
    const heliocentric = resolveSpatialRelationship(universe, { id: 'v', kind: 'velocity', object: { kind: 'entity', bodyName: 'Probe' }, relativeTo: { kind: 'entity', bodyName: 'Sun' } }, 10);
    heliocentric?.velocityKmS.forEach((v, i) => expect(v).toBeCloseTo([0, 30, 7.5][i], 9));
  });

  it('gives a surface point its inertial velocity, including the rotation of its body', () => {
    const universe = scene();
    const surface = resolveVelocity(universe, { kind: 'body-fixed', bodyName: 'Earth', positionKm: [6000, 0, 0] }, undefined, 0);
    expect(surface?.center).toEqual({ kind: 'entity', bodyName: 'Earth' });
    surface?.velocityKmS.forEach((v, i) => expect(v).toBeCloseTo([0, 6, 0][i], 5)); // ω × r
  });

  it('reports a velocity relative to itself as directionless rather than inventing one', () => {
    const resolved = resolveSpatialRelationship(scene(), { id: 'v', kind: 'velocity', object: { kind: 'entity', bodyName: 'Probe' }, relativeTo: { kind: 'entity', bodyName: 'Probe' } }, 0);
    expect(resolved?.speedKmS).toBe(0);
    expect(resolved?.direction).toBeNull();
  });

  it('draws any registry frame, including an inertial frame other than the scene frame', () => {
    const axes = resolveFrameAxes(new Universe(), 'EquatorJ2000', 0)!;
    expect(axes[0]).toEqual([1, 0, 0]);
    axes[2].forEach((v, i) => expect(v).toBeCloseTo([0, 0.397777, 0.917482][i], 5));
    expect(resolveFrameAxes(new Universe(), 'NOT_A_FRAME', 0)).toBeNull();
    expect(resolveSpatialRelationship(new Universe(), { id: 'a', kind: 'axes', frame: 'NOT_A_FRAME', origin: { kind: 'coordinate', positionKm: [0, 0, 0] } }, 0)).toBeNull();
  });

  it('resolves body axes through the same composition the body mesh uses', () => {
    const universe = new Universe();
    const q: [number, number, number, number] = [0.8, 0.2, -0.4, 0.4];
    const n = Math.hypot(...q);
    universe.addBody(new Body({ name: 'Ceres', trajectory: new FixedPointTrajectory([5, 6, 7]), rotation: new FixedRotation(q.map(v => v / n) as typeof q, 'EquatorJ2000') }));
    const resolved = resolveSpatialRelationship(universe, referenceRelationship({ kind: 'bodyAxes', object: 'Ceres' }, 'axes'), 0);
    expect(resolved?.kind).toBe('axes');
    if (resolved?.kind !== 'axes') return;
    expect(resolved.relationship.frame).toBe('IAU_CERES');
    expect(resolved.origin).toEqual([5, 6, 7]);
    const bodyToWorld = universe.bodyToWorldQuat('Ceres', 0)!;
    const basis: Array<[number, number, number]> = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    basis.forEach((axis, i) => rotateVecByQuat(axis, bodyToWorld).forEach((v, j) => expect(resolved.axes[i][j]).toBeCloseTo(v, 12)));
  });

  it('measures the angle between two directions at the first one’s origin', () => {
    const universe = scene();
    const velocity = { kind: 'velocity', object: { kind: 'entity', bodyName: 'Probe' } } as const;
    const sun = referenceRelationship({ kind: 'sunDirection', object: 'Probe' }, 'sun');
    expect(sun).toEqual({ id: 'sun', kind: 'direction', source: { kind: 'entity', bodyName: 'Probe' }, target: { kind: 'entity', bodyName: 'Sun' } });
    const angle = resolveSpatialRelationship(universe, referenceRelationship({ kind: 'angle', first: velocity, second: relationshipVectors(sun)[0] }, 'angle'), 0);
    expect(angle?.vertex).toEqual([8000, 0, 0]);
    expect(angle?.angleDeg).toBeCloseTo(90);
    const axis = resolveSpatialRelationship(universe, { id: 'a', kind: 'vector-angle', first: velocity,
      second: { kind: 'frame-axis', frame: 'ECLIPJ2000', origin: { kind: 'entity', bodyName: 'Earth' }, axis: '-Z' } }, 0);
    expect(axis?.angleDeg).toBeCloseTo(180);
    expect(axis?.second.origin).toEqual([1000, 0, 0]);
    const still = resolveSpatialRelationship(universe, { id: 'a', kind: 'vector-angle', first: { ...velocity, relativeTo: velocity.object }, second: relationshipVectors(sun)[0] }, 0);
    expect(still?.angleDeg).toBeUndefined();
  });

  it('names reference vectors and splits relationships into angle operands', () => {
    const axes = referenceRelationship({ kind: 'frameAxes', frame: 'J2000', origin: 'Earth' }, 'axes');
    expect(relationshipVectors(axes).map(referenceVectorLabel)).toEqual(['J2000 +X at Earth', 'J2000 +Y at Earth', 'J2000 +Z at Earth']);
    expect(referenceVectorLabel(relationshipVectors(referenceRelationship({ kind: 'velocity', object: 'Probe', relativeTo: 'Sun' }, 'v'))[0]))
      .toBe('Velocity of Probe relative to Sun');
    expect(relationshipVectors({ id: 'd', kind: 'distance', source: { kind: 'entity', bodyName: 'A' }, target: { kind: 'entity', bodyName: 'B' } })).toEqual([]);
    expect(formatSpatialSpeed(7.66)).toBe('7.660 km/s');
    expect(formatSpatialSpeed(0.0042)).toBe('4.20 m/s');
  });
});
