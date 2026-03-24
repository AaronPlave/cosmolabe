import type { Quaternion, RotationModel } from './RotationModel.js';

/**
 * Fixed rotation from an Euler angle sequence.
 *
 * Cosmographia catalog form:
 *   { type: "FixedEuler", sequence: "XYZ", angles: [10, 20, 30] }
 *
 * Angles are in degrees in the catalog. The sequence string specifies the
 * rotation axes (e.g. "XYZ", "ZXZ", "YZX"). The resulting quaternion is
 * the composition R_seq[0](angles[0]) * R_seq[1](angles[1]) * ...
 */
export class FixedEulerRotation implements RotationModel {
  private readonly q: Quaternion;

  constructor(sequence: string, anglesDeg: number[]) {
    this.q = composeEuler(sequence, anglesDeg);
  }

  rotationAt(_et: number): Quaternion {
    return [...this.q] as Quaternion;
  }
}

function axisRotationQuat(axis: string, angleDeg: number): Quaternion {
  const rad = angleDeg * Math.PI / 180;
  const c = Math.cos(rad / 2);
  const s = Math.sin(rad / 2);
  switch (axis.toUpperCase()) {
    case 'X': return [c, s, 0, 0];
    case 'Y': return [c, 0, s, 0];
    case 'Z': return [c, 0, 0, s];
    default: return [1, 0, 0, 0];
  }
}

function multiplyQuat(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

function composeEuler(sequence: string, anglesDeg: number[]): Quaternion {
  let q: Quaternion = [1, 0, 0, 0];
  for (let i = 0; i < sequence.length && i < anglesDeg.length; i++) {
    q = multiplyQuat(q, axisRotationQuat(sequence[i], anglesDeg[i]));
  }
  return q;
}
