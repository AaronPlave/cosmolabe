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
import type { InstrumentMode } from '../modes/InstrumentMode.js';
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

function fakeBody(
  name: string, radius: number, position: THREE.Vector3,
  opts: { classification?: string; parentName?: string } = {},
): BodyMesh {
  return {
    position,
    displayRadius: radius,
    scaleFactor: 1,
    hasTerrain: false,
    body: { name, ...opts, rotation: undefined, rotationAt: () => undefined },
  } as unknown as BodyMesh;
}

/** A SPICE state for every body: 1000 km out on +X, moving along +Y. */
const fakeSpice = {
  pxform: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  spkezr: () => ({ state: [1000, 0, 0, 0, 1, 0] as [number, number, number, number, number, number], lightTime: 0 }),
};

/** Whether the camera looks straight at `point`. */
const facing = (camera: THREE.PerspectiveCamera, point: THREE.Vector3) => {
  const view = camera.getWorldDirection(new THREE.Vector3());
  return view.dot(point.clone().sub(camera.position).normalize());
};

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
  const bodies = new Map([['Earth', earth], ['Moon', moon]]);
  cc.setModeContext(null, 0, 1, bodies);
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
  return { camera, cc, earth, moon, moonAbs, bodies, frame, absolute, fire };
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
  it('jumps to a surface offset and holds its aim over subsequent frames, then clears it on body navigation', () => {
    const { camera, cc, moon, frame } = setup();
    (moon as unknown as { mesh: THREE.Mesh }).mesh = new THREE.Mesh();
    const targetOffset = new THREE.Vector3(1737, 0, 0);
    const offset = new THREE.Vector3(1767, 0, 0);
    cc.frame(moon, { offset, targetOffset, up: new THREE.Vector3(0, 1, 0) });
    for (let i = 0; i < 5; i++) frame(0.1);
    close(camera.position, 1767, 0, 0);
    close(cc.controls.target, 1737, 0, 0);
    expect(facing(camera, targetOffset)).toBeCloseTo(1);
    cc.frame(moon);
    frame(0.1);
    close(cc.controls.target, 0, 0, 0);
  });

  it('flies through the shared animation and origin switch to the same surface pose as Jump', () => {
    const { camera, cc, moon, frame } = setup();
    (moon as unknown as { mesh: THREE.Mesh }).mesh = new THREE.Mesh();
    const targetOffset = new THREE.Vector3(0, 0, 1737);
    const offset = new THREE.Vector3(0, 0, 1777);
    cc.flyTo(moon, { offset, targetOffset, duration: 1 });
    for (let i = 0; i < 15; i++) frame(0.1);
    expect(cc.animating).toBe(false);
    expect(cc.originBody).toBe(moon);
    close(camera.position, 0, 0, 1777);
    close(cc.controls.target, 0, 0, 1737);
    expect(facing(camera, targetOffset)).toBeCloseTo(1);
  });
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
    // Stopped mid pull-back, it was looking at the midpoint. Tracking the
    // destination from here turns it to face the destination, as Track does.
    expect(facing(camera, moon.position)).toBeCloseTo(1, 6);
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
    const { camera, cc, moon, frame, fire } = setup();
    cc.flyTo(moon, { scaleFactor: 1, duration: 2, path: 'overview' });
    frame(0.3);
    fire('wheel', { shiftKey: false, deltaY: 100, deltaX: 0, deltaMode: 0, preventDefault() {}, stopPropagation() {} });
    frame(0.05);
    expect(cc.flight).toBeNull();
    frame(0.05);
    expect(cc.trackedBody).toBe(moon);
    expect(facing(camera, moon.position)).toBeCloseTo(1, 6);
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
    const { camera, cc, moon, frame, absolute } = setup();
    const travel = (px: number) =>
      (cc as unknown as { _notePressTravel(dx: number, dy: number): void })._notePressTravel(px, 0);
    cc.flyTo(moon, { scaleFactor: 1, duration: 2 });
    travel(1);
    frame(0.1);
    expect(cc.flight).not.toBeNull();
    travel(5);
    frame(0.1);
    expect(cc.flight).toBeNull();
    const there = absolute(camera.position);
    frame(0.1);
    expect(cc.trackedBody).toBe(moon);
    // The drag here carries no rotation, so the camera holds its place.
    const after = absolute(camera.position);
    close(after, there.x, there.y, there.z, 0);
    expect(facing(camera, moon.position)).toBeCloseTo(1, 6);
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

