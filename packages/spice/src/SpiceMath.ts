import type { Vec3, RotationMatrix } from './types.js';

export interface SpiceMath {
  mxv(matrix: RotationMatrix, vin: Vec3): Vec3;
  mtxv(matrix: RotationMatrix, vin: Vec3): Vec3;
  vcrss(v1: Vec3, v2: Vec3): Vec3;
  vnorm(v: Vec3): number;
  vdot(v1: Vec3, v2: Vec3): number;
  vhat(v: Vec3): Vec3;
  vsub(v1: Vec3, v2: Vec3): Vec3;
  vadd(v1: Vec3, v2: Vec3): Vec3;
  vscl(s: number, v: Vec3): Vec3;
}
