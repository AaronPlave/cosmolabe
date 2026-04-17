import { CameraModeName, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';

/**
 * Full-Screen Instrument Camera mode.
 * Renders the instrument sensor's boresight view as the main viewport instead of PiP.
 * The actual camera positioning is handled by InstrumentView.update() — this mode
 * signals to the renderer that the instrument camera should be used for the main pass.
 */
export class InstrumentMode implements ICameraMode {
  readonly name = CameraModeName.INSTRUMENT;
  readonly allowsOrbitControls = false;
  readonly allowsKeyboard = false;

  sensorName = '';

  activate(_ctx: CameraModeContext, params: CameraModeParams): void {
    this.sensorName = params.sensorName ?? '';
  }

  update(_ctx: CameraModeContext): void {
    // Camera positioning is delegated to InstrumentView.update() in the renderer.
    // This mode just flags that instrument camera should be the main render camera.
  }

  deactivate(_ctx: CameraModeContext): void {
    this.sensorName = '';
  }
}
