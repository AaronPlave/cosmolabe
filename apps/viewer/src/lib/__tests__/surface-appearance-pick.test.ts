import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseRenderer } from '@cosmolabe/three';
import { DEFAULT_SURFACE_APPEARANCE } from '@cosmolabe/three';
import { setProbeActive, vs } from '../viewer-state.svelte';
import { measurements, startMeasurementPick } from '../spatial-measurements.svelte';
import { appearancePick, cancelAppearancePick, handleAppearancePick, startAppearancePick, validAppearanceBound } from '../surface-appearance-pick.svelte';

vi.mock('../loader', () => ({ getCurrentRenderer: () => null, getUniverse: () => null }));
vi.mock('../shell.svelte', () => ({ openTool: () => {} }));
beforeEach(cancelAppearancePick);
function renderer() {
  let settings = { ...DEFAULT_SURFACE_APPEARANCE, baseColor: 'elevation' as const, minKm: -10, maxKm: 10 };
  const setSurfaceAppearance = vi.fn(next => { settings = next; });
  const pickSurfaceTintHeight = vi.fn((): { bodyName: string; altKm: number; heightKm?: number; bodyFixedHitKm: number[] } | null => ({ bodyName: 'Mars', altKm: 999, heightKm: -3, bodyFixedHitKm: [1, 2, 3] }));
  const mesh = { get surfaceAppearance() { return settings; }, setSurfaceAppearance };
  const r = { renderer: { domElement: { clientWidth: 800, clientHeight: 600 } }, pickSurfaceTintHeight, getBodyMesh: () => mesh } as unknown as UniverseRenderer;
  return { r, mesh, pickSurfaceTintHeight, setSurfaceAppearance };
}
describe('independent surface appearance range picks', () => {
  it('uses the same rejection rules for direct and picked bounds, including narrow/clamped ranges', () => {
    const { mesh } = renderer();
    for (const value of [NaN, Infinity, -1001, 10, 12, 9.9999]) {
      expect(validAppearanceBound(mesh.surfaceAppearance, 'minKm', value)).toBe(false);
    }
    expect(validAppearanceBound(mesh.surfaceAppearance, 'minKm', -3)).toBe(true);
    expect(validAppearanceBound(mesh.surfaceAppearance, 'maxKm', -10)).toBe(false);
    expect(validAppearanceBound(mesh.surfaceAppearance, 'maxKm', 1001)).toBe(false);
  });
  it('hands the pointer between appearance, Point Probe and measurement modes', () => {
    setProbeActive(true);
    startMeasurementPick('source', 'surface');
    startAppearancePick('Mars', 'minKm');
    expect(vs.probeActive).toBe(false);
    expect(measurements.pendingPickSlot).toBeNull();
    setProbeActive(true);
    expect(appearancePick.bound).toBeNull();
    startAppearancePick('Mars', 'minKm');
    startMeasurementPick('target', 'surface');
    expect(appearancePick.bound).toBeNull();
    expect(measurements.pendingPickSlot).toBe('target');
  });
  it('uses the rendered intersection height, consumes the gesture, and changes only minimum', () => {
    const { r, mesh, pickSurfaceTintHeight } = renderer();
    startAppearancePick('Mars', 'minKm');
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    expect(pickSurfaceTintHeight).toHaveBeenCalledWith(400, 300);
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
    const { r, mesh, pickSurfaceTintHeight, setSurfaceAppearance } = renderer();
    startAppearancePick('Mars', 'minKm');
    pickSurfaceTintHeight.mockReturnValue(null);
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    expect(appearancePick.bound).toBe('minKm');
    pickSurfaceTintHeight.mockReturnValue({ bodyName: 'Moon', altKm: 999, heightKm: -3, bodyFixedHitKm: [1, 2, 3] });
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    pickSurfaceTintHeight.mockReturnValue({ bodyName: 'Mars', altKm: 999, heightKm: -3, bodyFixedHitKm: [1, 2, 3] });
    pickSurfaceTintHeight.mockReturnValue({ bodyName: 'Mars', altKm: 999, heightKm: 12, bodyFixedHitKm: [1, 2, 3] });
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    expect(appearancePick.bound).toBe('minKm');
    expect(setSurfaceAppearance).not.toHaveBeenCalled();
    expect(mesh.surfaceAppearance).toMatchObject({ minKm: -10, maxKm: 10 });
    expect(appearancePick.feedback).toContain('below the current maximum');
  });

  it('rejects a globe or surface overlay without rendered elevation colors', () => {
    const { r, pickSurfaceTintHeight, setSurfaceAppearance } = renderer();
    startAppearancePick('Mars', 'maxKm');
    pickSurfaceTintHeight.mockReturnValue({ bodyName: 'Mars', altKm: 999, bodyFixedHitKm: [1, 2, 3] });
    expect(handleAppearancePick(r, 400, 300)).toBe(true);
    expect(setSurfaceAppearance).not.toHaveBeenCalled();
    expect(appearancePick.bound).toBe('maxKm');
    expect(appearancePick.feedback).toContain('elevation colors');
  });
  it('cancels cleanly and returns ordinary picking to the existing input path', () => {
    const { r, pickSurfaceTintHeight } = renderer();
    startAppearancePick('Mars', 'maxKm');
    expect(cancelAppearancePick()).toBe(true);
    expect(handleAppearancePick(r, 400, 300)).toBe(false);
    expect(pickSurfaceTintHeight).not.toHaveBeenCalled();
  });
});
