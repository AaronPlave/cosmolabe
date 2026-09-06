import type { RendererPlugin } from '../RendererPlugin.js';
import type { PluginUISlots } from '../PluginUI.js';
import { captureFilename, captureFrameDataUrl, downloadDataUrl } from '../../scripting/captureFrame.js';

/**
 * Stock plugin that adds a "Save screenshot" command to the command palette.
 * Captures the WebGL canvas as a PNG and triggers a download.
 */
export class ScreenshotPlugin implements RendererPlugin {
  readonly name = 'screenshot';

  readonly ui: PluginUISlots = {
    commands: [
      {
        id: 'screenshot',
        label: 'Save screenshot',
        category: 'Capture',
        // The render-then-read pair, and why each half is the way it is, live
        // in `captureFrameDataUrl`. This was one of the two copies of it.
        execute: (ctx) => downloadDataUrl(captureFrameDataUrl(ctx), captureFilename('png')),
      },
    ],
  };
}
