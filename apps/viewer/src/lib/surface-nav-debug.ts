/**
 * Opt-in diagnostics for surface navigation (#190), for diagnosing a landing
 * on streamed terrain in a real browser rather than guessing at it. Off
 * unless `window.__surfaceNavDebug = true`; then each flight, terrain
 * refinement and (twice a second while the camera is on a surface target, and
 * for a few seconds after) the camera's ground clearance is logged as
 * `[surface-nav] <event> {…}`. Distances are km.
 */
import type { SurfaceNavigationTarget } from '@cosmolabe/core';
import { meshLocalToBodyFixed, terrainGroundRadius, type BodyMesh, type UniverseRenderer } from '@cosmolabe/three';

export function surfaceNavDebugEnabled(): boolean {
  return !!(globalThis as { __surfaceNavDebug?: boolean }).__surfaceNavDebug;
}

export function surfaceNavLog(event: string, data: Record<string, unknown>): void {
  if (surfaceNavDebugEnabled()) console.log(`[surface-nav] ${event}`, data);
}

const round = (km: number | null | undefined) => (km == null || !Number.isFinite(km) ? null : Number(km.toFixed(5)));

/** Where the target's height came from: sample source, tile (its LOD) and whether terrain is still awaited. */
export function describeTargetHeight(target: SurfaceNavigationTarget) {
  return {
    from: target.height.from, heightKm: round(target.height.km), sourceId: target.height.sourceId ?? null,
    tileId: target.height.tileId ?? null, awaitingTerrain: !!target.awaitingTerrain,
  };
}

/**
 * The camera against the ground, now: its height above the CPU terrain (or
 * the reference radius) under it, the clamp's correction this frame, the
 * terrain revision and cube-grid residency, and what the rendered scene shows
 * at the centre of the view — a hit's source and range, or none (a view
 * from under rendered terrain, or of the sky).
 */
export function surfaceNavSnapshot(renderer: UniverseRenderer, bm: BodyMesh, target: SurfaceNavigationTarget | null) {
  const sf = renderer.scaleFactor;
  const local = renderer.camera.position.clone().sub(bm.position).applyQuaternion(bm.mesh.quaternion.clone().invert());
  const eye = meshLocalToBodyFixed(local, sf);
  const eyeR = Math.hypot(...eye);
  const ground = terrainGroundRadius(bm)(eye);
  const rect = renderer.renderer.domElement.getBoundingClientRect();
  const hit = renderer.pickScene(rect.width / 2, rect.height / 2, 'probe', { renderedOnly: true });
  const toTarget = target
    ? Math.hypot(eye[0] - target.positionKm[0], eye[1] - target.positionKm[1], eye[2] - target.positionKm[2])
    : null;
  return {
    eyeClearanceKm: round(ground !== null ? eyeR - ground : eyeR - bm.displayRadius),
    clearanceFrom: ground !== null ? 'terrain' : 'display radius',
    clampCorrectionKm: round(renderer.cameraClampCorrectionKm),
    eyeToTargetKm: round(toTarget),
    terrainRevision: bm.terrainRevision,
    cube: bm.terrainCubeStats ?? null,
    centreHit: hit?.kind === 'surface'
      ? { source: hit.point.source, rangeKm: round(hit.cameraRangeKm), heightKm: round(hit.point.altitude.km) }
      : hit ? { kind: hit.kind } : null,
  };
}
