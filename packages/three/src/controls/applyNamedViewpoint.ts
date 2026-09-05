/**
 * The one place a named viewpoint is applied.
 *
 * Three call sites used to hand-roll this — the viewer's initial
 * `defaultViewpoint`, its Viewpoint dropdown, and the `?test=1` capture hook —
 * and they had already drifted apart. That mattered once viewpoints grew an
 * `epoch`: a catalog viewpoint called "Huygens Landing (2005-01-14)" has to
 * actually put the clock at that landing, and it has to do so however the user
 * reached it. Applying it from two of the three sites would have been worse
 * than not applying it at all.
 *
 * Written against a structural slice of `UniverseRenderer` rather than the
 * class, so the rule it encodes — seek only when the viewpoint declares an
 * epoch — is testable without a WebGL context.
 */
import type { BodyMesh } from '../BodyMesh.js';
import type { CameraViewpoint } from './CameraController.js';

/** The part of `UniverseRenderer` applying a viewpoint touches. */
export interface ViewpointHost {
  cameraController: {
    getViewpoint(name: string): CameraViewpoint | undefined;
    applyViewpoint(vp: CameraViewpoint): void;
    goToViewpoint(name: string, duration?: number): boolean;
    track(bodyMesh: BodyMesh | null): void;
  };
  timeController: {
    setTime(et: number): void;
  };
  getBodyMesh(name: string): BodyMesh | undefined;
}

export interface ApplyViewpointOptions {
  /** Fly the camera over instead of cutting to it. Ignored for a viewpoint
   *  that tracks a body, which has always cut. Default false. */
  animate?: boolean;
  /** Fly-to duration in seconds when `animate` is set. Default 1.0. */
  duration?: number;
}

/**
 * Apply the registered viewpoint `name`: seek the clock to its epoch if it
 * declares one, then move the camera. Returns false if no such viewpoint.
 *
 * The clock moves first so the frame that follows is composed at the epoch the
 * viewpoint names, not one frame behind it.
 */
export function applyNamedViewpoint(
  host: ViewpointHost,
  name: string,
  opts: ApplyViewpointOptions = {},
): boolean {
  const vp = host.cameraController.getViewpoint(name);
  if (!vp) return false;

  // `undefined`, not falsy: ET 0 is J2000, a perfectly good epoch to ask for.
  if (vp.epoch !== undefined) host.timeController.setTime(vp.epoch);

  if (vp.trackBody) {
    const bm = host.getBodyMesh(vp.trackBody);
    if (bm) {
      host.cameraController.track(bm);
      host.cameraController.applyViewpoint(vp);
      // A viewpoint with an explicit target wants the camera aimed there, not
      // orbit-locked to the body, so tracking is released once positioned.
      if (vp.target.lengthSq() > 1e-30) host.cameraController.track(null);
    }
  } else if (opts.animate) {
    host.cameraController.goToViewpoint(name, opts.duration ?? 1.0);
  } else {
    host.cameraController.applyViewpoint(vp);
  }
  return true;
}
