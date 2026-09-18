import type { Body } from './Body.js';
import type { InertialFrameName, Quaternion, RotationModel } from './rotations/RotationModel.js';
import { OBLIQUITY_J2000_RAD } from './constants.js';

/**
 * Frame-aware kinematics: the low-level primitives (frame alignment,
 * quaternion composition) and the two body-fixed geometry functions built on
 * them, `subPointOf` and `bodyFixedVelocityMagnitudeOf`. Both used to be
 * methods on `Universe`, which they needed only for a name → body lookup;
 * they take that lookup as an argument instead, so the geometry is reachable
 * without a universe and new helpers land here rather than on the model.
 *
 * Today only the EclipticJ2000 ↔ EquatorJ2000 (J2000 obliquity) and
 * trivial body-fixed pass-through cases are handled — covers every stock
 * cosmolabe body. SPICE-named frames (`IAU_MOON`, `MOON_ME`, etc.) flow
 * through unchanged: the position is assumed to already be in the
 * rotation's source frame, which is the common case for SPICE-driven
 * bodies whose trajectory shares the rotation's inertialFrame.
 */

// The one Vec3 of the tree, from the SPICE interface core is written against.
export type { Vec3 } from './spice-injection.js';
import type { Vec3 } from './spice-injection.js';

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

/** Place a point at `distance` from a body's centre, in the direction given by
 *  planetocentric `latitudeDeg` / `longitudeDeg`, expressed in the world frame.
 *
 *  This is the catalog viewpoint convention (`distance` + `latitude` +
 *  `longitude`): the offset is **body-fixed**, so "Jezero Overhead" keeps
 *  pointing at Jezero as Mars turns, rather than at inertial coordinates Mars
 *  no longer faces. Body-fixed axes are Z = pole, X = prime meridian, matching
 *  `WaypointTrajectory` and the surface pick path.
 *
 *  `rotationQuat` is `RotationModel.rotationAt(et)` and `sourceFrame` its
 *  declared frame; the mapping to world goes through
 *  `composeBodyToWorldQuat`, so it carries the source→world frame alignment
 *  (i.e. the J2000 obliquity when the model is stated in EquatorJ2000) rather
 *  than stopping at the model's own source frame. Getting only half of that
 *  composition right lands the point ~23.44° from the surface feature it
 *  names, which is why this lives here with a test rather than inline in the
 *  app that happens to need it. */
export function bodyFixedOffsetToWorld(
  distance: number,
  latitudeDeg: number,
  longitudeDeg: number,
  rotationQuat: Quaternion,
  sourceFrame: InertialFrameName,
  worldFrame: InertialFrameName = 'EclipticJ2000',
): Vec3 {
  const lat = (latitudeDeg * Math.PI) / 180;
  const lon = (longitudeDeg * Math.PI) / 180;
  const bodyFixed: Vec3 = [
    distance * Math.cos(lat) * Math.cos(lon),
    distance * Math.cos(lat) * Math.sin(lon),
    distance * Math.sin(lat),
  ];
  return rotateVecByQuat(bodyFixed, composeBodyToWorldQuat(rotationQuat, sourceFrame, worldFrame));
}

/** Resolve a body by name. `Universe.getBody` satisfies this, and it is the
 *  only thing the two geometry helpers below need a universe for — they are
 *  otherwise pure functions of `(body, parent, et)`. */
export type BodyLookup = (name: string) => Body | undefined;

/** A body, the parent it is active around at `et`, and that parent's rotation
 *  model — or null when any of the three is missing.
 *
 *  Shared by `subPointOf` and `bodyFixedVelocityMagnitudeOf` so their null
 *  conditions cannot drift apart: both are defined relative to the body-fixed
 *  frame of the active parent, and neither means anything without one. The
 *  rotation is returned rather than re-read off `parent` so callers get it
 *  already narrowed to non-undefined. */
function activeParentPair(
  lookup: BodyLookup,
  bodyName: string,
  et: number,
): { body: Body; parent: Body; parentRotation: RotationModel } | null {
  const body = lookup(bodyName);
  if (!body) return null;
  const parentName = body.activeParentAt(et);
  if (!parentName) return null;
  const parent = lookup(parentName);
  if (!parent?.rotation) return null;
  return { body, parent, parentRotation: parent.rotation };
}

