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
import type { CameraViewpoint, ViewpointPose } from './CameraController.js';
import { resolveCameraViewpoint } from './catalogViewpoint.js';

/** The part of `UniverseRenderer` applying a viewpoint touches. */
export interface ViewpointHost {
  cameraController: {
    getViewpoint(name: string): CameraViewpoint | undefined;
    establishView(
      pose: ViewpointPose,
      opts: { origin: BodyMesh | null; track?: BodyMesh | null; lookAt?: BodyMesh | null; duration?: number },
    ): void;
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
  /** Fly the camera over instead of cutting to it. Only a viewpoint that
   *  keeps the current origin and tracks nothing can fly; the rest cut, as a
   *  tracking viewpoint always has. Default false. */
  animate?: boolean;
  /** Fly-to duration in seconds when `animate` is set. Default 1.0. */
  duration?: number;
}

/**
 * Apply the registered viewpoint `name`: seek the clock to its epoch if it
 * declares one, then establish the view — free orbit, coordinate origin,
 * tracked and look-at bodies, pose, FOV — whatever navigation came before.
 *
 * Returns false, having changed nothing, if there is no such viewpoint, if it
 * cannot be resolved at that epoch (an unknown body, a body with no position
 * then), or if a body it needs has no mesh in the scene. Every reference is
 * checked before the first change, so a refusal never leaves the clock moved
 * or the camera half-placed.
 *
 * The pose is resolved at the viewpoint's epoch, or at the current time for a
 * viewpoint that names none, so a timeless "over Jezero" view still looks at
 * Jezero after the clock has moved. Resolution is one-shot: the tracked center
 * then carries the camera with it and a `lookAt` body stays in view, but
 * directions such as "behind, along the velocity" are not re-derived as time
 * plays — that is what the live camera frames are for. The clock moves before
 * the camera so the frame that follows is composed at that epoch.
 */
export function applyNamedViewpoint(
  host: ViewpointHost,
  name: string,
  opts: ApplyViewpointOptions = {},
): boolean {
  const stored = host.cameraController.getViewpoint(name);
  if (!stored) return false;
  const refuse = (why: string) => {
    console.warn(`[Cosmolabe] Viewpoint "${name}": ${why}`);
    return false;
  };

  // `undefined`, not falsy: ET 0 is J2000, a perfectly good epoch to ask for.
  let vp: CameraViewpoint;
  try {
    vp = resolveCameraViewpoint(stored, stored.epoch ?? host.timeController.et);
  } catch (err) {
    return refuse((err as Error).message);
  }

  // The renderer side of every reference, before anything changes.
  const mesh = (body: string | null | undefined): BodyMesh | null | false => {
    if (!body) return null;
    return host.getBodyMesh(body) ?? false;
  };
  const originName = vp.originBody !== undefined ? vp.originBody : vp.trackBody;
  const origin = mesh(originName);
  const center = mesh(vp.trackBody);
  const lookAt = mesh(vp.lookAtBody);
  for (const [body, m] of [[originName, origin], [vp.trackBody, center], [vp.lookAtBody, lookAt]] as const) {
    if (m === false) return refuse(`"${body}" has no mesh in the scene`);
  }

  if (vp.epoch !== undefined) host.timeController.setTime(vp.epoch);
  if (vp.fov !== undefined) {
    host.camera.fov = vp.fov;
    host.camera.updateProjectionMatrix();
  }
  // A viewpoint with an explicit target off its center wants the camera aimed
  // there, not orbit-locked to the body; one with a look-at body stays with
  // the center and keeps that body in view as time runs.
  const aimsOff = !lookAt && vp.target.lengthSq() > 1e-30;
  host.cameraController.establishView(vp, {
    origin: origin || null,
    track: aimsOff ? null : center || null,
    lookAt: lookAt || null,
    duration: opts.animate ? (opts.duration ?? 1.0) : undefined,
  });
  return true;
}
