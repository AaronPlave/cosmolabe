import type { Vec3, RotationMatrix } from '@cosmolabe/spice';

export interface Frame {
  readonly name: string;
  toInertial(et: number): RotationMatrix;
}

/** Apply rotation matrix to vector (row-major 3x3 * vec3) */
export function transformVector(matrix: RotationMatrix, v: Vec3): Vec3 {
  return [
    matrix[0] * v[0] + matrix[1] * v[1] + matrix[2] * v[2],
    matrix[3] * v[0] + matrix[4] * v[1] + matrix[5] * v[2],
    matrix[6] * v[0] + matrix[7] * v[1] + matrix[8] * v[2],
  ];
}
