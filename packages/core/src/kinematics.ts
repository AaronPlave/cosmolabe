import type { Body } from './Body.js';
import type { InertialFrameName, Quaternion } from './rotations/RotationModel.js';

/**
 * Frame-aware kinematics primitives shared by `Universe.subPointOf` and
 * `Universe.bodyFixedVelocityMagnitudeOf`. Kept in a sibling module so
 * the math isn't tangled with universe / body / trajectory plumbing.
 *
 * Today only the EclipticJ2000 ↔ EquatorJ2000 (J2000 obliquity) and
 * trivial body-fixed pass-through cases are handled — covers every stock
 * cosmolabe body. SPICE-named frames (`IAU_MOON`, `MOON_ME`, etc.) flow
 * through unchanged: the position is assumed to already be in the
 * rotation's source frame, which is the common case for SPICE-driven
 * bodies whose trajectory shares the rotation's inertialFrame.
 */

export type Vec3 = [number, number, number];

// J2000 mean obliquity (IAU 1976), in radians.
const OBLIQUITY_J2000_RAD = (23.4392911 * Math.PI) / 180;
const OBLIQUITY_COS = Math.cos(OBLIQUITY_J2000_RAD);
const OBLIQUITY_SIN = Math.sin(OBLIQUITY_J2000_RAD);

/** Synonym set for the J2000-equatorial frame as it appears across
 *  cosmolabe call sites (Cosmographia / IAU / SPICE / app-config name
 *  variations). */
function isEquatorJ2000(frame: InertialFrameName): boolean {
  return (
    frame === 'EquatorJ2000' ||
    frame === 'J2000' ||
    frame === 'EME2000' ||
    frame === 'ICRF'
  );
}

function isEclipticJ2000(frame: InertialFrameName): boolean {
  return frame === 'EclipticJ2000' || frame === 'ECLIPJ2000';
}

/** Rotate a vector from one named inertial frame to another. Currently
 *  handles the EquatorJ2000 ↔ EclipticJ2000 obliquity rotation (the
 *  common cosmolabe case driven by UniformRotation's J2000-anchored pole
 *  conventions vs SpiceRotation's ecliptic default). All other
 *  frame-pair combinations fall through unchanged — the caller is
 *  assumed to have constructed its inputs in the right frame, or the
 *  frames don't have a registered analytical conversion (SPICE-driven
 *  frame composition lives elsewhere).
 *
 *  Pass-through behavior is intentional: it lets callers thread the
 *  function unconditionally without per-frame dispatch logic. */
export function alignPositionToFrame(
  pos: Vec3,
  sourceFrame: InertialFrameName,
  targetFrame: InertialFrameName,
): Vec3 {
  if (sourceFrame === targetFrame) return pos;
  if (isEquatorJ2000(sourceFrame) && isEclipticJ2000(targetFrame)) {
    // R_x(-ε): EquatorJ2000 → EclipticJ2000.
    const [x, y, z] = pos;
    return [
      x,
      OBLIQUITY_COS * y + OBLIQUITY_SIN * z,
      -OBLIQUITY_SIN * y + OBLIQUITY_COS * z,
    ];
  }
  if (isEclipticJ2000(sourceFrame) && isEquatorJ2000(targetFrame)) {
    // R_x(+ε): EclipticJ2000 → EquatorJ2000 (inverse of the above).
    const [x, y, z] = pos;
    return [
      x,
      OBLIQUITY_COS * y - OBLIQUITY_SIN * z,
      OBLIQUITY_SIN * y + OBLIQUITY_COS * z,
    ];
  }
  // Synonymous aliases collapse: both are EquatorJ2000-family or both are
  // EclipticJ2000-family but spelled differently.
  if (isEquatorJ2000(sourceFrame) && isEquatorJ2000(targetFrame)) return pos;
  if (isEclipticJ2000(sourceFrame) && isEclipticJ2000(targetFrame)) return pos;
  // No known conversion — pass through.
  return pos;
}

/** Frame-name for the position output of `body.stateAt(et)`. Maps the
 *  3-bucket `Body.trajectoryFrame` ('ecliptic' | 'equatorial' | 'body-fixed')
 *  to a named inertial frame string compatible with
 *  `RotationModel.sourceFrame`. Used by `Universe.subPointOf` to decide
 *  whether to convert a body's parent-relative position before composing
 *  with the parent's rotation. */
export function bodyTrajectoryFrameName(body: Body): InertialFrameName {
  switch (body.trajectoryFrame) {
    case 'equatorial':
      return 'EquatorJ2000';
    case 'ecliptic':
    case undefined:
      return 'EclipticJ2000';
    case 'body-fixed':
      // Body-fixed trajectories (surface points) need parent rotation
      // applied to produce inertial coords — by the time `subPointOf` is
      // called these have already been resolved upstream via
      // `Universe.absolutePositionOf`. Treat the literal stored
      // position as parent-rotation-frame-aligned (i.e., the caller's
      // problem to pass the right thing).
      return 'EclipticJ2000';
  }
}

/** Apply a unit quaternion `[w, x, y, z]` to a 3-vector. Matches
 *  `BodyMesh`'s internal convention. */
export function rotateVecByQuat(v: Vec3, q: Quaternion): Vec3 {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}
