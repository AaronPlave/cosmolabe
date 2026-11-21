import { CameraModeName } from '@cosmolabe/three';
import { vs } from './viewer-state.svelte';

/** The camera's frame in words, for the view-context HUD and the Camera panel alike. */
export function cameraFrameLabel(): string {
  if (vs.cameraMode === CameraModeName.FREE_ORBIT) return vs.surfaceTarget ? 'Surface orbit' : 'Free orbit';
  const mode = vs.cameraMode.replaceAll('-', ' ');
  return vs.trackedBodyName ? `${vs.trackedBodyName} ${mode}` : mode;
}
