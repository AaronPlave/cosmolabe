import { CameraModeName, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';

/**
 * Default camera mode — wraps the existing free-orbit behavior.
 * TrackballControls handles orbit/zoom, keyboard handles translation/roll.
 * This mode is a no-op: CameraController's existing update() logic handles everything.
 */
export class FreeOrbitMode implements ICameraMode {
  readonly name = CameraModeName.FREE_ORBIT;
  readonly allowsOrbitControls = true;
  readonly allowsKeyboard = true;

  activate(_ctx: CameraModeContext, _params: CameraModeParams): void {
    // Nothing to do — existing CameraController state is already correct
  }

  update(_ctx: CameraModeContext): void {
    // No-op: CameraController.update() handles tracking, lookAt, free-look, etc.
  }

  deactivate(_ctx: CameraModeContext): void {
    // Nothing to clean up
  }
}
