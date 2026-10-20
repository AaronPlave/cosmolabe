import { CameraModeName } from '../CameraModes.js';
import { lvlhFrame } from '../frameOrientation.js';
import { FrameLockedMode, type AxisBasis } from './FrameLockedMode.js';

/**
 * LVLH look axes, in LVLH frame coordinates (X = along-track, Y = orbit normal,
 * Z = nadir — see `lvlhFrame`). The labels keep the mode's established meaning:
 * '-Z' looks down at nadir, '+Z' up at zenith, ±X along/against the velocity,
 * ±Y along/against the orbit normal; up is along-track when looking vertically
 * and zenith otherwise.
 */
const LVLH_AXIS_BASIS: AxisBasis = {
  '-Z': { forward: [0, 0, 1], up: [1, 0, 0] },
  '+Z': { forward: [0, 0, -1], up: [1, 0, 0] },
  '+X': { forward: [1, 0, 0], up: [0, 0, -1] },
  '-X': { forward: [-1, 0, 0], up: [0, 0, -1] },
  '+Y': { forward: [0, 1, 0], up: [0, 0, -1] },
  '-Y': { forward: [0, -1, 0], up: [0, 0, -1] },
};

/**
 * LVLH (Local Vertical Local Horizontal) Camera.
 * Camera aligned to the orbital frame: nadir is "down", velocity is "forward".
 * Computed purely from the orbit (SPK), no CK attitude data needed.
 *
 * A `FrameLockedMode` attached to the spacecraft, following `lvlhFrame`.
 */
export class LvlhMode extends FrameLockedMode {
  constructor() {
    super({
      name: CameraModeName.LVLH,
      behavior: 'attached',
      axisBasis: LVLH_AXIS_BASIS,
      resolveFrame: (_ctx, params) => lvlhFrame(params.bodyName ?? '', params.centerBodyName ?? ''),
    });
  }
}
