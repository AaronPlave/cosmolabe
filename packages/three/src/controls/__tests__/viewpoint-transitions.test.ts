/**
 * Going from one viewpoint to another on a real `CameraController` (#114):
 * a viewpoint establishes the whole view — free orbit, coordinate origin,
 * tracked and look-at bodies — whatever navigation came before, and refuses
 * without touching anything when a body it needs is missing.
 *
 * Frames run in the renderer's order — origin switch, body positions under
 * the current origin, then `update()` — because stale tracking or a stale
 * origin only shows on the frames after the cut.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CameraController, type CameraViewpoint } from '../CameraController.js';
import { CameraModeName } from '../CameraModes.js';
import { applyNamedViewpoint, type ViewpointHost } from '../applyNamedViewpoint.js';
import type { BodyMesh } from '../../BodyMesh.js';

beforeAll(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Just enough of an element for TrackballControls. */
function fakeElement(width = 800, height = 600): HTMLElement {
  const noop = { addEventListener() {}, removeEventListener() {} };
  return {
    ...noop,
    style: {},
    ownerDocument: { ...noop, defaultView: noop, documentElement: { clientLeft: 0, clientTop: 0 } },
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLElement;
}

function fakeBody(name: string, radius: number): BodyMesh {
  return {
    position: new THREE.Vector3(),
    displayRadius: radius,
    scaleFactor: 1,
    hasTerrain: false,
    body: { name, rotation: undefined, rotationAt: () => undefined },
  } as unknown as BodyMesh;
}

/** A SPICE state for every body: 1000 km out on +X, moving along +Y. */
const fakeSpice = {
  pxform: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  spkezr: () => ({ state: [1000, 0, 0, 0, 1, 0] as [number, number, number, number, number, number], lightTime: 0 }),
};

const vec = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const close = (v: THREE.Vector3, w: THREE.Vector3, digits = 3) => {
  expect(v.x).toBeCloseTo(w.x, digits);
  expect(v.y).toBeCloseTo(w.y, digits);
  expect(v.z).toBeCloseTo(w.z, digits);
};

/**
 * Earth and the Moon, neither at the universe origin, so "relative to the
 * universe" and "relative to Earth" are different coordinates. Body positions
 * are kept relative to whichever body is the origin, as the renderer keeps them.
 */
function setup() {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 1, 1e12);
  const cc = new CameraController(camera, fakeElement());
  const abs = new Map([
    ['Earth', vec(150_000_000, 0, 0)],
    ['Moon', vec(150_300_000, 0, -200_000)],
  ]);
  const earth = fakeBody('Earth', 6378);
  const moon = fakeBody('Moon', 1737);
  const bodies = new Map([['Earth', earth], ['Moon', moon]]);
  const place = () => {
    const origin = cc.originBody ? abs.get(cc.originBody.body.name)! : vec(0, 0, 0);
    for (const [name, bm] of bodies) bm.position.copy(abs.get(name)!).sub(origin);
  };
  cc.setModeContext(fakeSpice, 0, 1, bodies);
  place();
  let et = 5000;
  const host: ViewpointHost = {
    cameraController: cc,
    timeController: { get et() { return et; }, setTime: (t) => { et = t; } },
    camera,
    getBodyMesh: (n) => bodies.get(n),
  };
  const frames = (n = 3) => {
    for (let i = 0; i < n; i++) {
      now += 100;
      cc.applyPendingOriginSwitch();
      place();
      cc.update();
    }
  };
  /** A camera position in universe coordinates. */
  const absolute = (v: THREE.Vector3) =>
    v.clone().add(cc.originBody ? abs.get(cc.originBody.body.name)! : vec(0, 0, 0));
  return { camera, cc, earth, moon, abs, host, frames, absolute, et: () => et };
}

/** Behind the Moon, looking at Earth — the shape of "Saturn beyond Cassini". */
const moonLookingAtEarth: CameraViewpoint = {
  name: 'Earth beyond the Moon',
  position: vec(-6000, 0, 4000),
  target: vec(-300_000, 0, 200_000),
  up: vec(0, 0, 1),
  trackBody: 'Moon',
  lookAtBody: 'Earth',
  originBody: 'Moon',
};

/** A world-relative view, as the session "Default" is: no center at all. */
const worldView: CameraViewpoint = {
  name: 'Default',
  position: vec(150_000_000, 50_000, 500_000),
  target: vec(150_000_000, 0, 0),
  up: vec(0, 1, 0),
  originBody: null,
};