/** Planetocentric sub-point — the lat/lon on the body's active parent
 *  (per `body.activeParentAt(et)`) directly below the body, plus altitude
 *  above the parent's equatorial radius. Returns null when the body has
 *  no parent, the parent has no rotation model, or out-of-coverage.
 *
 *  Frame composition: walks the parent rotation's `sourceFrame` and
 *  rotates `body.stateAt(et).position` into that frame if its own
 *  trajectory lives in a different one (EquatorJ2000 ↔ EclipticJ2000
 *  via the J2000 obliquity). Same machinery as `BodyMesh.updatePosition`,
 *  exposed so app-side body-fixed math doesn't have to re-derive. */
export function subPointOf(
  lookup: BodyLookup,
  bodyName: string,
  et: number,
): { lat: number; lon: number; altKm: number } | null {
  const pair = activeParentPair(lookup, bodyName, et);
  if (!pair) return null;
  const { body, parent, parentRotation } = pair;
  let state;
  try {
    state = body.stateAt(et);
  } catch {
    return null;
  }
  if (!state) return null;
  const q = parent.rotationAt(et);
  if (!q) return null;
  // For body-fixed bodies, state.position is already in the parent's
  // body-fixed frame — no inertial-frame alignment is meaningful. Pass
  // through the parent's rotation source frame so alignPositionToFrame
  // becomes a no-op for this case.
  const bodyFrame: InertialFrameName = bodyTrajectoryFrameName(body) ?? parentRotation.sourceFrame;
  const aligned = alignPositionToFrame(
    state.position,
    bodyFrame,
    parentRotation.sourceFrame,
  );
  const bf = rotateVecByQuat(aligned, q);
  const r = Math.sqrt(bf[0] * bf[0] + bf[1] * bf[1] + bf[2] * bf[2]);
  if (r <= 0) return null;
  const lat = (Math.asin(bf[2] / r) * 180) / Math.PI;
  const lon = (Math.atan2(bf[1], bf[0]) * 180) / Math.PI;
  const surfaceRadius = parent.radii
    ? Math.max(parent.radii[0], parent.radii[1])
    : 0;
  return { lat, lon, altKm: r - surfaceRadius };
}

/** Body-fixed (rotating-frame) velocity magnitude of a body relative to
 *  its active parent, via numerical d/dt of body-fixed position. Goes to
 *  ~0 for a landed spacecraft co-rotating with its parent; ~7.2 km/s
 *  for a typical LEO sat (ground-track speed).
 *
 *  Returns null on the same conditions as `subPointOf` (missing parent /
 *  parent rotation / out-of-coverage). `dt` defaults to 1 second — finer
 *  is noisier, coarser smears burns. */
export function bodyFixedVelocityMagnitudeOf(
  lookup: BodyLookup,
  bodyName: string,
  et: number,
  dt: number = 1,
): number | null {
  const pair = activeParentPair(lookup, bodyName, et);
  if (!pair) return null;
  const { body, parent, parentRotation } = pair;
  const parentFrame = parentRotation.sourceFrame;
  // Body-fixed bodies pass through (state.position is already in parent's
  // body-fixed frame). Aligning a body-fixed value as an inertial source
  // would be meaningless — make it a no-op by matching the target.
  const scFrame: InertialFrameName = bodyTrajectoryFrameName(body) ?? parentFrame;
  try {
    const sA = body.stateAt(et - dt);
    const sB = body.stateAt(et + dt);
    const qA = parent.rotationAt(et - dt);
    const qB = parent.rotationAt(et + dt);
    if (!sA || !sB || !qA || !qB) return null;
    const pA = alignPositionToFrame(sA.position, scFrame, parentFrame);
    const pB = alignPositionToFrame(sB.position, scFrame, parentFrame);
    const bfA = rotateVecByQuat(pA, qA);
    const bfB = rotateVecByQuat(pB, qB);
    const dvx = (bfB[0] - bfA[0]) / (2 * dt);
    const dvy = (bfB[1] - bfA[1]) / (2 * dt);
    const dvz = (bfB[2] - bfA[2]) / (2 * dt);
    return Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
  } catch {
    return null;
  }
}
