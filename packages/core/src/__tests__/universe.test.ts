import { describe, it, expect } from 'vitest';
import { Universe } from '../Universe.js';
import { Body } from '../Body.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';

describe('Universe', () => {
  it('registers and retrieves bodies', () => {
    const universe = new Universe();
    const sun = new Body({ name: 'Sun', trajectory: new FixedPointTrajectory([0, 0, 0]) });
    universe.addBody(sun);
    expect(universe.getBody('Sun')).toBe(sun);
  });

  it('sets up parent-child relationships', () => {
    const universe = new Universe();
    const sun = new Body({ name: 'Sun', trajectory: new FixedPointTrajectory([0, 0, 0]) });
    const earth = new Body({ name: 'Earth', parentName: 'Sun', trajectory: new FixedPointTrajectory([149597870.7, 0, 0]) });

    universe.addBody(sun);
    universe.addBody(earth);

    expect(sun.children).toContain(earth);
  });

  it('tracks time and notifies plugins', () => {
    const universe = new Universe();
    const times: number[] = [];
    universe.use({
      name: 'test-plugin',
      onTimeChange(et) { times.push(et); },
    });

    universe.setTime(100);
    universe.setTime(200);
    expect(times).toEqual([100, 200]);
  });

  it('loads catalog JSON', () => {
    const universe = new Universe();
    universe.loadCatalog({
      name: 'Test',
      items: [
        {
          name: 'TestBody',
          trajectory: { type: 'FixedPoint', position: [100, 200, 300] },
        },
      ],
    });

    const body = universe.getBody('TestBody');
    expect(body).toBeDefined();
    expect(body!.stateAt(0).position).toEqual([100, 200, 300]);
  });

  it('returns root bodies (no parent)', () => {
    const universe = new Universe();
    universe.addBody(new Body({ name: 'Sun', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    universe.addBody(new Body({ name: 'Earth', parentName: 'Sun', trajectory: new FixedPointTrajectory([1, 0, 0]) }));

    const roots = universe.getRootBodies();
    expect(roots.length).toBe(1);
    expect(roots[0].name).toBe('Sun');
  });
});
