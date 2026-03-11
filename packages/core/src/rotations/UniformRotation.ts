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
    const angle = this.meridianAngle + (2 * Math.PI / this.period) * dt;

    // Build quaternion for rotation about the pole axis
    // First, pole direction in inertial frame
    const cosDec = Math.cos(this.poleDec);
    const poleX = cosDec * Math.cos(this.poleRA);
    const poleY = cosDec * Math.sin(this.poleRA);
    const poleZ = Math.sin(this.poleDec);

    // Quaternion from axis-angle
    const halfAngle = angle / 2;
    const sinHalf = Math.sin(halfAngle);
    return [
      Math.cos(halfAngle),
      poleX * sinHalf,
      poleY * sinHalf,
      poleZ * sinHalf,
    ];
  }
}
