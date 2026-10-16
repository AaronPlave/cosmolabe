import type { Quaternion, RotationModel } from './RotationModel.js';
import { poleRotation } from './UniformRotation.js';

const DEG = Math.PI / 180;

// IAU 2009 Moon orientation with its periodic terms (pck00011 BODY301_* and
// BODY3_NUT_PREC_ANGLES). The terms are the Moon's physical libration and
// carry its ~1.5° tilt to the ecliptic pole and ~±4° of prime meridian;
// without them the south pole sees the Sun pinned to the horizon all year.
// E_i = E0 + E1·T (degrees, T in Julian centuries from J2000).
const E0 = [125.045, 250.089, 260.008, 176.625, 357.529, 311.589, 134.963, 276.617, 34.226, 15.134, 119.743, 239.961, 25.053];
const E1 = [-1935.5364525, -3871.072905, 475263.3328725, 487269.629985, 35999.0509575, 964468.49931, 477198.869325, 12006.300765, 63863.5132425, -5806.6093575, 131.84064, 6003.1503825, 473327.79642];
const RA = [-3.8787, -0.1204, 0.07, -0.0172, 0, 0.0072, 0, 0, 0, -0.0052, 0, 0, 0.0043];
const DEC = [1.5419, 0.0239, -0.0278, 0.0068, 0, -0.0029, 0.0009, 0, 0, 0.0008, 0, 0, -0.0009];
const PM = [3.561, 0.1208, -0.0642, 0.0158, 0.0252, -0.0066, -0.0047, -0.0046, 0.0028, 0.0052, 0.004, 0.0019, -0.0044];

/** IAU_MOON for SPICE-free scenes: what CSPICE computes from pck00011. */
export class IauMoonRotation implements RotationModel {
  readonly sourceFrame = 'EquatorJ2000';

  rotationAt(et: number): Quaternion {
    const d = et / 86400, T = d / 36525;
    let ra = 269.9949 + 0.0031 * T;
    let dec = 66.5392 + 0.013 * T;
    let w = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d;
    for (let i = 0; i < E0.length; i++) {
      const e = (E0[i] + E1[i] * T) * DEG;
      ra += RA[i] * Math.sin(e);
      dec += DEC[i] * Math.cos(e);
      w += PM[i] * Math.sin(e);
    }
    return poleRotation(w * DEG, ra * DEG, dec * DEG);
  }
}
