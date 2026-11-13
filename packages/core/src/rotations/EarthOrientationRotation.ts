import type { Quaternion, RotationModel } from './RotationModel.js';
import { j2000ToEarthFixed } from '../frames/earthOrientation.js';
import { mat3ToQuat } from '../frames/mat3.js';

/**
 * Earth's body-fixed orientation for SPICE-free scenes, from the same
 * analytical precession, nutation and GMST the frame registry uses for its
 * SPICE-free ITRF (see `earthOrientation.ts`). The constant-rate IAU_EARTH
 * model leaves precession out, which by 2026 puts the prime meridian about
 * 0.4° away from where an Earth-fixed position says it is.
 *
 * Polar motion is neglected, so this realizes PEF rather than ITRF. It
 * declares no `bodyFixedFrame`: like the IAU fallback it replaces, it is the
 * drawn globe that a SPICE-free `IAU_EARTH` resolves through, so surface
 * points stay on it.
 */
export class EarthOrientationRotation implements RotationModel {
  readonly sourceFrame = 'EquatorJ2000';

  rotationAt(et: number): Quaternion {
    return mat3ToQuat(j2000ToEarthFixed(et));
  }
}
