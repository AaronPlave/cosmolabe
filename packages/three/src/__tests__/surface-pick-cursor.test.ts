import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { UniverseRenderer } from '../UniverseRenderer.js';
import type { SpatialInteraction } from '../SpatialRelationshipLayer.js';
import type { SurfacePoint } from '../SceneHit.js';

/** Exercise pointer scheduling without constructing a WebGL renderer. */
function harness() {
  const preview = vi.fn(), probeHover = vi.fn(), setHover = vi.fn(), setPin = vi.fn();
  const interaction = { picking: () => true, surfacePicking: () => true, preview } as unknown as SpatialInteraction;
  const state = {
    spatialInteraction: interaction,
    _probeActive: false, _hoverPointerInside: true, _probeHoverDirty: true,
    _lastHoverPickMs: -Infinity, _probePickCostMs: 0,
    _probePickView: new THREE.Matrix4(), camera: new THREE.PerspectiveCamera(),
    _lastPointer: { x: 100, y: 200 },
    _probe: { setHover, setPin }, _probeHoverAt: probeHover,
    renderer: { domElement: { style: { cursor: '' } } },
    spatialRelationships: { setPickPreview: vi.fn() }, setHoveredBody: vi.fn(),
  };
  const renderer = Object.assign(Object.create(UniverseRenderer.prototype), state) as UniverseRenderer;
  const internal = renderer as unknown as { updateProbeHover(): void };
  return { renderer, internal, state, preview, probeHover, setHover, setPin };
}

describe('shared surface cursor', () => {
  it('picks a moving measurement cursor in the next frame, coalescing events', () => {
    const h = harness();
    h.internal.updateProbeHover();
    expect(h.preview).toHaveBeenCalledExactlyOnceWith(100, 200);
    expect(h.probeHover).not.toHaveBeenCalled();
    h.internal.updateProbeHover();
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it('applies the probe cost budget to dense measurement surface picks', () => {
    const h = harness();
    Object.assign(h.renderer, { _lastHoverPickMs: performance.now(), _probePickCostMs: 100 });
    h.internal.updateProbeHover();
    expect(h.preview).not.toHaveBeenCalled();
    Object.assign(h.renderer, { _lastHoverPickMs: performance.now() - 500 });
    h.internal.updateProbeHover();
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it('shares cursor visuals without modifying the independent probe pin', () => {
    const h = harness();
    const point = { bodyName: 'Earth', bodyFixedPositionKm: [1, 2, 3] } as unknown as SurfacePoint;
    h.renderer.setSpatialSurfacePreview(point);
    expect(h.setHover).toHaveBeenLastCalledWith(point);
    expect(h.state.renderer.domElement.style.cursor).toBe('none');
    h.renderer.clearSpatialPickPreview();
    expect(h.setHover).toHaveBeenLastCalledWith(null);
    expect(h.state.renderer.domElement.style.cursor).toBe('');
    expect(h.setPin).not.toHaveBeenCalled();
  });

  it('retains normal probe picking and does not run surface casts for object picks', () => {
    const h = harness();
    h.state.spatialInteraction.surfacePicking = () => false;
    h.internal.updateProbeHover();
    expect(h.preview).not.toHaveBeenCalled();
    Object.assign(h.renderer, { _probeActive: true });
    h.state.spatialInteraction.picking = () => false;
    h.internal.updateProbeHover();
    expect(h.probeHover).toHaveBeenCalledExactlyOnceWith(100, 200);
  });
});
