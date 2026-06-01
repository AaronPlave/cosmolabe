export type Quaternion = [number, number, number, number]; // [w, x, y, z]

/** Named inertial frames cosmolabe recognises for `RotationModel.sourceFrame`.
 *
 *  - `EclipticJ2000` / `ECLIPJ2000` — cosmolabe's internal canonical inertial
 *    frame. Universe-wide barycentric positions live here.
 *  - `EquatorJ2000` / `J2000` / `EME2000` / `ICRF` — Earth Mean Equator at
 *    J2000 epoch (the IAU pole-RA/Dec convention frame). UniformRotation,
 *    FixedRotation, FixedEulerRotation default to this since their inputs
 *    are conventionally J2000-equatorial.
 *  - Any SPICE frame name (`IAU_MOON`, `BGM1_LANDER`, ...) — declared by
 *    SpiceRotation / NadirRotation users.
 *
 *  `BodyMesh.updatePosition` reads this field and composes a frame-conversion
 *  rotation when the rotation's source doesn't match cosmolabe's native
 *  ECLIPJ2000. The string is preserved verbatim for non-canonical frames so
 *  SPICE-aware consumers can chain further. */
export type InertialFrameName = string;

/** A model that maps ET (seconds past J2000 TDB) to a body's orientation
 *  quaternion `[w, x, y, z]`, expressed as the rotation FROM the model's
 *  declared `sourceFrame` TO the body's body-fixed frame.
 *
 *  `sourceFrame` is required so callers (`BodyMesh.updatePosition`, app-side
 *  body-fixed math) can compose frames correctly without guessing. */
export interface RotationModel {
  rotationAt(et: number): Quaternion;
  readonly sourceFrame: InertialFrameName;
}

/** Cosmolabe's internal canonical inertial frame — what `Universe.absolutePositionOf`
 *  returns positions in. Rotation models whose output is in this frame
 *  compose with absolutePosition without any further frame conversion. */
export const DEFAULT_INERTIAL_FRAME: InertialFrameName = "EclipticJ2000";
