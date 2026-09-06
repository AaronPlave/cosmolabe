/**
 * Capture utilities — small helpers around the ScreenshotPlugin and
 * VideoRecordPlugin so UI components can trigger them without reaching
 * through `renderer.getPlugins().find(...)` themselves.
 */
import type { UniverseRenderer } from '@cosmolabe/three';
import { VideoRecordPlugin, captureFilename, captureFrameDataUrl, downloadDataUrl } from '@cosmolabe/three';

export { captureFilename, captureFrameDataUrl, downloadDataUrl };

export function takeScreenshot(renderer: UniverseRenderer): void {
  const plugin = renderer.getPlugins().find((p) => p.name === 'screenshot');
  const cmd = plugin?.ui?.commands?.find((c) => c.id === 'screenshot');
  cmd?.execute(renderer.getContext());
}

function getVideoPlugin(renderer: UniverseRenderer): VideoRecordPlugin | undefined {
  return renderer.getPlugins().find((p): p is VideoRecordPlugin => p instanceof VideoRecordPlugin);
}

export function isRecordingVideo(renderer: UniverseRenderer): boolean {
  return getVideoPlugin(renderer)?.isRecording ?? false;
}

export function toggleVideoRecording(renderer: UniverseRenderer): boolean {
  const plugin = getVideoPlugin(renderer);
  if (!plugin) return false;
  if (plugin.isRecording) plugin.stop();
  else plugin.start(renderer.getContext().canvas);
  return plugin.isRecording;
}

/**
 * Set the recording state directly.
 *
 * `toggleVideoRecording` cannot back a `record on|off` verb, and not because it
 * is inconvenient: a toggle run twice is a no-op, so a script that stops and
 * restarts leaves the recorder inverted, and re-running the same script over an
 * already-recording session turns recording *off*. Idempotent in both
 * directions is the only shape a verb can use.
 *
 * Returns whether the recorder is now recording, which is not always what was
 * asked for: `VideoRecordPlugin.start` declines where `MediaRecorder` or
 * `canvas.captureStream` is missing.
 */
export function setVideoRecording(renderer: UniverseRenderer, on: boolean): boolean {
  const plugin = getVideoPlugin(renderer);
  if (!plugin) return false;
  if (on && !plugin.isRecording) plugin.start(renderer.getContext().canvas);
  else if (!on && plugin.isRecording) plugin.stop();
  return plugin.isRecording;
}
