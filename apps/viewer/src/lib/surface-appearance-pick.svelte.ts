import type { UniverseRenderer } from '@cosmolabe/three';

export const appearancePick = $state({
  bodyName: null as string | null,
  bound: null as 'minKm' | 'maxKm' | null,
  feedback: '',
  revision: 0,
});

export function startAppearancePick(bodyName: string, bound: 'minKm' | 'maxKm'): void {
  appearancePick.bodyName = bodyName;
  appearancePick.bound = bound;
  appearancePick.feedback = `Click ${bodyName} terrain to set the ${bound === 'minKm' ? 'minimum' : 'maximum'}. Escape cancels.`;
}

export function cancelAppearancePick(): boolean {
  const active = appearancePick.bound !== null;
  appearancePick.bodyName = null;
  appearancePick.bound = null;
  appearancePick.feedback = '';
  return active;
}

/** Runs in the existing consumed-gesture pick path, before ordinary selection. */
export function handleAppearancePick(renderer: UniverseRenderer, x: number, y: number): boolean {
  const { bound, bodyName } = appearancePick;
  if (!bound || !bodyName) return false;
  const canvas = renderer.renderer.domElement;
  const hit = renderer.pickSurface(x / canvas.clientWidth * 2 - 1, 1 - y / canvas.clientHeight * 2);
  const mesh = renderer.getBodyMesh(bodyName);
  const settings = mesh?.surfaceAppearance;
  if (!settings || settings.baseColor !== 'elevation') { cancelAppearancePick(); return true; }
  if (!hit || hit.bodyName !== bodyName) {
    appearancePick.feedback = `Pick a visible ${bodyName} terrain point.`;
    return true;
  }
  // altKm may be a separate CPU sample. Match the actual elevation color's
  // interpolated height, without sampling/fetching another elevation source.
  const height = hit.surfaceStyleHeightKm;
  if (height === undefined || !Number.isFinite(height)) {
    appearancePick.feedback = 'Pick visible terrain carrying elevation colors.';
    return true;
  }
  if (bound === 'minKm' ? height >= settings.maxKm : height <= settings.minKm) {
    appearancePick.feedback = `Picked ${height.toFixed(3)} km. Choose a ${bound === 'minKm' ? 'minimum below the current maximum' : 'maximum above the current minimum'}.`;
    return true;
  }
  mesh.setSurfaceAppearance({ ...settings, [bound]: height });
  cancelAppearancePick();
  appearancePick.bodyName = bodyName;
  appearancePick.feedback = `${bound === 'minKm' ? 'Minimum' : 'Maximum'} set to ${height.toFixed(3)} km from the rendered terrain.`;
  appearancePick.revision++;
  return true;
}
