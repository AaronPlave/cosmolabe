import { describe, expect, it } from 'vitest';
import { Body } from '../Body.js';
import { Universe } from '../Universe.js';
import { CompositeTrajectory } from '../trajectories/CompositeTrajectory.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';
import { UniformRotation } from '../rotations/UniformRotation.js';
import type { Quaternion, RotationModel } from '../rotations/RotationModel.js';

// A rotation that's identity at every ET. Used to make sub-point math
// deterministic without dragging in SPICE.
class IdentityRotation implements RotationModel {
  constructor(public readonly sourceFrame = 'EclipticJ2000') {}
  rotationAt(_et: number): Quaternion {
    return [1, 0, 0, 0];
  }
}

describe('Universe.subPointOf', () => {
  it('returns the equatorial sub-point for a body at the parent equator', () => {
    const u = new Universe();
    const earth = new Body({
      name: 'Earth',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
      rotation: new IdentityRotation('EclipticJ2000'),
      radii: [6378, 6378, 6357],
    });
    const sat = new Body({
      name: 'Sat',
      trajectory: new FixedPointTrajectory([6800, 0, 0]),
      parentName: 'Earth',
      trajectoryFrame: 'ecliptic',
    });
    u.addBody(earth);
    u.addBody(sat);

    const sp = u.subPointOf('Sat', 0);
    expect(sp).not.toBeNull();
    expect(sp!.lat).toBeCloseTo(0, 5);
    expect(sp!.lon).toBeCloseTo(0, 5);
    expect(sp!.altKm).toBeCloseTo(6800 - 6378, 5);
  });

  it('returns null when the parent has no rotation', () => {
    const u = new Universe();
    const earth = new Body({
      name: 'Earth',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
      // no rotation
    });
    const sat = new Body({
      name: 'Sat',
      trajectory: new FixedPointTrajectory([6800, 0, 0]),
      parentName: 'Earth',
    });
    u.addBody(earth);
    u.addBody(sat);

    expect(u.subPointOf('Sat', 0)).toBeNull();
  });

  it('returns null for unknown body', () => {
    const u = new Universe();
    expect(u.subPointOf('Nope', 0)).toBeNull();
  });

  it('uses the active arc parent for composite trajectories', () => {
    // Earth-centric arc and Moon-centric arc on the same body. Sub-point
    // should resolve against the active arc's center body.
    const u = new Universe();
    const earth = new Body({
      name: 'Earth',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
      rotation: new IdentityRotation('EclipticJ2000'),
      radii: [6378, 6378, 6357],
    });
    const moon = new Body({
      name: 'Moon',
      trajectory: new FixedPointTrajectory([400_000, 0, 0]),
      rotation: new IdentityRotation('EclipticJ2000'),
      radii: [1737, 1737, 1737],
    });
    const probe = new Body({
      name: 'Probe',
      trajectoryFrame: 'ecliptic',
      parentName: 'Earth',
      trajectory: new CompositeTrajectory([
        {
          trajectory: new FixedPointTrajectory([7000, 0, 0]),
          startTime: 0,
          endTime: 100,
          centerName: 'Earth',
        },
        {
          trajectory: new FixedPointTrajectory([1900, 0, 0]),
          startTime: 100,
          endTime: 200,
          centerName: 'Moon',
        },
      ]),
    });
    u.addBody(earth);
    u.addBody(moon);
    u.addBody(probe);

    const cruise = u.subPointOf('Probe', 50);
    expect(cruise!.altKm).toBeCloseTo(7000 - 6378, 5);

    const lunar = u.subPointOf('Probe', 150);
    expect(lunar!.altKm).toBeCloseTo(1900 - 1737, 5);
  });
});

describe('Universe.bodyFixedVelocityMagnitudeOf', () => {
  it('returns ~0 for a stationary body in its parent body-fixed frame', () => {
    const u = new Universe();
    const parent = new Body({
      name: 'Parent',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
      rotation: new IdentityRotation('EclipticJ2000'),
      radii: [1000, 1000, 1000],
    });
    const child = new Body({
      name: 'Child',
      trajectory: new FixedPointTrajectory([1500, 0, 0]),
      parentName: 'Parent',
      trajectoryFrame: 'ecliptic',
    });
    u.addBody(parent);
    u.addBody(child);

    const v = u.bodyFixedVelocityMagnitudeOf('Child', 0);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(1e-9);
  });

  it('captures parent surface rotation rate as v_surface for a co-rotating body', () => {
    // Set up a parent that spins at the Moon's sidereal rate (27.3 days)
    // and place a child stationary in the inertial frame at the equator.
    // The body-fixed velocity should match the surface speed at that
    // radius — i.e. ω × r magnitude.
    const u = new Universe();
    const moonRadiusKm = 1737;
    const periodSec = 27.321661 * 86400;
    const omega = (2 * Math.PI) / periodSec; // rad/s
    const parent = new Body({
      name: 'Parent',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
      rotation: new UniformRotation(
        periodSec,
        0,
        0,
        0,
        Math.PI / 2, // pole at +Z (J2000-equatorial)
        'EquatorJ2000',
      ),
      radii: [moonRadiusKm, moonRadiusKm, moonRadiusKm],
    });
    // Place the child at the parent's equator, in the parent's rotation
    // source frame so the alignment is a no-op.
    const child = new Body({
      name: 'Child',
      trajectory: new FixedPointTrajectory([moonRadiusKm, 0, 0]),
      parentName: 'Parent',
      trajectoryFrame: 'equatorial',
    });
    u.addBody(parent);
    u.addBody(child);

    const v = u.bodyFixedVelocityMagnitudeOf('Child', 0);
    const expectedSurfaceSpeed = omega * moonRadiusKm; // km/s
    expect(v!).toBeCloseTo(expectedSurfaceSpeed, 5);
  });

  it('returns null for missing parent rotation', () => {
    const u = new Universe();
    const parent = new Body({
      name: 'Parent',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
    });
    const child = new Body({
      name: 'Child',
      trajectory: new FixedPointTrajectory([1000, 0, 0]),
      parentName: 'Parent',
    });
    u.addBody(parent);
    u.addBody(child);
    expect(u.bodyFixedVelocityMagnitudeOf('Child', 0)).toBeNull();
  });
});
