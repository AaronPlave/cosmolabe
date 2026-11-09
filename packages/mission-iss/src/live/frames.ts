/**
 * Attitude frame composition for the live ISS (#371): LVLH from an orbit
 * state, and composing a telemetry quaternion into the reference-to-body
 * convention MissionState expects.
 *
 * Quaternions are scalar-first [w, x, y, z] and describe *coordinate*
 * transforms: `v_to = q v_from q*`. Matrices are row-major 3x3.
 *
 * The LVLH convention below (X along the velocity component perpendicular to
 * the radius, Z toward the Earth's centre, Y = Z x X) is the standard ISS
 * body-axes convention, but whether the Lightstreamer quaternion is stated
 * relative to LVLH, to J2000, and in which direction, is NOT confirmed here
 * (see docs): the caller states it explicitly in the configuration.
 */
import type { Vec3 } from '../joints.js';

export type Quat = [number, number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: Vec3): Vec3 | undefined => { const n = Math.hypot(...a); return n > 0 && Number.isFinite(n) ? scale(a, 1 / n) : undefined; };

/** LVLH axes (x forward, y = z x x, z nadir) expressed in the inertial frame of `position`/`velocity`. */
export function lvlhAxes(position: Vec3, velocity: Vec3): { x: Vec3; y: Vec3; z: Vec3 } | undefined {
  const z = unit(scale(position, -1));
  if (!z) return undefined;
  const x = unit(sub(velocity, scale(z, dot(velocity, z))));
  if (!x) return undefined; // velocity parallel to the radius: LVLH is undefined
  return { x, y: cross(z, x), z };
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export const quatConjugate = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];

export function quatNormalize(q: Quat): Quat | undefined {
  const n = Math.hypot(...q);
  return n > 0 && Number.isFinite(n) ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : undefined;
}

/** Rotate coordinates: `q v q*`. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const p = quatMultiply(quatMultiply(q, [0, v[0], v[1], v[2]]), quatConjugate(q));
  return [p[1], p[2], p[3]];
}

/** Quaternion of a rotation matrix whose action `v_to = M v_from` (Shepperd). */
export function matrixToQuat(m: readonly [Vec3, Vec3, Vec3]): Quat {
  const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = m;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [0.25 / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  return quatNormalize(q)!;
}

/** The inertial-to-LVLH coordinate transform (rows are the LVLH axes). */
export function inertialToLvlh(position: Vec3, velocity: Vec3): Quat | undefined {
  const a = lvlhAxes(position, velocity);
  return a && matrixToQuat([a.x, a.y, a.z]);
}

export interface TelemetryAttitudeConvention {
  /** What the telemetry quaternion is relative to. */
  reference: 'LVLH' | 'inertial';
  /** `reference-to-body`: v_body = q v_ref q*. `body-to-reference` is its conjugate. */
  direction: 'reference-to-body' | 'body-to-reference';
}

/**
 * Compose a telemetry quaternion into inertial-to-body (the sense MissionState
 * reads with `direction: 'reference-to-body'`).
 *
 * For an inertial telemetry quaternion this is just the direction fix. For an
 * LVLH one it needs the orbit state at the same instant: v_body = q_tel
 * (v_lvlh) and v_lvlh = Q_inertial-to-LVLH v_inertial.
 */
export function telemetryToInertialToBody(
  telemetry: Quat,
  convention: TelemetryAttitudeConvention,
  state?: { position: Vec3; velocity: Vec3 },
): Quat | undefined {
  const q = quatNormalize(telemetry);
  if (!q) return undefined;
  const refToBody = convention.direction === 'reference-to-body' ? q : quatConjugate(q);
  if (convention.reference === 'inertial') return refToBody;
  if (!state) return undefined;
  const toLvlh = inertialToLvlh(state.position, state.velocity);
  return toLvlh && quatNormalize(quatMultiply(refToBody, toLvlh));
}

/**
 * The fixed rotation from the NASA ISS model's own axes to the station body
 * axes (X forward, Y starboard, Z nadir), as `meshRotation` [w, x, y, z].
 * Derived from the inspected node layout (model +Z forward, +Y zenith, +X
 * port): model coordinates (x, y, z) are body coordinates (z, -x, -y).
 */
export const ISS_MODEL_TO_BODY: Quat = (() => {
  const m: [Vec3, Vec3, Vec3] = [[0, 0, 1], [-1, 0, 0], [0, -1, 0]];
  const q = matrixToQuat(m);
  return q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
})();
