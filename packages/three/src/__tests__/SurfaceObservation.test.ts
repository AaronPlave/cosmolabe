import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, type WebGLRenderer } from 'three';
import { Body, FixedPointTrajectory } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';

describe('streaming observation freshness', () => {
  it('invalidates observed counters when the camera, epoch, viewport or body transform changes', () => {
    const bm = new BodyMesh(new Body({ name: 'Mars', radii: [1, 1, 1], geometryType: 'Globe', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    const camera = new PerspectiveCamera();
    const renderer = { domElement: { width: 800, height: 600 } } as WebGLRenderer;
    expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    const observe = () => bm.observeSurfaceView(camera, renderer, 0);
    observe(); expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(true);
    camera.position.x++; expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    observe(); camera.rotateY(0.1); expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    observe(); expect(bm.surfaceViewIsCurrent(camera, renderer, 1)).toBe(false);
    observe(); renderer.domElement.width++; expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    observe(); bm.mesh.rotateZ(0.1); expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    bm.dispose();
  });
});
