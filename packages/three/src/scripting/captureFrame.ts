/**
 * Render one frame and read it back as a PNG data URL.
 *
 * This pair existed twice before this file — in `ScreenshotPlugin` and in
 * `loader.ts`'s `?test=1` capture hook — and a script host would have been the
 * third copy. Both halves matter and neither is obvious:
 *
 * - `renderFrame()` first, because it is the full multi-pass render. A single
 *   `webglRenderer.render(scene, camera)` overwrites the composite with just
 *   pass 1, so tiles, models, markers and bloom are missing from the picture.
 * - `toDataURL` and not the async `toBlob`, because the renderer is created
 *   without `preserveDrawingBuffer`: the next animation frame can clear the
 *   backing store before an async encoder ever reads it. The synchronous read
 *   is the one that is safe.
 */

/** The part of a renderer a capture touches. `RendererContext` satisfies it. */
export interface CaptureHost {
  readonly canvas: HTMLCanvasElement;
  renderFrame(): void;
}

/** Render synchronously and return the frame as a `data:image/png;base64,…` URL. */
export function captureFrameDataUrl(host: CaptureHost): string {
  host.renderFrame();
  return host.canvas.toDataURL('image/png');
}

/** `cosmolabe-2004-10-26T15-30-00.png` — a timestamped name for a capture. */
export function captureFilename(extension: string, label?: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const suffix = label ? `-${label.replace(/[^\w.-]+/g, '_')}` : '';
  return `cosmolabe-${stamp}${suffix}.${extension}`;
}

/** Hand a data URL to the browser as a download. */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}
