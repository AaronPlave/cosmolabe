import type { RotationMatrix, Vec3 } from '../spice-injection.js';
import type { Quaternion } from '../rotations/RotationModel.js';

/**
 * Row-major 3x3 helpers for the frame registry. Every frame rotation in
 * `FrameRegistry` is one of these, stated as "vectors in frame A → vectors in
 * frame B" (the SPICE `pxform` convention), so composition is plain matrix
 * multiplication and inversion is a transpose.
 */

export const IDENTITY3: RotationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** a · b (apply b first, then a). */
export function mat3Mul(a: RotationMatrix, b: RotationMatrix): RotationMatrix {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

export function mat3Transpose(m: RotationMatrix): RotationMatrix {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mat3Vec(m: RotationMatrix, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Frame (passive) rotation about X by `a` radians: the matrix that re-expresses
 *  a vector in axes rotated by +a. SPICE `rotate_c(a, 1)`, Vallado's ROT1. */
export function rotX(a: number): RotationMatrix {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, s, 0, -s, c];
}

/** Frame (passive) rotation about Y. SPICE `rotate_c(a, 2)`, ROT2. */
export function rotY(a: number): RotationMatrix {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
}

/** Frame (passive) rotation about Z. SPICE `rotate_c(a, 3)`, ROT3. */
export function rotZ(a: number): RotationMatrix {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** Rotation matrix of a unit quaternion `[w, x, y, z]`, as the active rotation
 *  `rotateVecByQuat` applies (v' = q v q*). */
export function quatToMat3(q: Quaternion): RotationMatrix {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** Unit quaternion `[w, x, y, z]` of a proper rotation matrix (Shepperd's method). */
export function mat3ToQuat(m: RotationMatrix): Quaternion {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  // Canonical hemisphere (w >= 0) so equal rotations compare equal.
  return w < 0 ? [-w, -x, -y, -z] : [w, x, y, z];
}
