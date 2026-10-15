/**
 * Look-at and the zoom floor in the orbit-controlled camera modes.
 *
 * Both used to be handled only on the free-orbit path of `update()`, which the
 * other modes return before reaching. So in a body-fixed frame `pointAtObject`
 * moved nothing, and the zoom floor stayed at whatever free orbit last tracked
 * — a camera placed 5000 km from the Moon's centre was pushed out to Earth's
 * radius. The Earth–Moon scripted tour does both.
 */
import { beforeAll, describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../CameraController.js';
import { CameraModeName } from '../CameraModes.js';
import type { BodyMesh } from '../../BodyMesh.js';

/** Just enough of an element for TrackballControls to attach to. */
function fakeElement(): HTMLElement {
  const listeners = { addEventListener() {}, removeEventListener() {} };
  return {
    ...listeners,
    style: {},
    ownerDocument: { ...listeners, defaultView: listeners, documentElement: { clientLeft: 0, clientTop: 0 } },
    clientWidth: 800,
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLElement;
}

/** A body with no rotation model: body-fixed mode then adds no rotation of its own. */
function fakeBody(name: string, radius: number, position: THREE.Vector3): BodyMesh {
  return {
    position,
    displayRadius: radius,
    scaleFactor: 1,
    hasTerrain: false,
    body: { name, rotation: undefined, rotationAt: () => undefined },
  } as unknown as BodyMesh;
}

// The keyboard controls listen on `window`; nothing here presses a key.
beforeAll(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});

function setup() {
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 1, 1e9);
  const cc = new CameraController(camera, fakeElement());
  const earth = fakeBody('Earth', 6378, new THREE.Vector3(0, 0, -384400));
  const moon = fakeBody('Moon', 1737, new THREE.Vector3(0, 0, 0));
  cc.setModeContext(null, 0, 1, new Map([['Earth', earth], ['Moon', moon]]));
  return { camera, cc, earth, moon };
}

/** Free orbit around Earth first, so its floor is the one left behind. */
function intoMoonBodyFixed({ camera, cc, earth }: ReturnType<typeof setup>) {
  cc.trackBody(earth, 1);
  cc.update();
  expect(cc.controls.minDistance).toBeGreaterThan(6378);
  expect(cc.setMode(CameraModeName.BODY_FIXED, { bodyName: 'Moon' })).toBe(true);
  camera.position.set(5000, 0, 0);
  cc.controls.target.set(0, 0, 0);
  camera.up.set(0, 1, 0);
}

describe('orbit-controlled camera modes', () => {
  it("use the mode body's zoom floor, not the last free-orbit body's", () => {
    const s = setup();
    intoMoonBodyFixed(s);
    s.cc.update();
    expect(s.camera.position.distanceTo(s.moon.position)).toBeCloseTo(5000, 0);
  });

  it('honour a look-at target in body-fixed mode', () => {
    const s = setup();
    intoMoonBodyFixed(s);
    s.cc.lookAt(s.earth);
    s.cc.update();
    const forward = s.camera.getWorldDirection(new THREE.Vector3());
    const toEarth = s.earth.position.clone().sub(s.camera.position).normalize();
    expect(forward.angleTo(toEarth)).toBeLessThan(1e-6);
  });

  it('leave the view direction alone without one', () => {
    const s = setup();
    intoMoonBodyFixed(s);
    s.cc.update();
    const forward = s.camera.getWorldDirection(new THREE.Vector3());
    const toMoon = s.moon.position.clone().sub(s.camera.position).normalize();
    expect(forward.angleTo(toMoon)).toBeLessThan(1e-6);
  });
});
