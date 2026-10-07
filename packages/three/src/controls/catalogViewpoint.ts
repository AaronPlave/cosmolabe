/**
 * Catalog viewpoints as camera viewpoints.
 *
 * A catalog viewpoint is a relationship — "500 km over Jezero", "behind
 * Rosetta, looking at Mars" — not a pose, so the camera viewpoint carries a
 * resolver and is re-resolved at the epoch it is applied at: its own `epoch`
 * when it names one, and the current simulation time otherwise. The math is
 * core's `resolveViewpoint`; this only converts km to scene units.
 */
import * as THREE from 'three';
import { resolveViewpoint, viewpointBodies, type ViewpointDefinition, type ViewpointScene } from '@cosmolabe/core';
import type { CameraViewpoint, ViewpointPose } from './CameraController.js';

/**
 * Build the camera viewpoint for a catalog viewpoint. Its stored pose is
 * resolved at `def.epoch ?? initialEt` so a reader that does not re-resolve
 * still gets the pose it always did; `resolveCameraViewpoint` is what appliers
 * use. A reference to a body the scene does not have is reported here, at
 * load, and again (as a refusal) whenever the viewpoint is applied.
 */
export function cameraViewpointFromDefinition(
  scene: ViewpointScene,
  def: ViewpointDefinition,
  scaleFactor: number,
  initialEt: number,
): CameraViewpoint {
  for (const name of viewpointBodies(def)) {
    if (!scene.getBody(name)) console.warn(`[Cosmolabe] Viewpoint "${def.name}": unknown body "${name}"`);
  }
  const resolve = (et: number): ViewpointPose => {
    const r = resolveViewpoint(scene, def, et);
    return {
      position: new THREE.Vector3(...r.eye).multiplyScalar(scaleFactor),
      target: new THREE.Vector3(...r.target).multiplyScalar(scaleFactor),
      up: new THREE.Vector3(...r.up),
    };
  };
  let pose: ViewpointPose;
  try {
    pose = resolve(def.epoch ?? initialEt);
  } catch (err) {
    console.warn(`[Cosmolabe] Viewpoint "${def.name}": ${(err as Error).message}`);
    pose = { position: new THREE.Vector3(0, 300, 500), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
  }
  return {
    name: def.name,
    ...pose,
    trackBody: def.center,
    lookAtBody: def.lookAt,
    fov: def.fov,
    // Resolved by CatalogLoader (SPICE str2et, else core's calendar parse),
    // and undefined when the catalog named no time — which is what keeps a
    // timeless viewpoint from moving the clock.
    epoch: def.epoch,
    definition: def,
    resolve,
  };
}

/**
 * The viewpoint's pose at `et`, or the viewpoint itself when it has no
 * resolver (a session-saved view). Throws `ViewpointError` when a reference
 * cannot be resolved at `et`. Pass the viewpoint's own `epoch` when it has one.
 */
export function resolveCameraViewpoint(vp: CameraViewpoint, et: number): CameraViewpoint {
  return vp.resolve ? { ...vp, ...vp.resolve(et) } : vp;
}
