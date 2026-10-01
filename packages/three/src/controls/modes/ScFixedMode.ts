import { CameraModeName } from '../CameraModes.js';
import { bodyRotationFrame, spiceFrame } from '../frameOrientation.js';
import { FrameLockedMode } from './FrameLockedMode.js';

/**
 * Spacecraft-Locked Camera (KSP "Locked" mode).
 *
 * Camera orbits around the body, and the orbit frame co-rotates with the body's
 * attitude. TrackballControls active for orbit/zoom, WASD for translation,
 * all in the rotating frame.
 *
 * A `FrameLockedMode` whose frame is the body's own rotation model via
 * `bodyWorldOrientation`, the same body→world composition `BodyMesh` renders
 * with — so the camera tracks the spacecraft exactly, whether the rotation is a
 * SPICE CK, a TLE attitude, or a catalog rotation, and without a
 * J2000/ecliptic obliquity mismatch. `frameName` (e.g. `LRO_SC_BUS`) locks to
 * that SPICE frame instead.
 */
export class ScFixedMode extends FrameLockedMode {
  constructor() {
    super({
      name: CameraModeName.SC_FIXED,
      behavior: 'corotate',
      allowsKeyboard: true,
      resolveFrame: (ctx, params) => {
        const bodyName = params.bodyName ?? '';
        return params.frameName
          ? spiceFrame(params.frameName, ctx.bodyMeshes.get(bodyName)?.frames)
          : bodyRotationFrame(bodyName);
      },
    });
  }
}
