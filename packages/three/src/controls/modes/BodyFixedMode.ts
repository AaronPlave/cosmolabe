import { CameraModeName } from '../CameraModes.js';
import { bodyRotationFrame, spiceFrame } from '../frameOrientation.js';
import { FrameLockedMode } from './FrameLockedMode.js';

/**
 * Body-Fixed Camera (Celestia-style Sync Orbit).
 * Camera co-rotates with the body so surface features stay fixed.
 * TrackballControls active for orbit/zoom in the rotating frame.
 *
 * A `FrameLockedMode` following the body's own rotation model — the same
 * body→world composition the mesh renders with, obliquity included — or, when
 * `frameName` is given, that SPICE frame instead.
 */
export class BodyFixedMode extends FrameLockedMode {
  constructor() {
    super({
      name: CameraModeName.BODY_FIXED,
      behavior: 'corotate',
      allowsKeyboard: false,
      resolveFrame: (ctx, params) => {
        const bodyName = params.bodyName ?? '';
        return params.frameName
          ? spiceFrame(params.frameName, ctx.bodyMeshes.get(bodyName)?.frames)
          : bodyRotationFrame(bodyName);
      },
    });
  }
}
