export type Quaternion = [number, number, number, number]; // [w, x, y, z]

export interface RotationModel {
  rotationAt(et: number): Quaternion;
}
