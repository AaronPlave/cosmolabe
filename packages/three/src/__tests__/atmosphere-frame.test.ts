import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { UniverseRenderer } from '../UniverseRenderer.js';
import { AtmosphereMesh, getAtmospherePreset } from '../AtmosphereMesh.js';
import { SkyViewLUT } from '../SkyViewLUT.js';
import { normalizeAtmosphere } from '../AtmosphereModel.js';
import type { SolarExposurePolicy } from '../index.js';
import { FIXED_REFERENCE_SOLAR_EXPOSURE } from '../SolarRadiometry.js';
import { makeAerialPerspectiveUniforms } from '../AerialPerspective.js';

// Exercise the actual per-view refresh without constructing a WebGL renderer.
// The shell, globe hierarchy and aerial-perspective uniforms are real
// Three.js objects; no WebGL context is required for the per-view refresh.
describe('atmosphere planet frame', () => {
  it.each([false, true])('uses instrument star brightness and restores main state (draw throws: %s)', throws => {
    const camera = new THREE.PerspectiveCamera();
    const instrumentCamera = new THREE.PerspectiveCamera();
    let brightness = 0;
    const setSkyBrightness = vi.fn((value: number) => { brightness = value; });
    const state = {
      camera, starField: { setSkyBrightness }, renderer: {}, scene: {},
      updateAtmospheres: vi.fn((observer: THREE.Camera) => observer === camera ? 0 : 0.8),
      instrumentView: { camera: instrumentCamera, render: vi.fn(() => {
        expect(brightness).toBe(0.8);
        if (throws) throw new Error('instrument draw failed');
      }) },
    };
    const draw = (UniverseRenderer.prototype as unknown as { renderInstrumentScene: () => void }).renderInstrumentScene;
    if (throws) expect(() => draw.call(state)).toThrow('instrument draw failed');
    else draw.call(state);
    expect(state.updateAtmospheres.mock.calls).toEqual([[instrumentCamera], [camera, false]]);
    expect(brightness).toBe(0);
    expect(setSkyBrightness).toHaveBeenLastCalledWith(0);
  });

  it('restores the main sky texture without reintegrating either observer lookup', () => {
    // Supply a renderer stub after construction to skip unrelated static LUT
    // initialization, while exercising real SkyViewLUT rendering and selection.
    const atmosphere = new AtmosphereMesh(6371, getAtmospherePreset('Earth')!);
    const renderer = { autoClear: true, getRenderTarget: () => null,
      setRenderTarget: vi.fn(), render: vi.fn() };
    const state = atmosphere as unknown as { _renderer: THREE.WebGLRenderer; _skyView: SkyViewLUT };
    state._renderer = renderer as unknown as THREE.WebGLRenderer;
    state._skyView = new SkyViewLUT((atmosphere.material as THREE.ShaderMaterial).uniforms);
    const uniforms = (atmosphere.material as THREE.ShaderMaterial).uniforms;
    const main = new THREE.Vector3(0, 0.99, 0);
    const instrument = new THREE.Vector3(0.99, 0, 0);
    const sun = new THREE.Vector3(0, 100, 0);
    try {
      atmosphere.update(main, sun);
      const mainTexture = uniforms.uSkyViewLUT.value;
      atmosphere.update(instrument, sun, undefined, undefined, undefined, undefined, 'instrument');
      expect(uniforms.uSkyViewLUT.value).not.toBe(mainTexture);
      atmosphere.update(main, sun, undefined, undefined, undefined, undefined, 'main', false);
      expect(uniforms.uSkyViewLUT.value).toBe(mainTexture);
      expect(renderer.render).toHaveBeenCalledTimes(2);
    } finally { atmosphere.dispose(); }
  });

  it.each<SolarExposurePolicy>([
    { mode: 'legacy-observer-adapted' },
    { mode: 'fixed-reference' },
    { mode: 'fixed-reference', exposure: 123 },
  ])('refreshes transport matrices and exposure for $mode ($exposure)', solarExposurePolicy => {
    const scaleFactor = 1e-6;
    const model = normalizeAtmosphere(getAtmospherePreset('Saturn')!);
    const body = new BodyMesh(new Body({ name: 'Saturn', geometryType: 'Globe',
      radii: [60268, 60268, 54364], trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    const scene = new THREE.Scene();
    scene.add(body);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0.1, 0.2, 0.3);
    const atmosphere = new AtmosphereMesh(60268, getAtmospherePreset('Saturn')!);
    const update = vi.spyOn(atmosphere, 'update');
    scene.add(atmosphere);
    const ap = makeAerialPerspectiveUniforms(model, 60268, scaleFactor, null);
    const methods = UniverseRenderer.prototype as unknown as { fixedSolarExposure: () => number | undefined };
    const state = { solarExposurePolicy, fixedSolarExposure: methods.fixedSolarExposure,
      scaleFactor, bodyMeshes: new Map([['Saturn', body]]),
      atmosphereMeshes: new Map([['Saturn', { atm: atmosphere, parentName: 'Saturn' }]]),
      aerialPerspectiveUniforms: new Map([['Saturn', ap]]),
      _shadowOccluderCache: new Map(), _sunRadiusKm: 695000 };
    const refresh = (UniverseRenderer.prototype as unknown as {
      updateAtmospheres: (camera: THREE.Camera) => number;
    }).updateAtmospheres;
    try {
      body.updatePosition([100000, 200000, -300000], 0, scaleFactor);
      body.applyMeshScale(scaleFactor);
      scene.updateMatrixWorld(true); // The previous rendered frame.
      for (const position of [[150000, 210000, -320000], [90000, 240000, -350000]]) {
        body.updatePosition(position as [number, number, number], 0, scaleFactor);
        body.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
        refresh.call(state, camera);
        const fixed = solarExposurePolicy.mode === 'fixed-reference'
          ? solarExposurePolicy.exposure ?? FIXED_REFERENCE_SOLAR_EXPOSURE : undefined;
        expect(update.mock.lastCall?.[8]).toBe(fixed);
        const exposure = (atmosphere.material as THREE.ShaderMaterial).uniforms.uSolarExposure.value;
        expect(exposure).toBeGreaterThan(0);
        if (fixed !== undefined) expect(exposure).toBe(fixed);
        expect(ap.uSolarExposure.value).toBe(exposure);
        // Rendering now updates the hierarchy. The transport matrices must
        // already describe exactly this frame, rather than catching up next time.
        scene.updateMatrixWorld(true);
        expect(ap.uAPPlanetToWorld.value.elements).toEqual(body.mesh.matrixWorld.elements);
        const origin = new THREE.Vector3().applyMatrix4(body.mesh.matrixWorld)
          .applyMatrix4(ap.uAPWorldToPlanet.value);
        expect(origin.length()).toBeLessThan(1e-8);
      }
    } finally { atmosphere.dispose(); body.dispose(); }
  });
});
