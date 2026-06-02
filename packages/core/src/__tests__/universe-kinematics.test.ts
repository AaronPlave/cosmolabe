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

describe('Universe.absolutePositionOf — per-leg frame composition', () => {
  // Mirrors the cassini-soi catalog mismatch: planet's trajectory is in
  // EclipticJ2000 (Sun-centric Builtin), moons declare J2000-equatorial
  // for their planet-relative trajectory. The accumulated position has to
  // rotate from EquatorJ2000 → EclipticJ2000 before adding the planet's
  // ecliptic-frame contribution. Pre-fix this was a silent mismatch that
  // visibly broke Saturn's moons being coplanar with its rings post-Phase 3.
  it('rotates child position to parent frame when frames differ', () => {
    const u = new Universe();
    // Sun at origin in ECLIPJ2000.
    const sun = new Body({
      name: 'Sun',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
    });
    // "Saturn" 1,400,000,000 km from Sun on the ecliptic +X axis, in
    // ECLIPJ2000 frame (default).
    const saturn = new Body({
      name: 'Saturn',
      trajectory: new FixedPointTrajectory([1_400_000_000, 0, 0]),
      parentName: 'Sun',
    });
    // "Mimas" 185,520 km from Saturn along EquatorJ2000 +Y. Declares
    // trajectoryFrame=equatorial, matching the Cosmographia convention.
    const mimas = new Body({
      name: 'Mimas',
      trajectory: new FixedPointTrajectory([0, 185_520, 0]),
      parentName: 'Saturn',
      trajectoryFrame: 'equatorial',
    });
    u.addBody(sun);
    u.addBody(saturn);
    u.addBody(mimas);

    // Expected: Mimas's EquatorJ2000 offset [0, 185520, 0] rotated to
    // EclipticJ2000 via R_x(-ε) ≈ [0, 170243, -73806], then added to
    // Saturn's [1.4e9, 0, 0] ECLIPJ2000 position.
    const eps = (23.4392911 * Math.PI) / 180;
    const expectedY = 185_520 * Math.cos(eps);
    const expectedZ = -185_520 * Math.sin(eps);
    const pos = u.absolutePositionOf('Mimas', 0);
    expect(pos[0]).toBeCloseTo(1_400_000_000, 0);
    expect(pos[1]).toBeCloseTo(expectedY, 0);
    expect(pos[2]).toBeCloseTo(expectedZ, 0);
  });

  it('is a no-op when all parent-chain frames match', () => {
    const u = new Universe();
    const sun = new Body({
      name: 'Sun',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
    });
    const planet = new Body({
      name: 'Planet',
      trajectory: new FixedPointTrajectory([1e8, 0, 0]),
      parentName: 'Sun',
    });
    const moon = new Body({
      name: 'Moon',
      trajectory: new FixedPointTrajectory([0, 1000, 0]),
      parentName: 'Planet',
      // Same frame as planet (both default to ecliptic).
    });
    u.addBody(sun);
    u.addBody(planet);
    u.addBody(moon);
    const pos = u.absolutePositionOf('Moon', 0);
    // No obliquity rotation — moon's offset preserved exactly.
    expect(pos[0]).toBeCloseTo(1e8, 0);
    expect(pos[1]).toBeCloseTo(1000, 6);
    expect(pos[2]).toBeCloseTo(0, 6);
  });
});