describe('viewpoint → viewpoint', () => {
  it('a tracked look-at view, then a world-relative one, leaves nothing of the first behind', () => {
    const { cc, camera, host, frames, absolute } = setup();
    for (const vp of [moonLookingAtEarth, worldView]) cc.addViewpoint(vp);
    expect(applyNamedViewpoint(host, 'Earth beyond the Moon')).toBe(true);
    frames();
    expect(cc.trackedBody?.body.name).toBe('Moon');
    expect(cc.lookAtBody?.body.name).toBe('Earth');

    expect(applyNamedViewpoint(host, 'Default')).toBe(true);
    frames();
    // Untracked, unaimed, and in universe coordinates: the eye is where the
    // view says in space, and tracking has not pulled the target to the Moon.
    expect(cc.trackedBody).toBeNull();
    expect(cc.lookAtBody).toBeNull();
    expect(cc.originBody).toBeNull();
    close(absolute(camera.position), worldView.position);
    close(cc.controls.target, worldView.target);
  });

  it('a world-relative view, then a tracked one, rebases onto the center', () => {
    const { cc, camera, host, frames, earth, moon } = setup();
    for (const vp of [moonLookingAtEarth, worldView]) cc.addViewpoint(vp);
    applyNamedViewpoint(host, 'Default');
    frames();
    applyNamedViewpoint(host, 'Earth beyond the Moon');
    frames();
    expect(cc.originBody?.body.name).toBe('Moon');
    expect(cc.trackedBody?.body.name).toBe('Moon');
    close(camera.position, moonLookingAtEarth.position);
    // Facing Earth, with the Moon in the foreground.
    const view = camera.getWorldDirection(new THREE.Vector3());
    expect(view.dot(earth.position.clone().sub(camera.position).normalize())).toBeCloseTo(1, 6);
    expect(moon.position.length()).toBeCloseTo(0, 6);
  });

  it('keeps facing the look-at body as it moves', () => {
    const { cc, camera, host, frames, earth, abs } = setup();
    cc.addViewpoint(moonLookingAtEarth);
    applyNamedViewpoint(host, 'Earth beyond the Moon');
    frames();
    abs.get('Earth')!.add(vec(0, 40_000, 0));
    frames();
    const view = camera.getWorldDirection(new THREE.Vector3());
    expect(view.dot(earth.position.clone().sub(camera.position).normalize())).toBeCloseTo(1, 6);
  });

  it('returns to free orbit from a frame that places the camera, and the pose holds', () => {
    for (const mode of [CameraModeName.CHASE, CameraModeName.LVLH, CameraModeName.BODY_FIXED]) {
      const { cc, camera, host, frames } = setup();
      cc.addViewpoint(moonLookingAtEarth);
      cc.setMode(mode, { bodyName: 'Moon', centerBodyName: 'Earth', offset: 250 });
      frames();
      expect(applyNamedViewpoint(host, 'Earth beyond the Moon')).toBe(true);
      expect(cc.mode, mode).toBe(CameraModeName.FREE_ORBIT);
      frames();
      close(camera.position, moonLookingAtEarth.position);
    }
  });

  it('ends a flight in progress rather than letting it land over the view', () => {
    const { cc, camera, host, frames, earth } = setup();
    cc.addViewpoint(moonLookingAtEarth);
    cc.flyTo(earth, { scaleFactor: 1, duration: 5 });
    frames(1);
    applyNamedViewpoint(host, 'Earth beyond the Moon');
    frames(20);
    expect(cc.flight).toBeNull();
    expect(cc.trackedBody?.body.name).toBe('Moon');
    close(camera.position, moonLookingAtEarth.position);
  });

  it('restores a view saved after un-tracking in the origin it was taken in', () => {
    const { cc, camera, host, frames, moon, absolute } = setup();
    cc.addViewpoint(worldView);
    cc.focus(moon);
    frames();
    cc.stopTracking();
    camera.position.set(3000, 0, 0);
    const saved = cc.saveViewpoint('Saved');
    expect(saved.originBody).toBe('Moon');
    const there = absolute(camera.position);
    applyNamedViewpoint(host, 'Default');
    frames();
    applyNamedViewpoint(host, 'Saved');
    frames();
    expect(cc.originBody?.body.name).toBe('Moon');
    expect(cc.trackedBody).toBeNull();
    close(absolute(camera.position), there);
  });
});

describe('refusing a viewpoint whose bodies are not in the scene', () => {
  for (const [what, vp] of [
    ['center', { ...moonLookingAtEarth, name: 'X', trackBody: 'Phobos', originBody: 'Phobos' }],
    ['look-at body', { ...moonLookingAtEarth, name: 'X', lookAtBody: 'Phobos' }],
  ] as const) {
    it(`changes nothing when the ${what} has no mesh`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { cc, camera, host, frames, earth, et } = setup();
      cc.addViewpoint({ ...vp, epoch: 99, fov: 20 });
      cc.focus(earth);
      cc.lookAt(earth);
      frames();
      const before = { pos: camera.position.clone(), fov: camera.fov, et: et() };
      expect(applyNamedViewpoint(host, 'X')).toBe(false);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('"Phobos" has no mesh'))).toBe(true);
      expect(et()).toBe(before.et);
      expect(camera.fov).toBe(before.fov);
      expect(cc.trackedBody).toBe(earth);
      expect(cc.lookAtBody).toBe(earth);
      close(camera.position, before.pos);
    });
  }
});
