import { describe, it, expect } from 'vitest';
import { Body } from '../Body.js';
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

describe('Body.activeParentAt', () => {
  it('returns static parentName for non-composite trajectories', () => {
    const body = new Body({
      name: 'LEO Sat',
      trajectory: new FixedPointTrajectory([6800, 0, 0]),
      parentName: 'Earth',
    });
    expect(body.activeParentAt(0)).toBe('Earth');
    expect(body.activeParentAt(1e9)).toBe('Earth');
  });

  it('returns undefined when no parent and trajectory is non-composite', () => {
    const body = new Body({
      name: 'Root',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
    });
    expect(body.activeParentAt(0)).toBeUndefined();
  });

  it('returns the active arc centerName for composite trajectories', () => {
    // Mimics Blue Ghost: cruise=Earth, EDL=Moon, landed=Moon.
    const cruise = new FixedPointTrajectory([400_000, 0, 0]);
    const edl = new FixedPointTrajectory([1737, 0, 0]);
    const landed = new FixedPointTrajectory([1737, 0, 0]);
    const composite = new CompositeTrajectory([
      { trajectory: cruise, startTime: 0, endTime: 100, centerName: 'Earth' },
      { trajectory: edl, startTime: 100, endTime: 110, centerName: 'Moon' },
      { trajectory: landed, startTime: 110, endTime: 200, centerName: 'Moon' },
    ]);
    const body = new Body({
      name: 'Blue Ghost',
      trajectory: composite,
      parentName: 'Earth', // static catalog parent — should NOT win for landed
    });
    expect(body.activeParentAt(50)).toBe('Earth');   // cruise
    expect(body.activeParentAt(105)).toBe('Moon');   // EDL
    expect(body.activeParentAt(150)).toBe('Moon');   // landed
  });

  it('falls back to static parentName when an arc has no centerName', () => {
    const arc = new FixedPointTrajectory([1, 0, 0]);
    const composite = new CompositeTrajectory([
      { trajectory: arc, startTime: 0, endTime: 10 }, // no centerName
    ]);
    const body = new Body({
      name: 'Probe',
      trajectory: composite,
      parentName: 'Sun',
    });
    expect(body.activeParentAt(5)).toBe('Sun');
  });

  it('clamps out-of-range queries to the nearest arc center', () => {
    // CompositeTrajectory.arcAt already clamps; verify activeParentAt
    // inherits that behavior so a pre-launch or post-mission scrubber
    // doesn't return undefined.
    const cruise = new FixedPointTrajectory([400_000, 0, 0]);
    const landed = new FixedPointTrajectory([1737, 0, 0]);
    const composite = new CompositeTrajectory([
      { trajectory: cruise, startTime: 0, endTime: 100, centerName: 'Earth' },
      { trajectory: landed, startTime: 100, endTime: 200, centerName: 'Moon' },
    ]);
    const body = new Body({
      name: 'Probe',
      trajectory: composite,
      parentName: 'Earth',
    });
    expect(body.activeParentAt(-50)).toBe('Earth');  // before first arc
    expect(body.activeParentAt(500)).toBe('Moon');   // after last arc
  });
});
