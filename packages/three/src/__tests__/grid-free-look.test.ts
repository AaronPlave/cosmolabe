import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory } from '@cosmolabe/core';
import { normalizeGridSettings } from '@cosmolabe/control';
import { BodyMesh } from '../BodyMesh.js';
import { UniverseRenderer } from '../UniverseRenderer.js';
import { CameraController } from '../controls/CameraController.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps the scene-origin grid after a real right-button free-look drag and follows the next focus', () => {
  const view = Object.assign(new EventTarget(), { pageXOffset: 0, pageYOffset: 0 });
  vi.stubGlobal('window', view);
  const document = Object.assign(new EventTarget(), { defaultView: view, documentElement: { clientLeft: 0, clientTop: 0 } });
  const element = Object.assign(new EventTarget(), { style: {}, ownerDocument: document, clientWidth: 800, clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), setPointerCapture() {}, releasePointerCapture() {} });
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.01, 10000);
  camera.position.set(300, 0, 0); camera.up.set(0, 0, 1);
  const controller = new CameraController(camera, element as unknown as HTMLElement);
  const body = (name: string) => new BodyMesh(new Body({ name, trajectory: new FixedPointTrajectory([0, 0, 0]),
    radii: [100, 100, 100], geometryType: 'Globe' }));
  const earth = body('Earth'), moon = body('Moon');
  const earthGrid = vi.spyOn(earth, 'showGrid'), moonGrid = vi.spyOn(moon, 'showGrid');
  // Exercise renderer grid synchronization without constructing a WebGL context.
  const renderer = Object.assign(Object.create(UniverseRenderer.prototype) as object, {
    cameraController: controller, bodyMeshes: new Map([['Earth', earth], ['Moon', moon]]),
    _gridSettings: normalizeGridSettings(), _gridVisible: false, _markerScene: new THREE.Scene(),
  }) as unknown as UniverseRenderer;
  controller.track(earth); renderer.showBodyGrid(true);
  const pointer = (type: string, x: number) => Object.assign(new Event(type), { pointerType: 'mouse', pointerId: 1,
    button: 2, buttons: 2, clientX: x, clientY: 100, isPrimary: true });
  element.dispatchEvent(pointer('pointerdown', 100));
  view.dispatchEvent(pointer('pointermove', 101));
  controller.update();
  view.dispatchEvent(pointer('pointerup', 101));
  expect(controller.trackedBody).toBeNull();
  expect(controller.originBody).toBe(earth);
  renderer.showBodyGrid(true);
  expect(earthGrid).toHaveBeenLastCalledWith(true, true, expect.any(Object));
  expect(moonGrid).toHaveBeenLastCalledWith(false, true, expect.any(Object));
  controller.track(moon); renderer.showBodyGrid(true);
  expect(earthGrid).toHaveBeenLastCalledWith(false, true, expect.any(Object));
  expect(moonGrid).toHaveBeenLastCalledWith(true, true, expect.any(Object));
  renderer.showBodyGrid(false);
  expect(moonGrid).toHaveBeenLastCalledWith(false, true, expect.any(Object));
  controller.dispose(); earth.dispose(); moon.dispose();
});
