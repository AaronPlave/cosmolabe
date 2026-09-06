/**
 * Camera view import/export — JSON download/upload of the current camera state.
 *
 * The exported JSON matches the shape of `ViewpointDefinition` from
 * `@cosmolabe/core` (eye/target/up/center/fov), with two additive fields
 * (`mode`, `time`) that round-trip cosmolabe state without breaking
 * Cosmographia-style catalog use: a catalog loader that doesn't know about
 * the extras simply ignores them. Drop the JSON into a catalog's
 * `viewpoints` array and it loads as a viewpoint.
 *
 * Positions in the JSON are in km (catalog convention). Scene-space units
 * are km × scaleFactor; we convert in both directions.
 */
import * as THREE from 'three';
import type { UniverseRenderer } from '@cosmolabe/three';
import { etToDate, type ViewpointDefinition } from '@cosmolabe/core';

/**
 * The exported `time`, as a UTC ISO string.
 *
 * Via core's `etToDate`, not a local J2000 constant. This used to reckon J2000
 * as 2000-01-01T12:00:00 UTC, which is 64.184 s off the real epoch
 * (11:58:55.816 UTC) before the leap seconds accrued since — 69.184 s at a
 * modern epoch. That is not cosmetic: an exported view is documented as being
 * droppable into a catalog's viewpoints array, and since a Viewpoint's `time`
 * is honoured, the epoch this writes is one a scene will actually be seeked to.
 *
 * Exported so `__tests__/camera-view-io.test.ts` can check it against SPICE,
 * and so `viewer-control.ts`'s `snapshot()` can render the same epoch the same
 * way. A fourth hand-rolled J2000 conversion is exactly what this comment
 * exists to prevent, so new callers should come here rather than write one.
 */
export function etToIso(et: number): string {
  if (!Number.isFinite(et) || Math.abs(et) > 7.5e9) return new Date().toISOString();
  return etToDate(et).toISOString();
}

interface ExportedView extends ViewpointDefinition {
  /** Cosmolabe extension: camera mode name (FREE_ORBIT, BODY_FIXED, ...). */
  mode?: string;
  /** Cosmolabe extension: simulation time at export, ISO 8601 UTC. */
  time?: string;
}

export function exportCameraView(renderer: UniverseRenderer): void {
  const cc = renderer.cameraController;
  const invScale = 1 / renderer.scaleFactor;

  const cam = cc.camera;
  const tgt = cc.controls.target;
  const up = cam.up;

  const view: ExportedView = {
    name: `View ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    eye: [cam.position.x * invScale, cam.position.y * invScale, cam.position.z * invScale],
    target: [tgt.x * invScale, tgt.y * invScale, tgt.z * invScale],
    up: [up.x, up.y, up.z],
    fov: cam.fov,
    center: cc.trackedBody?.body.name,
    mode: cc.mode,
    time: etToIso(renderer.timeController.et),
  };

  const blob = new Blob([JSON.stringify(view, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cosmolabe-view-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importCameraViewFromFile(renderer: UniverseRenderer): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  const file: File | null = await new Promise((resolve) => {
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  if (!file) return;
  const text = await file.text();
  applyCameraViewJson(renderer, text);
}

/** Apply a viewpoint from a JSON string (pasted text or loaded file). */
export function applyCameraViewJson(renderer: UniverseRenderer, json: string): void {
  let view: ExportedView;
  try {
    view = JSON.parse(json) as ExportedView;
  } catch (err) {
    console.error('[camera-view-io] invalid JSON', err);
    return;
  }
  applyCameraView(renderer, view);
}

export function applyCameraView(renderer: UniverseRenderer, view: ExportedView): void {
  if (!view || (!view.eye && view.distance == null)) {
    console.warn('[camera-view-io] viewpoint has neither `eye` nor `distance`; skipping');
    return;
  }

  const cc = renderer.cameraController;
  const scale = renderer.scaleFactor;

  // Track body first so origin is set before we apply the explicit position.
  // Clear if no center body specified, so we don't carry a stale tracked body.
  if (view.center) {
    const bm = renderer.getBodyMesh(view.center);
    if (bm) cc.track(bm);
  } else {
    cc.track(null);
  }

  // v1 applies explicit eye/target only — distance/lat/lon viewpoints can be
  // loaded via the normal catalog path. Catalog viewpoints exported from
  // cosmolabe always include explicit eye/target.
  if (view.eye) {
    const position = new THREE.Vector3(view.eye[0] * scale, view.eye[1] * scale, view.eye[2] * scale);
    const target = view.target
      ? new THREE.Vector3(view.target[0] * scale, view.target[1] * scale, view.target[2] * scale)
      : new THREE.Vector3(0, 0, 0);
    const up = view.up
      ? new THREE.Vector3(view.up[0], view.up[1], view.up[2]).normalize()
      : new THREE.Vector3(0, 1, 0);
    cc.applyViewpoint({ name: view.name ?? 'Imported', position, target, up, trackBody: view.center });
  }

  if (view.fov != null && Number.isFinite(view.fov)) {
    cc.camera.fov = view.fov;
    cc.camera.updateProjectionMatrix();
  }
}
