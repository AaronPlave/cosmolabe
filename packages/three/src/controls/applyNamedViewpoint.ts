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
 * class, so the rules it encodes — seek only when the viewpoint declares an
 * epoch, resolve at the epoch the view is shown at — are testable without a
 * WebGL context.
 */
import type { BodyMesh } from '../BodyMesh.js';
import type { CameraViewpoint } from './CameraController.js';
import { resolveCameraViewpoint } from './catalogViewpoint.js';

/** The part of `UniverseRenderer` applying a viewpoint touches. */
export interface ViewpointHost {
  cameraController: {
    getViewpoint(name: string): CameraViewpoint | undefined;
    applyViewpoint(vp: CameraViewpoint): void;
    flyToViewpoint(vp: CameraViewpoint, duration?: number): void;
    track(bodyMesh: BodyMesh | null): void;
    lookAt(bodyMesh: BodyMesh | null): void;
  };
  timeController: {
    readonly et: number;
    setTime(et: number): void;
  };
  camera: {
    fov: number;
    updateProjectionMatrix(): void;
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
 * declares one, then establish the view — camera, tracked and look-at bodies,
 * FOV. Returns false if there is no such viewpoint, or if it cannot be
 * resolved at that epoch (an unknown body, a body with no position then);
 * nothing is changed in that case.
 *
 * The pose is resolved at the viewpoint's epoch, or at the current time for a
 * viewpoint that names none, so a timeless "over Jezero" view still looks at
 * Jezero after the clock has moved. The clock moves before the camera so the
 * frame that follows is composed at that epoch, not one frame behind it.
 */
export function applyNamedViewpoint(
  host: ViewpointHost,
  name: string,
  opts: ApplyViewpointOptions = {},
): boolean {
  const stored = host.cameraController.getViewpoint(name);
  if (!stored) return false;

  // `undefined`, not falsy: ET 0 is J2000, a perfectly good epoch to ask for.
  let vp: CameraViewpoint;
  try {
    vp = resolveCameraViewpoint(stored, stored.epoch ?? host.timeController.et);
  } catch (err) {
    console.warn(`[Cosmolabe] Viewpoint "${name}": ${(err as Error).message}`);
    return false;
  }
  if (vp.epoch !== undefined) host.timeController.setTime(vp.epoch);

  // A viewpoint establishes the whole view: a look-at left from earlier
  // navigation would otherwise override the orientation it names.
  host.cameraController.lookAt(null);
  if (vp.fov !== undefined) {
    host.camera.fov = vp.fov;
    host.camera.updateProjectionMatrix();
  }

  if (vp.trackBody) {
    const bm = host.getBodyMesh(vp.trackBody);
    if (bm) {
      host.cameraController.track(bm);
      host.cameraController.applyViewpoint(vp);
      const lookAt = vp.lookAtBody ? host.getBodyMesh(vp.lookAtBody) : undefined;
      if (lookAt) {
        // Stay with the center and keep the look-at body in view as time runs.
        host.cameraController.lookAt(lookAt);
      } else if (vp.target.lengthSq() > 1e-30) {
        // A viewpoint with an explicit target wants the camera aimed there,
        // not orbit-locked to the body, so tracking is released once positioned.
        host.cameraController.track(null);
      }
    }
  } else if (opts.animate) {
    host.cameraController.flyToViewpoint(vp, opts.duration ?? 1.0);
  } else {
    host.cameraController.applyViewpoint(vp);
  }
  return true;
}
