/** Bounded semantic scene context, without resource paths or source identities. */
import { CompositeTrajectory } from '@cosmolabe/core';
import { CameraModeName, resolveCameraViewpoint } from '@cosmolabe/three';
import type { ScriptCamera, ScriptObjectContext, ScriptViewpointInfo } from '@cosmolabe/control';
import { getRenderer, getSceneUniverse } from './viewer-state.svelte';

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function getObjectContext(name: string): ScriptObjectContext | undefined {
  const body = getSceneUniverse()?.getBody(name);
  if (!body) return undefined;
  const arcs = body.trajectory instanceof CompositeTrajectory ? body.trajectory.arcs : [];
  const sequence = body.geometryType === 'TimeSwitched' && Array.isArray(body.geometryData?.sequence) ? body.geometryData.sequence as Record<string, unknown>[] : [];
  return { object: name, source: 'scene-configuration',
    existence: { start: finite(body.existsFrom), end: finite(body.existsUntil) },
    trajectoryArcs: arcs.slice(0, 16).map(a => ({ start: finite(a.startTime), end: finite(a.endTime), center: a.centerName ?? body.parentName ?? null })),
    geometryWindows: sequence.slice(0, 16).map(a => ({ start: finite(a.startEt), end: finite(a.endEt) })),
    truncated: arcs.length > 16 || sequence.length > 16,
    limitations: ['Configured existence, trajectory and geometry boundaries describe scene assets; they are not measured mission events or proof of contact/release. Resource paths and identities are withheld.'],
  };
}

export function getViewpointInfo(name: string, actual: ScriptCamera): ScriptViewpointInfo | undefined {
  const r = getRenderer(), stored = r?.cameraController.getViewpoint(name);
  if (!r || !stored) return undefined;
  const cc = r.cameraController, epoch = stored.epoch ?? null;
  let camera: ScriptCamera | null = null;
  try {
    const vp = resolveCameraViewpoint(stored, epoch ?? r.timeController.et);
    camera = { position: vp.position.toArray().map(n => n / r.scaleFactor) as [number, number, number],
      target: vp.target.toArray().map(n => n / r.scaleFactor) as [number, number, number], up: vp.up.toArray() as [number, number, number], fov: vp.fov ?? actual.fov };
  } catch { /* Resolution unavailable: never treat the stored registration pose as current. */ }
  const error = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((n, i) => n - b[i]));
  const positionErrorKm = camera ? error(actual.position, camera.position) : null;
  const targetErrorKm = camera ? error(actual.target, camera.target) : null;
  const origin = stored.originBody !== undefined ? stored.originBody : stored.trackBody ?? null;
  const tracked = stored.target.lengthSq() > 1e-30 && !stored.lookAtBody ? null : stored.trackBody ?? null;
  const tolerance = camera ? Math.max(1e-7, Math.hypot(...camera.position) * 1e-9) : 0;
  return { name, source: getSceneUniverse()?.viewpoints.some(v => v.name === name) ? 'catalog-viewpoint' : 'session-viewpoint',
    epoch, authoredTime: typeof stored.definition?.time === 'number' ? finite(stored.definition.time) : typeof stored.definition?.time === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(stored.definition.time) ? stored.definition.time : null, origin, tracked, lookAt: stored.lookAtBody ?? null, camera,
    navigation: { poseMatches: !!camera && cc.mode === CameraModeName.FREE_ORBIT && (cc.originBody?.body.name ?? null) === origin
      && (cc.trackedBody?.body.name ?? null) === tracked
      && (cc.lookAtBody?.body.name ?? null) === (stored.lookAtBody ?? null)
      && positionErrorKm! <= tolerance && targetErrorKm! <= tolerance && error(actual.up, camera.up) <= 1e-7 && Math.abs(actual.fov - camera.fov) < 1e-7,
      epochMatches: epoch === null ? null : Math.abs(r.timeController.et - epoch) < 1e-3,
      observedEt: r.timeController.et, playing: r.timeController.playing, positionErrorKm, targetErrorKm },
    limitations: ['Authored viewpoint time and pose are scene annotations, not independently computed or certified physical mission events. Pose matching does not establish object visibility; inspect view composition separately.'],
  };
}
