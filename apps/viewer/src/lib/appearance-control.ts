import type { ScriptSurfaceAppearance } from '@cosmolabe/control';
import { type BodyMesh, normalizeSurfaceAppearance } from '@cosmolabe/three';
import { getRenderer, sceneId, emit } from './viewer-state.svelte';

export function getSurfaceAppearance(body: string) {
  const bm = getRenderer()?.getBodyMesh(body);
  if (!bm) return undefined;
  const settings = bm.surfaceAppearance;
  return { settings: settings ? { ...settings } : null,
    unavailable: settings ? null : bm.surfaceAppearanceStatus?.message ?? 'Relief styles require a known physical terrain product.' };
}
export function setSurfaceAppearance(body: string, patch: Partial<ScriptSurfaceAppearance>, opts?: { scene?: number }): boolean {
  if (opts?.scene !== undefined && opts.scene !== sceneId()) throw new Error('the scene changed since this was read');
  const bm = getRenderer()?.getBodyMesh(body);
  if (!bm) return false;
  return applySurfaceAppearance(bm, patch);
}

/** The UI picker already owns a renderer; use the same validation and notification. */
export function applySurfaceAppearance(bm: BodyMesh, patch: Partial<ScriptSurfaceAppearance>): boolean {
  const current = bm.surfaceAppearance;
  if (!current) throw new Error(bm.surfaceAppearanceStatus?.message ?? 'Appearance unavailable');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected an appearance patch');
  const normalized = normalizeSurfaceAppearance({ ...current, ...patch });
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in normalized) || (normalized as unknown as Record<string, unknown>)[key] !== value) throw new Error(`Invalid appearance setting: ${key}`);
  }
  bm.setSurfaceAppearance(normalized);
  emit('surface', { body: bm.body.name });
  return true;
}

/** Shared imagery operations for UI and hosts. The manager enforces the base slot. */
export function setImageryVisible(body: string, id: string, visible: boolean, opts?: { scene?: number }): boolean {
  return imageryAction(body, opts, bm => {
    const info = bm.imageryLayers.find(l => l.id === id);
    if (!info || (!visible && !info.optional)) return false;
    return bm.setImageryLayerVisible(id, visible) || info.visible === visible;
  });
}
export function setImageryOpacity(body: string, id: string, opacity: number, opts?: { scene?: number }): boolean {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return false;
  return imageryAction(body, opts, bm => {
    if (!bm.imageryLayers.some(l => l.id === id)) return false;
    return bm.setImageryLayerOpacity(id, opacity) || bm.imageryLayers.find(l => l.id === id)?.opacity === opacity;
  });
}
export function moveImageryLayer(body: string, id: string, index: number, opts?: { scene?: number }): boolean {
  if (!Number.isInteger(index)) return false;
  return imageryAction(body, opts, bm => {
    const from = bm.imageryLayers.findIndex(l => l.id === id);
    if (from < 0 || index < 0 || index >= bm.imageryLayers.length || (from === 0) !== (index === 0)) return false;
    return from === index || bm.moveImageryLayer(id, index);
  });
}
function imageryAction(body: string, opts: { scene?: number } | undefined, action: (bm: BodyMesh) => boolean): boolean {
  if (opts?.scene !== undefined && opts.scene !== sceneId()) throw new Error('the scene changed since this was read');
  const bm = getRenderer()?.getBodyMesh(body);
  if (!bm || !action(bm)) return false;
  emit('surface', { body });
  return true;
}
