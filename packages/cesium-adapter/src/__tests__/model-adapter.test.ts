import { describe, it, expect } from 'vitest';
import { Body } from '@cosmolabe/core';
import { FixedPointTrajectory } from '@cosmolabe/core';
import { getModelInfo } from '../ModelAdapter.js';

describe('ModelAdapter', () => {
  function makeBody(geometryType: string, geometryData: Record<string, unknown>): Body {
    return new Body({
      name: 'TestBody',
      trajectory: new FixedPointTrajectory([0, 0, 0]),
      geometryType,
      geometryData,
    });
  }

  it('returns model info for glTF body', () => {
    const body = makeBody('Mesh', { source: 'models/spacecraft.glb', size: 0.01 });
    const info = getModelInfo(body);
    expect(info).toBeDefined();
    expect(info!.uri).toBe('models/spacecraft.glb');
    expect(info!.scale).toBe(10); // 0.01 km * 1000 = 10 meters
  });

  it('returns undefined for cmod body', () => {
    const body = makeBody('Mesh', { source: 'models/iss/iss.cmod', size: 0.1 });
    const info = getModelInfo(body);
    expect(info).toBeUndefined();
  });

  it('returns undefined for non-Mesh geometry', () => {
    const body = makeBody('Globe', { source: 'textures/earth.jpg' });
    const info = getModelInfo(body);
    expect(info).toBeUndefined();
  });

  it('uses modelResolver to transform URI', () => {
    const body = makeBody('Mesh', { source: 'models/craft.glb', size: 0.005 });
    const info = getModelInfo(body, (src) => `https://cdn.example.com/${src}`);
    expect(info).toBeDefined();
    expect(info!.uri).toBe('https://cdn.example.com/models/craft.glb');
  });

  it('includes meshRotation when present', () => {
    const body = makeBody('Mesh', {
      source: 'models/craft.glb',
      size: 0.01,
      meshRotation: [0.707, 0, 0.707, 0],
    });
    const info = getModelInfo(body);
    expect(info).toBeDefined();
    expect(info!.meshRotation).toEqual([0.707, 0, 0.707, 0]);
  });

  it('returns undefined when resolver returns undefined', () => {
    const body = makeBody('Mesh', { source: 'models/missing.glb', size: 0.01 });
    const info = getModelInfo(body, () => undefined);
    expect(info).toBeUndefined();
  });
});
