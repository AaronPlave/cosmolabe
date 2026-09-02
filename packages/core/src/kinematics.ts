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
// Half-angle terms for the equivalent quaternion form (see frameAlignmentQuat).
const OBLIQUITY_HALF_COS = Math.cos(OBLIQUITY_J2000_RAD / 2);
const OBLIQUITY_HALF_SIN = Math.sin(OBLIQUITY_J2000_RAD / 2);

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

/** Inertial frame the body's `stateAt(et).position` lives in. Maps the
 *  3-bucket `Body.trajectoryFrame` ('ecliptic' | 'equatorial' | 'body-fixed')
 *  to a named inertial frame string compatible with
 *  `RotationModel.sourceFrame`.
 *
 *  Returns `undefined` for `'body-fixed'` — body-fixed positions are NOT
 *  in an inertial frame; they're in the parent body's rotating frame.
 *  Callers that need an inertial frame for a body-fixed child must first
 *  apply the parent's rotation conjugate (lifting body-fixed → inertial)
 *  and then use the parent's `rotation.sourceFrame`. See
 *  `bodyPositionFrame()` for a helper that bundles this. */
export function bodyTrajectoryFrameName(body: Body): InertialFrameName | undefined {
  switch (body.trajectoryFrame) {
    case 'equatorial':
      return 'EquatorJ2000';
    case 'ecliptic':
    case undefined:
      return 'EclipticJ2000';
    case 'body-fixed':
      return undefined;
  }
}

/** Inertial frame the body's POSITION effectively lives in, accounting for
 *  body-fixed bodies whose stored position requires unwrapping via the
 *  parent's rotation. For inertial-trajectory bodies, equivalent to
 *  `bodyTrajectoryFrameName(body)`. For body-fixed bodies, returns the
 *  parent's `rotation.sourceFrame` — the frame the body-fixed position
 *  lifts to after applying the parent's rotation conjugate.
 *
 *  Returns `undefined` only when the body is body-fixed AND the parent
 *  has no rotation registered (a catalog error). Callers that pass a
 *  non-body-fixed body get a defined result. */
export function bodyPositionFrame(body: Body, parent?: Body): InertialFrameName | undefined {
  if (body.trajectoryFrame !== 'body-fixed') {
    return bodyTrajectoryFrameName(body);
  }
  return parent?.rotation?.sourceFrame;
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

/** Hamilton product of two `[w, x, y, z]` quaternions (a applied second,
 *  b first — i.e. the rotation `a ∘ b`). Matches `THREE.Quaternion.multiply`. */
export function multiplyQuat(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/** Quaternion `[w, x, y, z]` that rotates a vector FROM a named inertial frame
 *  INTO `worldFrame` (cosmolabe's canonical EclipticJ2000 by default). This is
 *  the quaternion analogue of `alignPositionToFrame` — the two MUST encode the
 *  same rotation (pinned by the obliquity-consistency test), since one drives
 *  body orientation (BodyMesh) and the other drives body position (Universe).
 *
 *  Returns identity for same-frame, same-family-different-spelling, and
 *  unhandled (SPICE-named) frames — matching `alignPositionToFrame`'s
 *  pass-through semantics. Only the EquatorJ2000 ↔ EclipticJ2000 obliquity
 *  rotation is composed analytically. */
export function frameAlignmentQuat(
  sourceFrame: InertialFrameName,
  worldFrame: InertialFrameName = 'EclipticJ2000',
): Quaternion {
  if (sourceFrame === worldFrame) return [1, 0, 0, 0];
  if (isEquatorJ2000(sourceFrame) && isEclipticJ2000(worldFrame)) {
    // R_x(-ε): EquatorJ2000 → EclipticJ2000. Quaternion of a rotation by -ε
    // about +X is [cos(ε/2), -sin(ε/2), 0, 0].
    return [OBLIQUITY_HALF_COS, -OBLIQUITY_HALF_SIN, 0, 0];
  }
  if (isEclipticJ2000(sourceFrame) && isEquatorJ2000(worldFrame)) {
    // R_x(+ε): EclipticJ2000 → EquatorJ2000 (inverse of the above).
    return [OBLIQUITY_HALF_COS, OBLIQUITY_HALF_SIN, 0, 0];
  }
  // Synonymous aliases or no known conversion — identity (pass-through).
  return [1, 0, 0, 0];
}

/** Compose a body's full body→world orientation quaternion `[w, x, y, z]`.
 *
 *  `rotationQuat` is `RotationModel.rotationAt(et)` — the rotation FROM the
 *  model's `sourceFrame` TO the body-fixed frame. We conjugate it (body→source)
 *  then pre-multiply by the source→world frame alignment, giving body→world:
 *    frameAlign(source→world) ∘ conjugate(rotationQuat)
 *
 *  This is the single source of truth for the orientation composition that was
 *  previously duplicated inside `BodyMesh.updatePosition` (`frameToEclipticQuat`).
 *  The Three.js-specific model-axis convention (`meshRotationQ`) is intentionally
 *  NOT folded in here — callers in the renderer post-multiply that themselves. */
export function composeBodyToWorldQuat(
  rotationQuat: Quaternion,
  sourceFrame: InertialFrameName,
  worldFrame: InertialFrameName = 'EclipticJ2000',
): Quaternion {
  // rotationAt returns source→body; conjugate [w,-x,-y,-z] gives body→source.
  const bodyToSource: Quaternion = [
    rotationQuat[0],
    -rotationQuat[1],
    -rotationQuat[2],
    -rotationQuat[3],
  ];
  const frameAlign = frameAlignmentQuat(sourceFrame, worldFrame);
  return multiplyQuat(frameAlign, bodyToSource);
}
