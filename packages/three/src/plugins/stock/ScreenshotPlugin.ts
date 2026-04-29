import type { RendererPlugin } from '../RendererPlugin.js';
import type { PluginUISlots } from '../PluginUI.js';

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
        execute: (ctx) => {
          const canvas = ctx.canvas;
          const renderer = ctx.webglRenderer;

          // Force a render to ensure the canvas has current content
          renderer.render(ctx.scene, ctx.camera);

          canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cosmolabe-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
            a.click();
            URL.revokeObjectURL(url);
          }, 'image/png');
        },
      },
    ],
  };
}
