/**
 * The navigation verbs on a real `CameraController`: focus, frame, fly (direct
 * and overview), stopping a flight, and manual input during one.
 *
 * Frames run in the renderer's order — origin switch, body positions under the
 * new origin, then `update()` — so a landing is checked the way it happens.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../CameraController.js';
import { CameraModeName } from '../CameraModes.js';
import type { BodyMesh } from '../../BodyMesh.js';

type Listener = (e: unknown) => void;

/** Just enough of an element for TrackballControls, keeping the listeners. */
function fakeElement(width = 800, height = 600) {
  const listeners = new Map<string, Listener[]>();
  const add = (type: string, fn: Listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  };
  const noop = { addEventListener() {}, removeEventListener() {} };
  const el = {
    addEventListener: add,
    removeEventListener() {},
    style: {},
    ownerDocument: { ...noop, defaultView: noop, documentElement: { clientLeft: 0, clientTop: 0 } },
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLElement;
  const fire = (type: string, e: unknown) => {
    for (const fn of listeners.get(type) ?? []) fn(e);
  };
  return { el, fire };
}

function fakeBody(name: string, radius: number, position: THREE.Vector3): BodyMesh {
  return {
    position,
    displayRadius: radius,
    scaleFactor: 1,
    hasTerrain: false,
    body: { name, rotation: undefined, rotationAt: () => undefined },
  } as unknown as BodyMesh;
}

beforeAll(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const close = (v: THREE.Vector3, x: number, y: number, z: number, digits = 3) => {
  expect(v.x).toBeCloseTo(x, digits);
  expect(v.y).toBeCloseTo(y, digits);
  expect(v.z).toBeCloseTo(z, digits);
};

/**
 * Earth at the origin, tracked, the camera 20 000 km out on +Z; the Moon off
 * to one side. Body positions are relative to whichever body is the origin, as
 * the renderer keeps them.
 */
function setup(opts: { width?: number; height?: number } = {}) {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { el, fire } = fakeElement(opts.width, opts.height);
  const camera = new THREE.PerspectiveCamera(60, (opts.width ?? 800) / (opts.height ?? 600), 1, 1e12);
  const cc = new CameraController(camera, el);
  const earthAbs = new THREE.Vector3(0, 0, 0);
  const moonAbs = new THREE.Vector3(300000, 0, -200000);
  const earth = fakeBody('Earth', 6378, earthAbs.clone());
  const moon = fakeBody('Moon', 1737, moonAbs.clone());
  cc.setModeContext(null, 0, 1, new Map([['Earth', earth], ['Moon', moon]]));
  cc.focus(earth);
  camera.position.set(0, 0, 20000);
  camera.up.set(0, 1, 0);
  cc.controls.target.set(0, 0, 0);
  camera.lookAt(cc.controls.target);

  /** Re-derive body positions under the current origin, as a frame would. */
  const place = () => {
    const origin = cc.originBody === moon ? moonAbs : earthAbs;
    earth.position.copy(earthAbs).sub(origin);
    moon.position.copy(moonAbs).sub(origin);
  };
  const frame = (seconds: number) => {
    now += seconds * 1000;
    cc.applyPendingOriginSwitch();
    place();
    cc.update();
  };
  /** The camera's position in absolute coordinates. */
  const absolute = (v: THREE.Vector3) => v.clone().add(cc.originBody === moon ? moonAbs : earthAbs);
  return { camera, cc, earth, moon, moonAbs, frame, absolute, fire };
}

describe('focus', () => {
  it('anchors on the body without moving the camera', () => {
    const { camera, cc, moon, absolute } = setup();
    const before = absolute(camera.position);
    cc.focus(moon);
    expect(cc.trackedBody).toBe(moon);
    expect(cc.originBody).toBe(moon);
    // Same place in space, now in the Moon's coordinates — and facing it.
    const after = absolute(camera.position);
    close(after, before.x, before.y, before.z);
    close(cc.controls.target, 0, 0, 0);
  });

  it('keeps holding it frame after frame', () => {
    const { cc, moon, frame } = setup();
    cc.focus(moon);
    for (let i = 0; i < 3; i++) frame(0.1);
    expect(cc.trackedBody).toBe(moon);
    close(cc.controls.target, 0, 0, 0);
  });

  it('re-parameterizes a body-fixed frame onto the new body', () => {
    const { cc, moon } = setup();
    const setModeForBody = vi.spyOn(cc, 'setModeForBody');
    cc.setMode(CameraModeName.BODY_FIXED, { bodyName: 'Earth' });
    cc.focus(moon);
    expect(setModeForBody).toHaveBeenCalledWith(CameraModeName.BODY_FIXED, moon);
  });
});

describe('frame', () => {
  it('fits the body at three radii in a landscape 60° view, from the side the camera sees it', () => {
    const { camera, cc, moon, moonAbs, absolute } = setup();
    const side = new THREE.Vector3(0, 0, 20000).sub(moonAbs).normalize();
    cc.frame(moon, { scaleFactor: 1 });
    expect(cc.trackedBody).toBe(moon);
    expect(camera.position.length()).toBeCloseTo(1737 * 3, 3);
    const offset = absolute(camera.position).sub(moonAbs).normalize();
    close(offset, side.x, side.y, side.z);
  });

  it('stands further back in a portrait viewport, so the body still fits across', () => {
    const { cc, moon } = setup({ width: 400, height: 800 });
    expect(cc.framingDistance(moon, 1)).toBeGreaterThan(1737 * 3);
  });

  it('lands on the pose a direct flight lands on', () => {
    const a = setup();
    a.cc.frame(a.moon, { scaleFactor: 1 });
    const framed = a.camera.position.clone();

    const b = setup();
    b.cc.flyTo(b.moon, { scaleFactor: 1, duration: 1 });
    for (let i = 0; i < 6; i++) b.frame(0.3);
    expect(b.cc.flight).toBeNull();
    expect(b.cc.trackedBody).toBe(b.moon);
    close(b.camera.position, framed.x, framed.y, framed.z, 2);
  });
});

describe('flyTo', () => {
  it('reports the flight while it plays, and nothing once it has landed', () => {
    const { cc, moon, frame } = setup();
    cc.flyTo(moon, { scaleFactor: 1, duration: 1 });
    expect(cc.flight).toEqual({ destination: moon, path: 'direct', phase: 'approach' });
    expect(cc.focusBody).toBe(moon);
    frame(0.5);
    expect(cc.flight?.destination).toBe(moon);
    for (let i = 0; i < 4; i++) frame(0.3);
    expect(cc.flight).toBeNull();
    expect(cc.trackedBody).toBe(moon);
    expect(cc.originBody).toBe(moon);
  });

  it('is direct unless overview is asked for', () => {
    const { cc, moon } = setup();
    cc.flyTo(moon, { scaleFactor: 1 });
    expect(cc.flight?.path).toBe('direct');
  });

  it('overview pulls back to show both ends, then approaches', () => {
    const { camera, cc, moon, moonAbs, frame } = setup();
    cc.flyTo(moon, { scaleFactor: 1, duration: 2, path: 'overview' });
    expect(cc.flight).toEqual({ destination: moon, path: 'overview', phase: 'overview' });
    expect(cc.focusBody).toBe(moon);

    // The pull-back is 40% of the flight. At its end the camera looks at the
    // midpoint, from far enough out that both ends are inside the view.
    for (let i = 0; i < 8; i++) frame(0.1);
    frame(0.01);
    expect(cc.flight?.phase).toBe('approach');
    const mid = moonAbs.clone().multiplyScalar(0.5);
    const reach = camera.position.distanceTo(mid);
    // Both ends within half the (vertical, here narrower) field of view.
    expect(Math.asin(moonAbs.length() / 2 / reach)).toBeLessThan(THREE.MathUtils.degToRad(30));

    for (let i = 0; i < 20; i++) frame(0.1);
    expect(cc.flight).toBeNull();
    expect(cc.trackedBody).toBe(moon);
    expect(camera.position.length()).toBeCloseTo(1737 * 3, 1);
  });

  it('overview from a camera already far back is a direct flight', () => {
    const { camera, cc, moon } = setup();
    camera.position.set(0, 5e7, 0);
    cc.flyTo(moon, { scaleFactor: 1, path: 'overview' });
    expect(cc.flight).toEqual({ destination: moon, path: 'overview', phase: 'approach' });
  });

  it('overview looks across the line between the two ends, not along it', () => {
    const { camera, cc, moon, moonAbs, frame } = setup();
    // Camera behind Earth, on the line from the Moon through Earth.
    camera.position.copy(moonAbs).normalize().multiplyScalar(-20000);
    cc.flyTo(moon, { scaleFactor: 1, duration: 1, path: 'overview' });
    for (let i = 0; i < 4; i++) frame(0.1);
    frame(0.001);
    const view = camera.getWorldDirection(new THREE.Vector3());
    const axis = moonAbs.clone().normalize();
    expect(Math.abs(view.dot(axis))).toBeLessThan(1e-6);
  });
});

describe('stopFlight', () => {
  it('leaves the camera where it is and focuses the destination', () => {
    const { camera, cc, moon, frame, absolute } = setup();
    cc.flyTo(moon, { scaleFactor: 1, duration: 2, path: 'overview' });
    frame(0.4);
    const there = absolute(camera.position);
    expect(cc.stopFlight()).toBe(true);
    expect(cc.flight).toBeNull();
    frame(0.1);
    expect(cc.trackedBody).toBe(moon);
    const after = absolute(camera.position);
    close(after, there.x, there.y, there.z, 0);
  });

  it('is false with nothing flying', () => {
    const { cc } = setup();
    expect(cc.stopFlight()).toBe(false);
  });

  it('drops a scripted move queued behind the flight', () => {
    const { cc, moon } = setup();
    cc.flyTo(moon, { scaleFactor: 1 });
    cc.dolly(1000, 1);
    expect(cc.moving).toBe(true);
    cc.stopFlight();
    expect(cc.moving).toBe(false);
  });
});

describe('manual input during a flight', () => {
  it('a wheel zoom stops the flight and lands focus on the destination', () => {
    const { cc, moon, frame, fire } = setup();
    cc.flyTo(moon, { scaleFactor: 1, duration: 2 });
    frame(0.3);
    fire('wheel', { shiftKey: false, deltaY: 100, deltaX: 0, deltaMode: 0, preventDefault() {}, stopPropagation() {} });
    frame(0.05);
    expect(cc.flight).toBeNull();
    frame(0.05);
    expect(cc.trackedBody).toBe(moon);
  });

  it('a shift+wheel field-of-view change does not', () => {
    const { cc, moon, frame, fire } = setup();
    cc.flyTo(moon, { scaleFactor: 1, duration: 2 });
    frame(0.3);
    fire('wheel', { shiftKey: true, deltaY: 100, deltaX: 0, deltaMode: 0, preventDefault() {}, stopPropagation() {} });
    frame(0.05);
    expect(cc.flight).not.toBeNull();
  });

  it('a click does not, a drag does', () => {
    const { cc, moon, frame } = setup();
    const travel = (px: number) =>
      (cc as unknown as { _notePressTravel(dx: number, dy: number): void })._notePressTravel(px, 0);
    cc.flyTo(moon, { scaleFactor: 1, duration: 2 });
    travel(1);
    frame(0.1);
    expect(cc.flight).not.toBeNull();
    travel(5);
    frame(0.1);
    expect(cc.flight).toBeNull();
  });

  it('a scripted move stops too, rather than fighting the drag', () => {
    const { cc, frame, fire } = setup();
    cc.orbitTarget('up', Math.PI, 2);
    frame(0.1);
    expect(cc.moving).toBe(true);
    fire('wheel', { shiftKey: false, deltaY: 100, deltaX: 0, deltaMode: 0, preventDefault() {}, stopPropagation() {} });
    frame(0.1);
    expect(cc.moving).toBe(false);
  });
});

describe('look-at', () => {
  it('is cleared by every navigation, so it cannot override the view landed on', () => {
    for (const go of ['focus', 'frame', 'flyTo'] as const) {
      const { cc, earth, moon } = setup();
      cc.lookAt(earth);
      cc[go](moon);
      expect(cc.lookAtBody, go).toBeNull();
    }
  });
});
