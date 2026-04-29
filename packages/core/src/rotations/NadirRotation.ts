import type { SpiceInstance } from '@cosmolabe/spice';
import type { Quaternion, RotationModel } from './RotationModel.js';

/**
 * Computes nadir-pointing orientation from the spacecraft's state vector.
 * The body frame axes are defined as:
 *   Z = nadir (from spacecraft toward center body)
 *   Y = orbit normal (perpendicular to orbit plane)
 *   X = along-track (completes right-handed frame, roughly velocity direction)
 *
 * This is the standard LVLH (Local Vertical Local Horizontal) frame,
 * appropriate for nadir-pointing spacecraft like LRO, MRO, etc.
 */
export class NadirRotation implements RotationModel {
  constructor(
    private readonly spice: SpiceInstance,
    private readonly target: string,
    private readonly center: string,
    private readonly inertialFrame: string = 'ECLIPJ2000',
  ) {}

  rotationAt(et: number): Quaternion {
    const { state } = this.spice.spkezr(this.target, et, this.inertialFrame, 'NONE', this.center);
    const [rx, ry, rz, vx, vy, vz] = state;

    // Z-axis = nadir (from spacecraft toward center body)
    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rLen < 1e-20) return [1, 0, 0, 0]; // degenerate
    const zx = -rx / rLen, zy = -ry / rLen, zz = -rz / rLen;

    // Y-axis = orbit normal = normalize(z × v)
    let yx = zy * vz - zz * vy;
    let yy = zz * vx - zx * vz;
    let yz = zx * vy - zy * vx;
    const yLen = Math.sqrt(yx * yx + yy * yy + yz * yz);
    if (yLen < 1e-20) return [1, 0, 0, 0]; // degenerate (velocity parallel to nadir)
    yx /= yLen; yy /= yLen; yz /= yLen;

    // X-axis = along-track = y × z
    const xx = yy * zz - yz * zy;
    const xy = yz * zx - yx * zz;
    const xz = yx * zy - yy * zx;

    // Convert rotation matrix (inertial → body, row-major) to quaternion
    return matToQuat(xx, xy, xz, yx, yy, yz, zx, zy, zz);
  }
}

/** Convert 3×3 row-major rotation matrix to quaternion [w, x, y, z] (Shepperd's method) */
function matToQuat(
  m00: number, m01: number, m02: number,
  m10: number, m11: number, m12: number,
  m20: number, m21: number, m22: number,
): Quaternion {
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
