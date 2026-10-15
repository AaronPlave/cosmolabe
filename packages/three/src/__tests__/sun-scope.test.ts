import { expect, it } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { BLOOM_LAYER } from '../BloomEffect.js';
import { SOLAR_LAYER, resolvedSolarWeight } from '../SunVisual.js';

it('keeps arbitrary stars on the generic textured/emissive material path', () => {
  const body = (name: string) => new Body({ name, classification: 'star', radii: [1, 1, 1],
    trajectory: new FixedPointTrajectory([0, 0, 0]), geometryType: 'Globe' });
  const star = new BodyMesh(body('Sirius'));
  const sun = new BodyMesh(body('Sun'));
  expect(star.sunVisual).toBeNull();
  expect(star.mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
  expect(star.mesh.layers.isEnabled(BLOOM_LAYER)).toBe(true);
  expect(sun.sunVisual).not.toBeNull();
  expect(sun.mesh.layers.isEnabled(SOLAR_LAYER)).toBe(true);
  star.dispose(); sun.dispose();
});

it('shifts small solar disks toward optical presentation before five pixels', () => {
  expect(resolvedSolarWeight(16)).toBe(1);
  expect(resolvedSolarWeight(12)).toBeLessThan(1);
  expect(resolvedSolarWeight(8)).toBeLessThan(0.5);
  expect(resolvedSolarWeight(5)).toBeLessThan(0.05);
  expect(resolvedSolarWeight(4)).toBe(0);
});
