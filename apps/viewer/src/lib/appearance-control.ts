import type { ScriptSurfaceAppearance } from '@cosmolabe/control';
import { normalizeSurfaceAppearance } from '@cosmolabe/three';
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
  const current = bm.surfaceAppearance;
  if (!current) throw new Error(getSurfaceAppearance(body)?.unavailable ?? 'Appearance unavailable');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected an appearance patch');
  const normalized = normalizeSurfaceAppearance({ ...current, ...patch });
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in normalized) || (normalized as unknown as Record<string, unknown>)[key] !== value) throw new Error(`Invalid appearance setting: ${key}`);
  }
  bm.setSurfaceAppearance(normalized);
  emit('surface', { body });
  return true;
}
