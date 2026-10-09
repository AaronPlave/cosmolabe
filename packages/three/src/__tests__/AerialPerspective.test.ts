import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { injectAerialPerspectiveIntoShader } from '../AerialPerspective.js';

function stockShader(name: 'phong' | 'standard' | 'physical' | 'basic') {
  return {
    vertexShader: THREE.ShaderLib[name].vertexShader,
    fragmentShader: THREE.ShaderLib[name].fragmentShader,
    uniforms: {} as Record<string, unknown>,
  };
}

describe('incident solar shader injection', () => {
  it.each(['phong', 'standard', 'physical'] as const)('attenuates %s directional radiance before the BRDF', name => {
    const shader = stockShader(name);
    injectAerialPerspectiveIntoShader(shader, {});
    const source = shader.fragmentShader;
    const solarInfo = source.indexOf('getDirectionalLightInfo( directionalLight, directLight );');
    const attenuation = source.indexOf('directLight.color *= computeSurfaceSunTransmittance(vAPWorldPos);');
    expect(solarInfo).toBeGreaterThan(-1);
    expect(attenuation).toBeGreaterThan(solarInfo);
    expect(attenuation).toBeLessThan(source.indexOf('RE_Direct(', solarInfo));
    expect(source).not.toContain('#include <lights_fragment_begin>');
    expect(source.match(/directLight.color \*= computeSurfaceSunTransmittance/g)).toHaveLength(1);
    expect(source).toContain('outgoingLight = outgoingLight * _ap.transmittance + _ap.inscatter;');
  });

  it('retains view transport without injecting solar lighting into unlit materials', () => {
    const shader = stockShader('basic');
    injectAerialPerspectiveIntoShader(shader, {});
    expect(shader.fragmentShader).not.toContain('directLight.color *=');
    expect(shader.fragmentShader).toContain('computeAerialPerspective(vAPWorldPos)');
  });

  it('fails explicitly if a Three.js update removes the directional-light hook', () => {
    const original = THREE.ShaderChunk.lights_fragment_begin;
    try {
      THREE.ShaderChunk.lights_fragment_begin = original.replace(
        'getDirectionalLightInfo( directionalLight, directLight );', '// changed upstream hook',
      );
      expect(() => injectAerialPerspectiveIntoShader(stockShader('standard'), {}))
        .toThrow('Three.js directional-light shader hook changed');
      expect(() => injectAerialPerspectiveIntoShader(stockShader('basic'), {})).not.toThrow();
    } finally {
      THREE.ShaderChunk.lights_fragment_begin = original;
    }
  });
});
