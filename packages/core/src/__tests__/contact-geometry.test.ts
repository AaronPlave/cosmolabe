import { describe, expect, it } from 'vitest';
import { Body } from '../Body.js';
import { Universe } from '../Universe.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';
import { FixedRotation } from '../rotations/FixedRotation.js';
import { hasLineOfSight } from '../plugins/contact-geometry.js';

function geometry(a: [number, number, number], b: [number, number, number], radii: [number, number, number] = [1, 1, 1]) {
  const universe = new Universe();
  universe.addBody(new Body({ name: 'SC', trajectory: new FixedPointTrajectory(a) }));
  universe.addBody(new Body({ name: 'station', trajectory: new FixedPointTrajectory(b) }));
  universe.addBody(new Body({ name: 'planet', trajectory: new FixedPointTrajectory([0, 0, 0]), radii }));
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
  it('uses the oblate ellipsoid: a genuine surface station is visible, the far side is not', () => {
    // Surface point at geodetic-style parameter 60°: inside the bounding sphere of radius 1.
    const s = [Math.cos(Math.PI / 3), 0, 0.9 * Math.sin(Math.PI / 3)];
    const normal = [s[0] / 1, 0, s[2] / 0.81]; // gradient of x² + z²/0.9²
    const sc = s.map((v, i) => v + 2 * normal[i]);
    const oblate = (a: number[]) => geometry(a as [number, number, number], s as [number, number, number], [1, 1, 0.9]);
    expect(hasLineOfSight(oblate(sc), 'SC', 'station', 0)).toBe(true);
    expect(hasLineOfSight(oblate([-sc[0], 0, -sc[2]]), 'SC', 'station', 0)).toBe(false); // through the body
  });
  it('orients the ellipsoid by the occulter rotation model', () => {
    // Path at z = 0.95 clears an unrotated 0.9 polar radius.
    const mk = (q?: [number, number, number, number]) => {
      const u = new Universe();
      u.addBody(new Body({ name: 'SC', trajectory: new FixedPointTrajectory([-3, 0, 0.95]) }));
      u.addBody(new Body({ name: 'station', trajectory: new FixedPointTrajectory([3, 0, 0.95]) }));
      u.addBody(new Body({ name: 'planet', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [1, 1, 0.9],
        rotation: q && new FixedRotation(q, 'ECLIPJ2000') }));
      return u;
    };
    expect(hasLineOfSight(mk(), 'SC', 'station', 0)).toBe(true); // pole 0.9 < 0.95
    const h = Math.SQRT1_2; // +90° about x: polar axis → -y, so z extent becomes 1
    expect(hasLineOfSight(mk([h, h, 0, 0]), 'SC', 'station', 0)).toBe(false);
  });
  it.each([
    ['throws', () => { throw new Error('no CK coverage'); }],
    ['is non-finite', () => [NaN, 0, 0, 0] as [number, number, number, number]],
  ])('is not clear when an occulter rotation model %s', (_, rotationAt) => {
    const u = geometry([2, 0, 0], [3, 0, 0]); // clear of the planet if it could be oriented
    expect(hasLineOfSight(u, 'SC', 'station', 0)).toBe(true);
    u.addBody(new Body({ name: 'planet', trajectory: new FixedPointTrajectory([0, 0, 0]), radii: [1, 1, 1],
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt } }));
    expect(hasLineOfSight(u, 'SC', 'station', 0)).toBe(false);
  });
  it('does not claim visibility with missing or non-finite state', () => {
    const universe = geometry([2, 0, 0], [3, 0, 0]);
    expect(hasLineOfSight(universe, 'missing', 'station', 0)).toBe(false);
    expect(hasLineOfSight(universe, 'SC', 'station', NaN)).toBe(false);
    universe.getBody('planet')!.setTrajectory(new FixedPointTrajectory([NaN, 0, 0]));
    expect(hasLineOfSight(universe, 'SC', 'station', 0)).toBe(false);
  });
});
