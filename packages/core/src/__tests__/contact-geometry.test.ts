import { describe, expect, it } from 'vitest';
import { Body } from '../Body.js';
import { Universe } from '../Universe.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';
import { hasLineOfSight } from '../plugins/contact-geometry.js';

function geometry(a: [number, number, number], b: [number, number, number]) {
  const universe = new Universe();
  universe.addBody(new Body({ name: 'SC', trajectory: new FixedPointTrajectory(a) }));
  universe.addBody(new Body({ name: 'station', trajectory: new FixedPointTrajectory(b) }));
  universe.addBody(new Body({ name: 'planet', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [1, 1, 1] }));
  return universe;
}

describe('exploratory line of sight', () => {
  it.each([
    [[2, 0, 0], [1, 0, 0], true], // surface station, above horizon
    [[-2, 0, 0], [1, 0, 0], false], // surface station, behind planet
    [[-2, 1, 0], [2, 1, 0], true], // tangent
    [[-2, 0.99, 0], [2, 0.99, 0], false], // penetrates globe
    [[2, 0, 0], [3, 0, 0], true], // globe outside segment
    [[2, 0, 0], [2, 0, 0], false], // coincident endpoints
  ] as const)('checks segment %j → %j', (a, b, expected) => {
    expect(hasLineOfSight(geometry([...a], [...b]), 'SC', 'station', 0)).toBe(expected);
  });
  it('does not claim visibility with missing or non-finite state', () => {
    const universe = geometry([2, 0, 0], [3, 0, 0]);
    expect(hasLineOfSight(universe, 'missing', 'station', 0)).toBe(false);
    expect(hasLineOfSight(universe, 'SC', 'station', NaN)).toBe(false);
    universe.getBody('planet')!.setTrajectory(new FixedPointTrajectory([NaN, 0, 0]));
    expect(hasLineOfSight(universe, 'SC', 'station', 0)).toBe(false);
  });
});
