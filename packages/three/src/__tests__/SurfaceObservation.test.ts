import { describe, expect, it } from 'vitest';
import { Group, PerspectiveCamera, type WebGLRenderer } from 'three';
import { Body, FixedPointTrajectory } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';

describe('streaming observation freshness', () => {
  it('invalidates observed counters when the camera, epoch, viewport or body transform changes', () => {
    const bm = new BodyMesh(new Body({ name: 'Mars', radii: [1, 1, 1], geometryType: 'Globe', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    Object.assign(bm, { terrainVisible: true, terrainManager: { viewUpdateSucceeded: true } });
    const camera = new PerspectiveCamera();
    const renderer = { domElement: { width: 800, height: 600 } } as WebGLRenderer;
    expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    const observe = () => bm.observeSurfaceView(camera, renderer, 0);
    observe(); expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(true);
    camera.position.x++; expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    observe(); camera.rotateY(0.1); expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    observe(); expect(bm.surfaceViewIsCurrent(camera, renderer, 1)).toBe(false);
    observe(); renderer.domElement.width++; expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    observe();
    Object.assign(bm, { terrainVisible: false }); observe(); expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    Object.assign(bm, { terrainVisible: true, terrainManager: { viewUpdateSucceeded: false } }); observe(); expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    Object.assign(bm, { terrainManager: { viewUpdateSucceeded: true } });
    observe(); bm.mesh.rotateZ(0.1); expect(bm.surfaceViewIsCurrent(camera, renderer, 0)).toBe(false);
    Object.assign(bm, { terrainManager: null });
    bm.dispose();
  });
  it('stamps only successful streamed draws across static, preloading, waiting and fallback transitions', () => {
    const bm = new BodyMesh(new Body({ name: 'Mars', radii: [1,1,1], geometryType: 'Globe', trajectory: new FixedPointTrajectory([0,0,0]) }));
    const camera = new PerspectiveCamera(), renderer = { domElement: { width: 800, height: 600 } } as WebGLRenderer;
    let failed = false, ready = true;
    const manager = { group: new Group(), preloadAtPixels: 40, showAtPixels: 80, viewUpdateSucceeded: false,
      hasStreamFailed: () => failed, resetShowWait: () => {}, isReadyToShow: () => ready,
      update: () => { manager.viewUpdateSucceeded = true; } };
    Object.assign(bm, { terrainManager: manager });
    const step = (pixels: number) => { bm.updateTerrain(camera, renderer, pixels); bm.observeSurfaceView(camera, renderer, 0); return bm.surfaceViewIsCurrent(camera, renderer, 0); };
    expect(step(100)).toBe(true); expect(bm.surfaceTransitionState).toBe('streamed');
    expect(step(0)).toBe(false); expect(bm.surfaceTransitionState).toBe('static');
    expect(step(60)).toBe(false); expect(bm.surfaceTransitionState).toBe('preloading');
    ready = false; expect(step(100)).toBe(false); expect(bm.surfaceTransitionState).toBe('waiting');
    ready = true; expect(step(100)).toBe(true);
    failed = true; expect(step(100)).toBe(false); expect(bm.surfaceTransitionState).toBe('fallback');
    Object.assign(bm, { terrainManager: null }); bm.dispose();
  });

});
