import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Body, FixedRotation } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { regolithAngularFactor, REGOLITH_REFLECTANCE_MODELS } from '../RegolithReflectance.js';

describe('regolith direct reflectance', () => {
  it('is finite and bounded across the physically realizable incidence, emission and phase grid', () => {
    const radians = THREE.MathUtils.degToRad;
    for (const model of REGOLITH_REFLECTANCE_MODELS) {
      if (model === 'legacy') continue;
      let max = 0;
      for (const i of [0, 10, 30, 60, 80, 89, 90, 91, 120]) {
        for (const e of [0, 10, 30, 60, 80, 89, 90]) {
          const mu0 = Math.cos(radians(i)), mu = Math.cos(radians(e));
          for (const azimuth of [0, 15, 45, 75, 90, 135, 160, 180]) {
            const phase = mu0 * mu + Math.sin(radians(i)) * Math.sin(radians(e)) * Math.cos(radians(azimuth));
            const value = regolithAngularFactor(model, mu0, mu, phase);
            expect(Number.isFinite(value) && value >= 0).toBe(true);
            if (i > 90) expect(value).toBe(0);
            max = Math.max(max, value);
          }
        }
      }
      expect(max).toBeLessThanOrEqual(2);
      expect(regolithAngularFactor(model, 1, 1, 1)).toBeCloseTo(1, 12);
      expect(regolithAngularFactor(model, 0, 0, 1)).toBe(0);
      expect(regolithAngularFactor(model, 1, -0.001, 0)).toBe(0);
      expect(regolithAngularFactor(model, NaN, 1, 0)).toBe(0);
    }
  });

  it('flattens the opposition disk with Lunar–Lambert and adds azimuthal phase response with Hapke', () => {
    const mu = 0.3;
    expect(regolithAngularFactor('lunar-lambert', mu, mu, 1)).toBeGreaterThan(mu);
    const hapke = (phase: number) => regolithAngularFactor('hapke', 0.5, 0.5, phase);
    expect(hapke(1)).toBeGreaterThan(hapke(0.995));
    expect(hapke(0.995)).toBeGreaterThan(hapke(0.5));
    expect(hapke(0.5)).toBeGreaterThan(hapke(-0.5));
  });

  it('composes the Moon globe hook with eclipse and keeps the selection across lighting modes', () => {
    const bm = new BodyMesh(new Body({
      name: 'Moon', classification: 'moon',
      trajectory: { stateAt: () => ({ position: [0, 0, 0], velocity: [0, 0, 0] }) } as never,
      rotation: new FixedRotation([1, 0, 0, 0], 'ECLIPJ2000'),
      geometryType: 'Globe', geometryData: { type: 'Globe', radius: 1737.4 },
    }));
    bm.enableShadowReceiving();
    bm.setRegolithReflectance('lunar-lambert');
    bm.position.set(1, 2, 3);
    bm.updateRegolithSun(new THREE.Vector3(1, 4, 3));
    const shader = { ...THREE.ShaderLib.standard, uniforms: {} };
    const material = bm.mesh.material as THREE.Material;
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(material.customProgramCacheKey()).toContain('_regolith_globe_shadow_v1');
    expect(shader.fragmentShader).toContain('outgoingLight *= computeEclipseShadow()');
    expect(shader.uniforms).toMatchObject({
      uRegolithModel: { value: 2 }, uRegolithSunWorld: { value: { x: 0, y: 1, z: 0 } },
    });
    bm.setSurfaceLightingMode('shadow');
    expect(shader.uniforms).toMatchObject({ uRegolithModel: { value: 0 } });
    bm.setSurfaceLightingMode('natural');
    expect(shader.uniforms).toMatchObject({ uRegolithModel: { value: 2 } });
  });
});
