import type { Quaternion, RotationModel } from './RotationModel.js';

export class UniformRotation implements RotationModel {
  constructor(
    private readonly period: number,       // seconds
    private readonly epoch: number,        // ET reference time
    private readonly meridianAngle: number, // radians at epoch
    private readonly poleRA: number,        // radians
    private readonly poleDec: number,       // radians
  ) {}

  rotationAt(et: number): Quaternion {
    const dt = et - this.epoch;
    const W = this.meridianAngle + (2 * Math.PI / this.period) * dt;

    // Body→inertial rotation: R_b2i = Rz(90°+RA) · Rx(90°-Dec) · Rz(W)
    // This places the pole at (RA, Dec) and spins by W.
    // Quaternion composition matches matrix order: q_b2i = Q3 * Q2 * Q1
    //   Q1 = Qz(W),        Q2 = Qx(90°-Dec),    Q3 = Qz(90°+RA)
    // Then conjugate to get inertial→body-fixed (what this function returns).

    const a1 = W / 2;
    const a2 = (Math.PI / 2 - this.poleDec) / 2;
    const a3 = (Math.PI / 2 + this.poleRA) / 2;

    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const c2 = Math.cos(a2), s2 = Math.sin(a2);

    // Q2 * Q1: [c2,s2,0,0] * [c1,0,0,s1]
    const iw = c2 * c1;
    const ix = s2 * c1;
    const iy = -s2 * s1;
    const iz = c2 * s1;

    // Q3 * (Q2*Q1): [c3,0,0,s3] * [iw,ix,iy,iz]
    const c3 = Math.cos(a3), s3 = Math.sin(a3);
    const bw = c3 * iw - s3 * iz;
    const bx = c3 * ix - s3 * iy;
    const by = c3 * iy + s3 * ix;
    const bz = c3 * iz + s3 * iw;

    // Conjugate: body→inertial → inertial→body-fixed
    return [bw, -bx, -by, -bz];
  }
}
