/**
 * Selection through main's shared pick pipeline (`pickScene` → body layer →
 * `_discoverBodyMesh`): the raycast finds the body as it always has, and a
 * visual drawn on that body (an observation's footprints) is then asked, by a
 * surface-containment test, whether the hit point is on it. The observation
 * wins over the ground under it; nothing else changes — no visual geometry is
 * raycast, and a click on another body is untouched.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Body } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { UniverseRenderer } from '../UniverseRenderer.js';

const fixedPoint = { stateAt: () => ({ position: [0, 0, 0], velocity: [0, 0, 0] }) } as never;

function stubRenderer(onSurface: (bodyName: string, point: THREE.Vector3) => boolean, visualVisible = true) {
  const titan = new BodyMesh(new Body({ name: 'Titan', trajectory: fixedPoint, radii: [1, 1, 1], geometryType: 'Globe' }));
  titan.mesh.scale.setScalar(1);
  titan.updateMatrixWorld(true);
  const visual = new THREE.Group();
  visual.visible = visualVisible;
  const pickOnSurface = vi.fn((_obj: THREE.Object3D, bodyName: string, point: THREE.Vector3) => onSurface(bodyName, point));
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
    camera,
    bodyMeshes: new Map([['Titan', titan]]),
    _customVisuals: new Map([['Titan mosaic', visual]]),
    _visualizers: new Map([['Observations', { pickOnSurface }]]),
    universe: { getBody: (n: string) => (n === 'Titan mosaic' ? { geometryType: 'Observations' } : undefined) },
    _dblClickRaycaster: new THREE.Raycaster(),
  }) as { _discoverBodyMesh(x: number, y: number): string | null };
  return { renderer, pickOnSurface };
}

describe('observation picking through the body layer', () => {
  it('a hit inside a footprint selects the observation, with the surface point the raycast found', () => {
    const { renderer, pickOnSurface } = stubRenderer(() => true);
    expect(renderer._discoverBodyMesh(0, 0)).toBe('Titan mosaic');
    const [, bodyName, point] = pickOnSurface.mock.calls[0]!;
    expect(bodyName).toBe('Titan');
    expect(point.length()).toBeCloseTo(1, 2); // on the sphere, facing the camera
    expect(point.z).toBeGreaterThan(0.9);
  });

  it('a hit outside every footprint selects the body, as before', () => {
    expect(stubRenderer(() => false).renderer._discoverBodyMesh(0, 0)).toBe('Titan');
  });

  it('a hidden observation is not asked', () => {
    const { renderer, pickOnSurface } = stubRenderer(() => true, false);
    expect(renderer._discoverBodyMesh(0, 0)).toBe('Titan');
    expect(pickOnSurface).not.toHaveBeenCalled();
  });

  it('a miss is still a miss', () => {
    const { renderer, pickOnSurface } = stubRenderer(() => true);
    expect(renderer._discoverBodyMesh(0.95, 0.95)).toBeNull();
    expect(pickOnSurface).not.toHaveBeenCalled();
  });
});
