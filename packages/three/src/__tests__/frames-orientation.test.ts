import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Universe, FixedRotation, type CatalogJson } from '@cosmolabe/core';
import type { BodyMesh } from '../BodyMesh.js';
import { bodyWorldOrientation } from '../controls/CameraModes.js';

/**
 * The renderer orients bodies through the universe's frame registry, the same
 * one `absolutePositionOf` positions them with. A rotation stated in a
 * catalog-declared frame must reach the mesh and camera orientation; the
 * built-in registry alone cannot see it.
 */
describe('renderer orientation uses the universe frame registry', () => {
  it('composes a rotation stated in a catalog-declared frame', () => {
    const half = Math.SQRT1_2;
    const u = new Universe();
    u.loadCatalog({
      name: 'tilted',
      frames: [{ name: 'TILT', base: 'ECLIPJ2000', quaternion: [half, half, 0, 0] }],
      items: [{ name: 'Probe', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } }],
    } as unknown as CatalogJson);
    const probe = u.getBody('Probe')!;
    probe.setRotation(new FixedRotation([1, 0, 0, 0], 'TILT'));

    const expected = u.bodyToWorldQuat(probe, 0)!;
    const withRegistry = bodyWorldOrientation({ body: probe, frames: u.frames } as unknown as BodyMesh, 0, new THREE.Quaternion())!;
    const without = bodyWorldOrientation({ body: probe } as unknown as BodyMesh, 0, new THREE.Quaternion())!;

    const exp = new THREE.Quaternion(expected[1], expected[2], expected[3], expected[0]);
    // angleTo is acos(|dot|), floored near 3e-8 rad by double rounding.
    expect(withRegistry.angleTo(exp)).toBeLessThan(1e-6);
    // Without the universe's registry the declared frame is invisible: ~90° off.
    expect(without.angleTo(exp)).toBeGreaterThan(1.5);
  });
});
