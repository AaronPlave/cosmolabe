/**
 * ISS articulation: joint names, the model-local axis conventions, and the
 * deterministic Sun-tracking approximation (#370).
 *
 * Everything here is pure arithmetic on model-local vectors; the rig that
 * moves real glTF nodes is `rig.ts`.
 *
 * ## Axis conventions (inspected in `ISS_stationary.glb`, not assumed)
 *
 * The NASA model's local frame, read from node translations and mesh bounds:
 *  - +Z runs forward (Harmony/PMA-2 at +Z, Zvezda at -Z),
 *  - +Y is zenith (the integrated truss S0 sits at +Y, the Cupola at -Y),
 *  - +X is port (P-side trusses at +X, S-side at -X).
 *
 * Joints, each rotating about the node's own origin:
 *  - `S4 Truss` / `P4 Truss`: the SARJ-driven outboard truss, about **X**.
 *    The file stores a 60 degree rest rotation about X on both; an angle here
 *    is the absolute rotation about X relative to the (unrotated) parent.
 *  - `S4/S6/P4/P6 Truss_01/_02`: eight solar-array wings (the BGA-driven
 *    nodes), about **Z**. Their meshes are 12 m wide (X), ~1.3 m thick (Y)
 *    and 37 m long (Z) with the pivot at the root of the long axis, so the
 *    array "normal" is local +Y and BGA rotation spins it about the mast.
 *
 * Radiator nodes (`S1/P1 Truss_02`) are deliberately not driven: the
 * published Sun-tracking example rotates them about Z, but their long axis is
 * Y, so that rotation is not the physical radiator joint. They keep their
 * authored pose.
 */

export type Vec3 = readonly [number, number, number];

/** SARJ-driven outboard trusses. */
export const TRUSS_JOINTS = ['P4', 'S4'] as const;
export type TrussJoint = (typeof TRUSS_JOINTS)[number];

/** The eight solar-array wing nodes, named for the truss segment that carries them. */
export const ARRAY_JOINTS = ['P4_01', 'P4_02', 'P6_01', 'P6_02', 'S4_01', 'S4_02', 'S6_01', 'S6_02'] as const;
export type ArrayJoint = (typeof ARRAY_JOINTS)[number];

/**
 * Joint angles in radians, in the model's own axes (see the file comment).
 * Partial: a joint left out keeps its authored rest pose.
 */
export interface IssJointAngles {
  truss?: Partial<Record<TrussJoint, number>>;
  arrays?: Partial<Record<ArrayJoint, number>>;
}

/** Wrap to (-PI, PI]. SARJ and BGA are continuous joints; the wrap is not a limit. */
export function wrapAngle(rad: number): number {
  const twoPi = 2 * Math.PI;
  let a = rad % twoPi;
  if (a > Math.PI) a -= twoPi;
  else if (a <= -Math.PI) a += twoPi;
  return a;
}

/**
 * Truss and array angles that point the arrays at a Sun direction.
 *
 * `sunLocal` is the direction to the Sun in model-local axes (need not be
 * normalised). Rotating a truss about X by `truss` carries local +Y to
 * (0, cos, sin), so `truss = atan2(z, y)` puts +Y in the plane of the Sun
 * vector and the X axis. In that rotated frame the Sun has components
 * (x, y cos + z sin), and rotating an array about Z by `array` carries +Y to
 * (-sin, cos), so `array = -atan2(x, y')` finishes the alignment: the array
 * normal ends up on the Sun line.
 *
 * The same pair of angles is used for every wing: all share one axis
 * direction in this model. Returns `undefined` for a zero or non-finite Sun
 * vector so a caller can report it rather than move joints to arbitrary
 * angles.
 */
export function sunTrackingAngles(sunLocal: Vec3): { truss: number; array: number } | undefined {
  const [x, y, z] = sunLocal;
  if (![x, y, z].every(Number.isFinite) || Math.hypot(x, y, z) === 0) return undefined;
  const truss = Math.atan2(z, y);
  const inPlane = y * Math.cos(truss) + z * Math.sin(truss);
  const array = -Math.atan2(x, inPlane);
  return { truss: wrapAngle(truss), array: wrapAngle(array) };
}

/** Expand the shared Sun-tracking pair to every joint. */
export function sunTrackingJointAngles(sunLocal: Vec3): IssJointAngles | undefined {
  const a = sunTrackingAngles(sunLocal);
  if (!a) return undefined;
  return {
    truss: Object.fromEntries(TRUSS_JOINTS.map((j) => [j, a.truss])),
    arrays: Object.fromEntries(ARRAY_JOINTS.map((j) => [j, a.array])),
  };
}

/** Rotate a vector about local +X by `angle`, as a rotated frame would carry it. */
export function rotateAboutX(v: Vec3, angle: number): [number, number, number] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

/** Rotate a vector about local +Z by `angle`. */
export function rotateAboutZ(v: Vec3, angle: number): [number, number, number] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/**
 * Where the array normal (local +Y of a wing) points, in model-local axes,
 * for a truss/array angle pair: the forward composition the inverse above is
 * checked against.
 */
export function arrayNormal(trussAngle: number, arrayAngle: number): [number, number, number] {
  return rotateAboutX(rotateAboutZ([0, 1, 0], arrayAngle), trussAngle);
}
