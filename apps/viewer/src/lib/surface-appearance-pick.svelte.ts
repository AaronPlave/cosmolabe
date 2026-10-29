import type { SurfaceAppearanceSettings, UniverseRenderer } from '@cosmolabe/three';
import { excludeFromProbe, getRenderer, setProbeActive } from './viewer-state.svelte';
import { cancelMeasurementPick } from './spatial-measurements.svelte';
import { resettable } from './session.svelte';

let owner: UniverseRenderer | null = null;
excludeFromProbe(() => cancelAppearancePick());

export const appearancePick = $state({
  bodyName: null as string | null,
  bound: null as 'minKm' | 'maxKm' | null,
  feedback: '',
  revision: 0,
});
resettable(appearancePick);

export function startAppearancePick(bodyName: string, bound: 'minKm' | 'maxKm'): void {
  cancelAppearancePick();
  setProbeActive(false);
  cancelMeasurementPick();
  owner = getRenderer();
  owner?.setSurfacePointerTool({
    pick: (x, y) => { if (owner) handleAppearancePick(owner, x, y); },
    preview: (x, y) => {
      if (!owner) return;
      const hit = owner.pickScene(x, y, 'probe', { renderedOnly: true });
      owner.setHoveredBody(null);
      owner.setSpatialSurfacePreview(hit?.kind === 'surface' && hit.point.bodyName === bodyName ? hit.point : null);
    },
  });
  appearancePick.bodyName = bodyName;
  appearancePick.bound = bound;
  appearancePick.feedback = `Click ${bodyName} terrain to set the ${bound === 'minKm' ? 'minimum' : 'maximum'}. Escape cancels.`;
}

export function cancelAppearancePick(): boolean {
  const active = appearancePick.bound !== null;
  owner?.setSurfacePointerTool(null);
  owner = null;
  appearancePick.bodyName = null;
  appearancePick.bound = null;
  appearancePick.feedback = '';
  return active;
}

/** Shared validation keeps manual and picked edits from shifting the other bound. */
export function validAppearanceBound(settings: SurfaceAppearanceSettings, bound: 'minKm' | 'maxKm', value: number): boolean {
  return Number.isFinite(value) && value >= -1000 && value <= 1000 &&
    (bound === 'minKm' ? settings.maxKm - value >= 0.001 : value - settings.minKm >= 0.001);
}

/** Runs in the renderer's temporary pointer-tool path, before ordinary selection. */
export function handleAppearancePick(renderer: UniverseRenderer, x: number, y: number): boolean {
  const { bound, bodyName } = appearancePick;
  if (!bound || !bodyName) return false;
  const hit = renderer.pickSurfaceTintHeight(x, y);
  const mesh = renderer.getBodyMesh(bodyName);
  const settings = mesh?.surfaceAppearance;
  if (!settings || settings.baseColor !== 'elevation') { cancelAppearancePick(); return true; }
  if (!hit || hit.bodyName !== bodyName) {
    appearancePick.feedback = `Pick a visible ${bodyName} terrain point.`;
    return true;
  }
  // altKm may be a separate CPU sample. Match the actual elevation color's
  // interpolated height, without sampling/fetching another elevation source.
  const height = hit.heightKm;
  if (height === undefined || !Number.isFinite(height)) {
    appearancePick.feedback = 'Pick visible terrain carrying elevation colors.';
    return true;
  }
  if (!validAppearanceBound(settings, bound, height)) {
    appearancePick.feedback = `Picked ${height.toFixed(3)} km. Choose a ${bound === 'minKm' ? 'minimum below the current maximum' : 'maximum above the current minimum'} within −1000 to 1000 km (at least 0.001 km apart).`;
    return true;
  }
  mesh.setSurfaceAppearance({ ...settings, [bound]: height });
  cancelAppearancePick();
  appearancePick.bodyName = bodyName;
  appearancePick.feedback = `${bound === 'minKm' ? 'Minimum' : 'Maximum'} set to ${height.toFixed(3)} km from the rendered terrain.`;
  appearancePick.revision++;
  return true;
}