describe('camera frames', () => {
  it('focus keeps a frame that places the camera when it is on that body already, state and all', () => {
    const { cc, moon } = setup();
    cc.setMode(CameraModeName.CHASE, { bodyName: 'Moon', centerBodyName: 'Earth', offset: 250 });
    const chase = cc.getModeInstance(CameraModeName.CHASE)!;
    const activate = vi.spyOn(chase, 'activate');
    cc.focus(moon);
    expect(cc.mode).toBe(CameraModeName.CHASE);
    expect(activate).not.toHaveBeenCalled();
    expect((chase as unknown as { distanceKm: number }).distanceKm).toBe(250);
  });

  it('focus keeps a surface explorer on that body where it stands, looking where it looks', () => {
    const { camera, cc, moon } = setup();
    cc.setMode(CameraModeName.SURFACE_EXPLORER, { bodyName: 'Moon' });
    const explorer = cc.getModeInstance(CameraModeName.SURFACE_EXPLORER)! as unknown as { heading: number; pitch: number };
    explorer.heading = 1.2;
    explorer.pitch = -0.1;
    camera.position.set(1740, 0, 0);
    camera.lookAt(1740, 1000, 0);
    const position = camera.position.clone();
    const orientation = camera.quaternion.clone();
    const target = cc.controls.target.clone();
    const activate = vi.spyOn(cc.getModeInstance(CameraModeName.SURFACE_EXPLORER)!, 'activate');
    cc.focus(moon);
    expect(cc.mode).toBe(CameraModeName.SURFACE_EXPLORER);
    expect(cc.trackedBody).toBe(moon);
    expect(activate).not.toHaveBeenCalled();
    expect(explorer.heading).toBe(1.2);
    expect(explorer.pitch).toBe(-0.1);
    expect(camera.position.equals(position)).toBe(true);
    expect(camera.quaternion.equals(orientation)).toBe(true);
    expect(cc.controls.target.equals(target)).toBe(true);
  });

  it('focus on a spacecraft is not focus on the planet a surface frame is on', () => {
    const { camera, cc, moonAbs, bodies } = setup();
    const craftAbs = moonAbs.clone().add(new THREE.Vector3(2000, 0, 0));
    const craft = fakeBody('LRO', 0.002, craftAbs.clone(), { classification: 'spacecraft', parentName: 'Moon' });
    bodies.set('LRO', craft);
    cc.setMode(CameraModeName.SURFACE, { bodyName: 'Moon', latDeg: 10, lonDeg: 20, altKm: 5 });
    // Where the camera is relative to the spacecraft, which becomes the origin.
    const before = camera.position.clone().sub(craft.position);
    cc.focus(craft);
    expect(cc.mode).toBe(CameraModeName.FREE_ORBIT);
    expect(cc.trackedBody).toBe(craft);
    expect(cc.originBody).toBe(craft);
    close(camera.position, before.x, before.y, before.z);
    expect(facing(camera, new THREE.Vector3())).toBeCloseTo(1, 6);
  });

  it('focus keeps an instrument view and its sensor', () => {
    const { cc, moon } = setup();
    cc.setMode(CameraModeName.INSTRUMENT, { sensorName: 'NAC' });
    cc.focus(moon);
    expect(cc.mode).toBe(CameraModeName.INSTRUMENT);
    expect(cc.getModeInstance<InstrumentMode>(CameraModeName.INSTRUMENT)!.sensorName).toBe('NAC');
  });

  it('focus on another body leaves such a frame for free orbit, the camera where it is', () => {
    const { camera, cc, moon, absolute } = setup();
    cc.setMode(CameraModeName.SURFACE, { bodyName: 'Earth', latDeg: 10, lonDeg: 20, altKm: 5 });
    const before = absolute(camera.position);
    cc.focus(moon);
    expect(cc.mode).toBe(CameraModeName.FREE_ORBIT);
    expect(cc.trackedBody).toBe(moon);
    const after = absolute(camera.position);
    close(after, before.x, before.y, before.z);
  });

  it('focus moves a body-fixed frame only when its body changes', () => {
    const { cc, earth, moon } = setup();
    cc.setMode(CameraModeName.BODY_FIXED, { bodyName: 'Earth' });
    const setModeForBody = vi.spyOn(cc, 'setModeForBody');
    cc.focus(earth);
    expect(setModeForBody).not.toHaveBeenCalled();
    cc.focus(moon);
    expect(setModeForBody).toHaveBeenCalledWith(CameraModeName.BODY_FIXED, moon);
  });

  it('focus on a spacecraft keeps the camera in place while a body-fixed frame moves to its planet', () => {
    const { camera, cc, moonAbs, bodies, absolute } = setup();
    const craftAbs = moonAbs.clone().add(new THREE.Vector3(2000, 0, 0));
    const craft = fakeBody('LRO', 0.002, craftAbs.clone(), { classification: 'spacecraft', parentName: 'Moon' });
    bodies.set('LRO', craft);
    cc.setMode(CameraModeName.BODY_FIXED, { bodyName: 'Earth' });
    const before = absolute(camera.position);
    cc.focus(craft);
    expect(cc.mode).toBe(CameraModeName.BODY_FIXED);
    expect(cc.originBody?.body.name).toBe('Moon');
    const after = absolute(camera.position);
    close(after, before.x, before.y, before.z);
    // Still aimed at the spacecraft, now in the Moon's coordinates.
    close(cc.controls.target, 2000, 0, 0);
  });

  it('frame leaves a frame that places the camera for free orbit', () => {
    const { camera, cc, moon } = setup();
    cc.setMode(CameraModeName.LVLH, { bodyName: 'Moon', centerBodyName: 'Earth' });
    cc.frame(moon, { scaleFactor: 1 });
    expect(cc.mode).toBe(CameraModeName.FREE_ORBIT);
    expect(camera.position.distanceTo(moon.position)).toBeCloseTo(1737 * 3, 3);
  });

  it('a flight from a chase frame lands and stays landed', () => {
    const { camera, cc, moon, bodies, frame } = setup();
    cc.setModeContext(fakeSpice, 0, 1, bodies);
    cc.setMode(CameraModeName.CHASE, { bodyName: 'Earth', centerBodyName: 'Sun', offset: 100 });
    frame(0.1);
    cc.flyTo(moon, { scaleFactor: 1, duration: 1 });
    expect(cc.mode).toBe(CameraModeName.FREE_ORBIT);
    for (let i = 0; i < 6; i++) frame(0.3);
    expect(cc.flight).toBeNull();
    expect(cc.trackedBody).toBe(moon);
    expect(camera.position.length()).toBeCloseTo(1737 * 3, 1);
  });

  it('a flight in a body-fixed frame brings the frame to the destination, landed or stopped', () => {
    for (const stop of [false, true]) {
      const { cc, moon, frame } = setup();
      cc.setMode(CameraModeName.BODY_FIXED, { bodyName: 'Earth' });
      const setModeForBody = vi.spyOn(cc, 'setModeForBody');
      cc.flyTo(moon, { scaleFactor: 1, duration: 1 });
      frame(0.3);
      if (stop) cc.stopFlight();
      for (let i = 0; i < 6; i++) frame(0.3);
      expect(cc.mode).toBe(CameraModeName.BODY_FIXED);
      expect(setModeForBody).toHaveBeenCalledWith(CameraModeName.BODY_FIXED, moon);
      expect(cc.originBody).toBe(moon);
    }
  });
});
