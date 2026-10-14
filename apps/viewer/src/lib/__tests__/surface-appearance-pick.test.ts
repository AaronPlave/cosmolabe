import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseRenderer } from '@cosmolabe/three';
import { DEFAULT_SURFACE_APPEARANCE } from '@cosmolabe/three';
import { appearancePick, cancelAppearancePick, handleAppearancePick, startAppearancePick } from '../surface-appearance-pick.svelte';

beforeEach(cancelAppearancePick);
function renderer() {
  let settings = { ...DEFAULT_SURFACE_APPEARANCE, baseColor: 'elevation' as const, minKm: -10, maxKm: 10 };
  const setSurfaceAppearance = vi.fn(next => { settings = next; });
  const pickSurface = vi.fn((): { bodyName: string; altKm: number; surfaceStyleHeightKm?: number; bodyFixedHitKm: number[] } | null => ({ bodyName: 'Mars', altKm: 999, surfaceStyleHeightKm: -3, bodyFixedHitKm: [1, 2, 3] }));
  const mesh = { get surfaceAppearance() { return settings; }, setSurfaceAppearance };
  const r = { renderer: { domElement: { clientWidth: 800, clientHeight: 600 } }, pickSurface, getBodyMesh: () => mesh } as unknown as UniverseRenderer;
  return { r, mesh, pickSurface, setSurfaceAppearance };
}
describe('independent surface appearance range picks', () => {
  it('uses the rendered intersection height, consumes the gesture, and changes only minimum', () => {
    const { r, mesh, pickSurface } = renderer();
    startAppearancePick('Mars', 'minKm');
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    expect(pickSurface).toHaveBeenCalledWith(0, 0);
    expect(mesh.surfaceAppearance).toMatchObject({ minKm: -3, maxKm: 10 });
    expect(appearancePick.bound).toBeNull();
    expect(appearancePick.feedback).toContain('Minimum set');
  });
  it('changes only maximum and leaves the other endpoint intact', () => {
    const { r, mesh } = renderer();
    startAppearancePick('Mars', 'maxKm');
    handleAppearancePick(r, 400, 300);
    expect(mesh.surfaceAppearance).toMatchObject({ minKm: -10, maxKm: -3 });
  });
  it('keeps picking after another body or a crossing bound, without changing either endpoint', () => {
    const { r, mesh, pickSurface, setSurfaceAppearance } = renderer();
    startAppearancePick('Mars', 'minKm');
    pickSurface.mockReturnValue(null);
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    expect(appearancePick.bound).toBe('minKm');
    pickSurface.mockReturnValue({ bodyName: 'Moon', altKm: 999, surfaceStyleHeightKm: -3, bodyFixedHitKm: [1, 2, 3] });
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    pickSurface.mockReturnValue({ bodyName: 'Mars', altKm: 999, surfaceStyleHeightKm: -3, bodyFixedHitKm: [1, 2, 3] });
    pickSurface.mockReturnValue({ bodyName: 'Mars', altKm: 999, surfaceStyleHeightKm: 12, bodyFixedHitKm: [1, 2, 3] });
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    expect(appearancePick.bound).toBe('minKm');
    expect(setSurfaceAppearance).not.toHaveBeenCalled();
    expect(mesh.surfaceAppearance).toMatchObject({ minKm: -10, maxKm: 10 });
    expect(appearancePick.feedback).toContain('below the current maximum');
  });

  it('rejects a globe or surface overlay without rendered elevation colors', () => {
    const { r, pickSurface, setSurfaceAppearance } = renderer();
    startAppearancePick('Mars', 'maxKm');
    pickSurface.mockReturnValue({ bodyName: 'Mars', altKm: 999, bodyFixedHitKm: [1, 2, 3] });
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    expect(setSurfaceAppearance).not.toHaveBeenCalled();
    expect(appearancePick.bound).toBe('maxKm');
    expect(appearancePick.feedback).toContain('elevation colors');
  });
  it('cancels cleanly and returns ordinary picking to the existing input path', () => {
    const { r, pickSurface } = renderer();
    startAppearancePick('Mars', 'maxKm');
    expect(cancelAppearancePick()).toBe(true);
    expect(handleAppearancePick(r, 400, 300)).toBe(false);
    expect(pickSurface).not.toHaveBeenCalled();
  });
});
