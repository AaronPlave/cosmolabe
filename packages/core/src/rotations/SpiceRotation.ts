import type { SpiceInstance } from '@cosmolabe/spice';
import type { Quaternion, RotationModel } from './RotationModel.js';

export class SpiceRotation implements RotationModel {
  constructor(
    private readonly spice: SpiceInstance,
    private readonly bodyFixedFrame: string,
    private readonly inertialFrame: string = 'ECLIPJ2000',
  ) {}

  rotationAt(et: number): Quaternion {
    const m = this.spice.pxform(this.inertialFrame, this.bodyFixedFrame, et);
    return rotationMatrixToQuaternion(m);
  }
}

function rotationMatrixToQuaternion(m: [number, number, number, number, number, number, number, number, number]): Quaternion {
  // m is row-major 3x3: [m00, m01, m02, m10, m11, m12, m20, m21, m22]
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return [0.25 / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
}
