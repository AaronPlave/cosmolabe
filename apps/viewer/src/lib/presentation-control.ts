/** Presentation-only instrument and session-view actions, shared with native UI. */
import { Vector3 } from 'three';
import type { ViewerControl, ScriptBookmark, ScriptSceneOptions } from '@cosmolabe/control';
import { getRenderer, getSceneUniverse, sceneId, emit } from './viewer-state.svelte';
const guard = (opts?: ScriptSceneOptions) => {
  if (opts?.scene !== undefined && opts.scene !== sceneId()) throw new Error('The scene changed since this was read');
  const renderer = getRenderer();
  if (!renderer) throw new Error('No renderer is bound');
  return renderer;
};
function reserved(name: string): boolean {
  return name === 'Default' || !!getSceneUniverse()?.viewpoints.some(v => v.name === name);
}
function nameValid(name: string): void {
  if (typeof name !== 'string' || !name.trim() || name.length > 256) throw new Error('Bookmark needs a bounded name');
  if (reserved(name)) throw new Error('A catalog/default viewpoint cannot be overwritten or removed');
}
export const presentationControl: Pick<Required<ViewerControl>, 'listInstruments' | 'getInstrument' | 'selectInstrument' | 'listBookmarks' | 'saveBookmark' | 'upsertBookmark' | 'removeBookmark'> = {
  listInstruments: () => getRenderer()?.getSensorNames() ?? [],
  getInstrument: () => {
    const info = getRenderer()?.getInstrumentViewInfo();
    if (!info) return null;
    const { imageRect: _imageRect, ...semantic } = info;
    return { ...semantic, observation: 'synthetic-scene-view', observedEt: info.observedEt };
  },
  selectInstrument: (name, opts) => {
    const r = guard(opts);
    if (name !== null && !r.getSensorNames().includes(name)) return false;
    r.setInstrumentView(name); return true;
  },
  listBookmarks: () => {
    const r = getRenderer();
    return r?.cameraController.getViewpoints().filter(v => !reserved(v.name)).map(v => ({
      name: v.name, origin: v.originBody ?? v.trackBody ?? null, tracked: v.trackBody ?? null,
      lookAt: v.lookAtBody ?? null, ...(v.epoch !== undefined ? { time: v.epoch } : {}),
      camera: { position: v.position.toArray().map(n => n / r.scaleFactor) as [number, number, number],
        target: v.target.toArray().map(n => n / r.scaleFactor) as [number, number, number],
        up: v.up.toArray() as [number, number, number], fov: v.fov ?? 60 },
    })) ?? [];
  },
  saveBookmark: (name, opts) => {
    const r = guard(opts); nameValid(name);
    r.cameraController.saveViewpoint(name);
    emit('bookmarks', {}); return true;
  },
  upsertBookmark: (input: ScriptBookmark, opts) => {
    const r = guard(opts); nameValid(input?.name);
    const b = input;
    for (const value of [b.origin, b.tracked, b.lookAt]) if (value !== null && !r.getBodyMesh(value)) throw new Error(`Bookmark body ${value} is unavailable`);
    for (const value of [b.camera?.position, b.camera?.target, b.camera?.up]) {
      if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new Error('Invalid bookmark camera vector');
    }
    if (!Number.isFinite(b.camera.fov) || b.camera.fov <= 0 || b.camera.fov >= 180 || !b.camera.up.some(n => n !== 0)) throw new Error('Invalid bookmark camera');
    if (b.time !== undefined && !Number.isFinite(b.time)) throw new Error('Invalid bookmark epoch');
    r.cameraController.addViewpoint({ name: b.name, position: new Vector3(...b.camera.position).multiplyScalar(r.scaleFactor),
      target: new Vector3(...b.camera.target).multiplyScalar(r.scaleFactor), up: new Vector3(...b.camera.up), fov: b.camera.fov,
      originBody: b.origin, trackBody: b.tracked ?? undefined, lookAtBody: b.lookAt ?? undefined, epoch: b.time });
    emit('bookmarks', {}); return true;
  },
  removeBookmark: (name, opts) => {
    const r = guard(opts); nameValid(name);
    const removed = r.cameraController.removeViewpoint(name);
    if (removed) emit('bookmarks', {});
    return removed;
  },
};
