import { getUniverse } from './loader';
/** Semantic points share core state/frame transforms, Draw conventions and native Point Probe surfaces. */
import type { ViewerControl, ScriptSpatialContext, ScriptGroundProjection, ScriptSurfacePolicy } from '@cosmolabe/control';
import { inferredCoordinates, annotationTarget, editLayer, pointPositionInCoordinates } from './geographic-editing.svelte';
import { geographicLayer, geo } from './geographic-layers.svelte';
import { getSceneUniverse, getRenderer, sceneId, vs } from './viewer-state.svelte';

function annotationOf(point: import('@cosmolabe/core').SurfacePoint) {
  const layer = annotationTarget(point.bodyName), coordinates = (layer ? editLayer(layer)?.coordinates : null) ?? inferredCoordinates(point.bodyName);
  const position = coordinates ? pointPositionInCoordinates(point, coordinates) : null;
  return coordinates && position ? { layer, coordinates, position: [position[0], position[1]] as const } : null;
}
const epoch = () => getRenderer()?.timeController.et ?? vs.et;
export function getSpatialContext(object: string): ScriptSpatialContext {
  const u = getSceneUniverse(), current = !!u && getUniverse() === u, body = current ? u?.getBody(object) : undefined, et = epoch(), parent = body?.activeParentAt(et) ?? null;
  let state: ScriptSpatialContext['state'] = null;
  if (u && body && parent) {
    const frame = u.frames.bodyFixedFrameFor(parent);
    try {
      const s = u.stateIn(object, et, { frame, center: parent });
      state = { et, frame, center: parent, position: s.position, attitude: s.attitude,
        positionAvailability: { ...s.availability.position }, attitudeAvailability: s.availability.attitude && { ...s.availability.attitude } };
    } catch { /* Missing source/frame remains unavailable; no guessed transform. */ }
  }
  const id = u && body ? annotationTarget(object) : null, layer = id ? geographicLayer(id) : null;
  return { status: !u ? 'no-scene' : !current ? 'scene-changing' : !body ? 'missing-entity' : 'available', scene: u ? sceneId() : null, et, object, parent, state,
    coordinates: u && body ? inferredCoordinates(object) : null,
    parentCoordinates: u && parent ? inferredCoordinates(parent) : null,
    selectedFeature: geo.selected?.bodyName === object ? { layer: geo.selected.layerId, feature: geo.selected.featureId } : null,
    drawing: (getRenderer()?.geographicVectors?.status ?? []).filter(s => s.bodyName === object).slice(0,16).map(s => ({ layers: s.layerIds.slice(0,16), features: s.features, terrainCoverage: s.featureTerrainCoverage })),
    editableLayers: layer ? [{ id: layer.id, body: layer.body, frame: layer.frame ?? null }] : [] };
}
export function projectGroundPoint(object: string, policy: ScriptSurfacePolicy = 'rendered', opts?: { scene?: number }): ScriptGroundProjection {
  const context = getSpatialContext(object), r = getRenderer();
  const result: ScriptGroundProjection = { scene: context.scene, et: context.et, object, body: context.parent,
    frame: context.parentCoordinates?.frame ?? null, policy, status: 'unavailable', reason: null, referenceOnly: false, point: null, annotation: null,
    limitations: ['Radial sub-point of the entity position in its active parent body-fixed frame; vehicle attitude is not needed.',
      'A pinned point is a snapshot at placement, not a tracker. Reference shape, rendered surface and physical terrain are distinct.',
      'Programmatic display precision is not a position-accuracy estimate. No camera, clock, source coordinates or terrain geometry is changed.'] };
  const fail = (reason: string) => ({ ...result, reason });
  if (opts?.scene !== undefined && opts.scene !== context.scene) return { ...result, status: 'stale', reason: 'scene-changed' };
  if (!['reference', 'rendered', 'terrain'].includes(policy)) return fail('invalid-surface-policy');
  if (context.scene === null) return fail('no-scene');
  if (context.status === 'scene-changing') return fail('scene-changing');
  if (!getSceneUniverse()?.getBody(object)) return fail('missing-entity');
  if (!context.parent) return fail('missing-parent');
  if (!context.parentCoordinates) return fail('unsupported-reference-shape');
  if (!context.state?.positionAvailability.available || !context.state.position) return fail(`position-${context.state?.positionAvailability.reason ?? 'or-frame-unavailable'}`);
  const p = context.state.position, length = Math.hypot(...p);
  if (!p.every(Number.isFinite) || length <= 0) return fail('invalid-body-fixed-position');
  if (!r?.projectSurfacePoint) return fail('no-surface-renderer');
  const lat = Math.asin(Math.max(-1, Math.min(1, p[2] / length))) * 180 / Math.PI;
  const lon = Math.atan2(p[1], p[0]) * 180 / Math.PI;
  const meshFrame = r.getBodyMesh?.(context.parent)?.bodyFixedFrame;
  if (!meshFrame || !getSceneUniverse()!.frames.sameFrame(context.state.frame, meshFrame)) return fail('body-fixed-frame-unavailable');
  const point = r.projectSurfacePoint(context.parent, lat, lon, policy);
  if (!point) return fail(policy === 'terrain' ? 'physical-terrain-unavailable-use-explicit-reference-alternative' : 'surface-unavailable');
  return { ...result, status: 'available', point, annotation: annotationOf(point), referenceOnly: point.source === 'ellipsoid' };
}
export const spatialControl: Pick<Required<ViewerControl>, 'getSpatialContext' | 'projectGroundPoint' | 'pinGroundPoint' | 'getProbePoint' | 'clearProbePoint'> = {
  getSpatialContext, projectGroundPoint,
  pinGroundPoint: (object, policy, opts) => {
    const result = projectGroundPoint(object, policy, opts);
    if (result.status === 'available' && result.point) getRenderer()!.setProbePin(result.point, { refine: policy !== 'reference' });
    return result;
  },
  getProbePoint: () => {
    const r = getRenderer(), nativePoint = r?.probePin;
    const point = nativePoint === undefined ? vs.probePin : nativePoint;
    if (!point || !r) return null;
    const observed = r.getProbeVisualization?.();
    return { scene: getSceneUniverse() ? sceneId() : null, point, annotation: annotationOf(point), observedEt: observed?.observedEt ?? null,
      placedEt: observed?.placedEt ?? null, drawn: observed?.drawn === true };
  },
  clearProbePoint: opts => { if (opts?.scene !== undefined && opts.scene !== sceneId()) throw new Error('The scene changed'); getRenderer()?.setProbePin(null); },
};
