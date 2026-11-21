/**
 * `getViewComposition` (#345): where named objects sit in the camera's actual
 * view, from the renderer's own camera and body meshes. The same projection
 * Event presentation reports for its participants, extended with bearing,
 * range, apparent size and analytic sphere occlusion so a deterministic
 * composer (`composeView`) and outcome checks can steer and judge framing.
 *
 * Geometry only: sphere occlusion uses measured radii (not models or terrain),
 * and nothing here reads pixels.
 */
import * as THREE from 'three';
import type { ScriptComposedObject, ScriptViewComposition } from '@cosmolabe/control';
import { getRenderer, sceneId, vs } from './viewer-state.svelte';

const deg = THREE.MathUtils.radToDeg;

export function getViewComposition(names: readonly string[]): ScriptViewComposition {
  const r = getRenderer();
  const missing = (object: string): ScriptComposedObject => ({ object, available: false, drawEnabled: false, rangeKm: null, radiusKm: null, angularRadiusDeg: null, bearingDeg: null, ndc: null, inView: false, occlusion: null });
  if (!r?.camera) return { scene: null, et: vs.et, playing: vs.playing, tracked: null, orbitDistanceKm: 0, fovDeg: 0, aspect: 1, objects: names.map(missing) };
  const placement = r.getBodyPoseContext?.();
  const freshness = placement ? { observedEt: placement.et, fresh: placement.et === r.timeController.et && placement.origin === (r.cameraController.originBody?.body.name ?? null) } : {};
  const cam = r.camera, s = r.scaleFactor;
  cam.updateMatrixWorld();
  const eye = cam.getWorldPosition(new THREE.Vector3());
  const toCamera = cam.matrixWorldInverse;
  // Every drawn body with a real size can hide what is behind it.
  const occluders = r.getBodyNames().flatMap(name => {
    const bm = r.getBodyMesh(name);
    if (!bm?.visible || !bm.hasMeasuredRadius) return [];
    const rel = bm.getWorldPosition(new THREE.Vector3()).sub(eye);
    const range = rel.length() / s;
    return [{ name, basis: ['Mesh', 'TimeSwitched', 'Dsk'].includes(bm.body?.geometryType ?? '') ? 'model-bounds' as const : 'reference-sphere' as const, dir: rel.normalize(), range, ang: Math.asin(Math.min(1, bm.displayRadius / range)) }];
  });
  const objects = names.map((object): ScriptComposedObject => {
    const bm = r.getBodyMesh(object);
    if (!bm) return missing(object);
    const world = bm.getWorldPosition(new THREE.Vector3());
    const rel = world.clone().sub(eye);
    const rangeKm = rel.length() / s;
    const radiusKm = bm.hasMeasuredRadius ? bm.displayRadius : null;
    const ang = radiusKm ? Math.asin(Math.min(1, radiusKm / rangeKm)) : 0;
    // Camera space: x right, y up, z toward the viewer (three.js looks down -z).
    const c = world.clone().applyMatrix4(toCamera);
    const front = c.z < 0;
    const p = world.clone().project(cam);
    const ndc = front ? [p.x, p.y] as const : null;
    const dir = rel.normalize();
    let occlusion: ScriptComposedObject['occlusion'] = null, nearest = Infinity;
    for (const o of occluders) {
      if (o.name === object || o.range >= rangeKm || o.range >= nearest) continue;
      const sep = o.dir.angleTo(dir);
      if (sep < o.ang) { nearest = o.range; occlusion = { by: o.name, basis: o.basis, kind: sep + ang <= o.ang ? 'full' : 'partial' }; }
    }
    return { object, available: true, drawEnabled: bm.visible, rangeKm, radiusKm, angularRadiusDeg: radiusKm ? deg(ang) : null,
      bearingDeg: [deg(Math.atan2(c.x, -c.z)), deg(Math.atan2(c.y, Math.hypot(c.x, c.z)))], ndc,
      inView: !!ndc && Math.abs(ndc[0]) <= 1 && Math.abs(ndc[1]) <= 1, occlusion };
  });
  return { ...freshness, scene: sceneId(), et: r.timeController.et, playing: r.timeController.playing, tracked: r.cameraController.trackedBody?.body.name ?? null,
    orbitDistanceKm: eye.distanceTo(r.cameraController.controls.target) / s, fovDeg: cam.fov, aspect: cam.aspect, objects };
}
