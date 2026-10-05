/**
 * `orbitTarget` — Cosmographia's `circleCenter*` moves.
 *
 * The geometry is checked on a real `CameraController` rather than a fake,
 * because the sign conventions are the part most likely to be wrong: "right"
 * has to move the camera toward the right edge of what it currently shows, and
 * "up" toward the top, whichever way the camera happens to face.
 */
import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
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

/** A camera 10 000 km out on +Z looking at the origin, +Y up: right is +X. */
function setup() {
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 1, 1e9);
  const cc = new CameraController(camera, fakeElement());
  const earth = fakeBody('Earth', 6378, new THREE.Vector3(0, 0, 0));
  cc.setModeContext(null, 0, 1, new Map([['Earth', earth]]));
  camera.position.set(0, 0, 10000);
  camera.up.set(0, 1, 0);
  cc.controls.target.set(0, 0, 0);
  camera.lookAt(cc.controls.target);
  return { camera, cc, earth };
}

const close = (v: THREE.Vector3, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x, 3);
  expect(v.y).toBeCloseTo(y, 3);
  expect(v.z).toBeCloseTo(z, 3);
};

describe('orbitTarget, instant', () => {
  it('swings right about the view up, keeping distance, aim and up', () => {
    const { camera, cc } = setup();
    expect(cc.orbitTarget('up', Math.PI / 2)).toBe(true);
    close(camera.position, 10000, 0, 0);
    close(camera.up, 0, 1, 0);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    close(forward, -1, 0, 0);
  });

  it('swings up about the view right, carrying the up vector so nothing rolls', () => {
    const { camera, cc } = setup();
    expect(cc.orbitTarget('right', Math.PI / 2)).toBe(true);
    // Now above the target, looking down, with up pointing the way the camera
    // was looking before: the top of the screen is still "away".
    close(camera.position, 0, 10000, 0);
    close(camera.up, 0, 0, -1);
  });

  it('comes back to the start after a full circle', () => {
    const { camera, cc } = setup();
    cc.orbitTarget('up', 2 * Math.PI);
    close(camera.position, 0, 0, 10000);
    cc.orbitTarget('right', -2 * Math.PI);
    close(camera.position, 0, 0, 10000);
    close(camera.up, 0, 1, 0);
  });

  it('pivots on the orbit target, not the world origin', () => {
    const { camera, cc } = setup();
    cc.controls.target.set(100, 0, 0);
    camera.position.set(100, 0, 500);
    cc.orbitTarget('up', Math.PI);
    close(camera.position, 100, 0, -500);
  });

  it('refuses in a mode that owns the view, and leaves the camera alone', () => {
    const { camera, cc, earth } = setup();
    cc.trackBody(earth, 1);
    expect(cc.setMode(CameraModeName.CHASE, { bodyName: 'Earth' })).toBe(true);
    const before = camera.position.clone();
    expect(cc.orbitTarget('up', 1)).toBe(false);
    expect(camera.position.equals(before)).toBe(true);
  });
});

describe('orbitTarget, over a duration', () => {
  /** Drive `update()` on a clock the test owns. */
  function clock() {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return (seconds: number) => {
      now += seconds * 1000;
    };
  }

  it('turns at a constant rate and lands exactly on the angle asked for', () => {
    const tick = clock();
    const { camera, cc } = setup();
    cc.orbitTarget('up', Math.PI, 2);
    expect(cc.moving).toBe(true);
    // Nothing moves until a frame runs.
    close(camera.position, 0, 0, 10000);

    tick(0.05);
    cc.update();
    const angle = Math.atan2(camera.position.x, camera.position.z);
    expect(angle).toBeCloseTo((Math.PI / 2) * 0.05, 4);

    // One long frame — slower than the controller's 0.1 s frame cap — still
    // advances by the time that really passed, so a slow frame rate does not
    // stretch the swing past the `wait` a script gave it.
    tick(0.5);
    cc.update();
    expect(Math.atan2(camera.position.x, camera.position.z)).toBeCloseTo((Math.PI / 2) * 0.55, 4);

    // Plenty of frames past the end: the last step is clipped, not overshot.
    for (let i = 0; i < 60; i++) {
      tick(0.05);
      cc.update();
    }
    expect(cc.moving).toBe(false);
    expect(camera.position.x).toBeCloseTo(0, 2);
    expect(camera.position.z).toBeCloseTo(-10000, 2);
  });

  it('stops on cancelAnimation, where a scripted setCamera calls it', () => {
    const tick = clock();
    const { camera, cc } = setup();
    cc.orbitTarget('up', Math.PI, 2);
    cc.cancelAnimation();
    tick(0.05);
    cc.update();
    expect(cc.moving).toBe(false);
    close(camera.position, 0, 0, 10000);
  });
});

describe('dolly', () => {
  it('moves straight away from the target, keeping the aim', () => {
    const { camera, cc } = setup();
    expect(cc.dolly(5000)).toBe(true);
    close(camera.position, 0, 0, 15000);
    expect(cc.dolly(-12000)).toBe(true);
    close(camera.position, 0, 0, 3000);
    close(camera.getWorldDirection(new THREE.Vector3()), 0, 0, -1);
  });

  it('stops short of the target instead of passing through it', () => {
    const { camera, cc } = setup();
    cc.dolly(-50000);
    expect(camera.position.z).toBeGreaterThan(0);
    expect(camera.position.z).toBeLessThan(1);
    close(camera.getWorldDirection(new THREE.Vector3()), 0, 0, -1);
  });

  it('plays over a duration and lands on the exact distance', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { camera, cc } = setup();
    cc.dolly(10000, 2);
    now += 1000;
    cc.update();
    expect(camera.position.z).toBeCloseTo(15000, 0);
    now += 5000;
    cc.update();
    expect(cc.moving).toBe(false);
    expect(camera.position.z).toBeCloseTo(20000, 0);
  });
});

describe('crane', () => {
  it('raises the camera and the target together along the view up', () => {
    const { camera, cc } = setup();
    expect(cc.crane(2000)).toBe(true);
    close(camera.position, 0, 2000, 10000);
    close(cc.controls.target, 0, 2000, 0);
  });

  // Free orbit pins the orbit target to a tracked object every frame, which
  // would turn the crane into a tilt — so, as the Z / C keys do, it lets go.
  it('releases a tracked object in free orbit, so the next frame does not undo it', () => {
    const { camera, cc, earth } = setup();
    cc.track(earth);
    camera.position.set(0, 0, 10000);
    cc.controls.target.set(0, 0, 0);
    cc.crane(2000);
    expect(cc.trackedBody).toBeNull();
    cc.update();
    expect(cc.controls.target.y).toBeCloseTo(2000, 3);
  });

  it('refuses in a mode that owns the view', () => {
    const { cc, earth } = setup();
    cc.trackBody(earth, 1);
    cc.setMode(CameraModeName.CHASE, { bodyName: 'Earth' });
    expect(cc.crane(10)).toBe(false);
    expect(cc.dolly(10)).toBe(false);
  });
});

// A crane queued behind a fly-to used to release tracking when it was asked
// for. The fly-to's landing then tracked the body again through the deferred
// origin switch, and free orbit re-pinned the target to the body every frame:
// the crane became a tilt. The frames below run in the renderer's order —
// origin switch, body positions under the new origin, then `update()`.
describe('crane queued behind a fly-to', () => {
  it('releases tracking when it starts, after the origin switch, and keeps its translation', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { camera, cc, earth } = setup();
    // Start somewhere else entirely, so the origin switch moves things.
    earth.position.set(0, 0, -50000);
    const frame = (seconds: number) => {
      now += seconds * 1000;
      cc.applyPendingOriginSwitch();
      // Body positions, as the renderer recomputes them under the origin.
      if (cc.originBody === earth) earth.position.set(0, 0, 0);
      cc.update();
    };

    cc.flyTo(earth, { duration: 1, scaleFactor: 1 });
    expect(cc.crane(2000, 2)).toBe(true);
    for (let i = 0; i < 5; i++) frame(0.3); // the flight, then its landing a frame later
    expect(cc.originBody).toBe(earth);

    for (let i = 0; i < 20; i++) frame(0.2); // the crane, and well past it
    expect(cc.moving).toBe(false);
    expect(cc.trackedBody).toBeNull();
    // The target rose 2000 above the body, and stayed: tracking did not pull it
    // back. The camera kept its distance from the target, so the same view.
    close(cc.controls.target, 0, 2000, 0);
    expect(camera.position.distanceTo(cc.controls.target)).toBeCloseTo(6378 * 3, 0);
  });

  it('holds an instant move until the fly-to has landed, instead of losing it to the flight', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { cc, earth } = setup();
    earth.position.set(0, 0, -50000);
    cc.flyTo(earth, { duration: 1, scaleFactor: 1 });
    cc.crane(2000);
    expect(cc.moving).toBe(true);
    for (let i = 0; i < 6; i++) {
      now += 300;
      cc.applyPendingOriginSwitch();
      if (cc.originBody === earth) earth.position.set(0, 0, 0);
      cc.update();
    }
    expect(cc.moving).toBe(false);
    close(cc.controls.target, 0, 2000, 0);
  });
});

// The fly-to's deferred origin switch moves the camera into the new origin's
// coordinates. It used to leave the orbit target at the body's position in the
// OLD coordinates, which free-orbit tracking only repaired later in the frame —
// after a queued move had already pivoted around it, or dollied along it.
describe('moves queued behind a fly-to from another origin', () => {
  /**
   * Earth off to one side, the camera flying to it, frames in the renderer's
   * order. Off-axis on purpose: with the body dead ahead, a stale target sits
   * on the same line of sight and a dolly along it would pass by accident.
   */
  function flyToEarth() {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const s = setup();
    s.earth.position.set(30000, 0, -40000);
    const frame = (seconds: number) => {
      now += seconds * 1000;
      s.cc.applyPendingOriginSwitch();
      if (s.cc.originBody === s.earth) s.earth.position.set(0, 0, 0);
      s.cc.update();
    };
    s.cc.flyTo(s.earth, { duration: 1, scaleFactor: 1 });
    // flyTo approaches along the line from the body to where the camera was,
    // and stops at three radii.
    const approach = new THREE.Vector3(0, 0, 10000).sub(new THREE.Vector3(30000, 0, -40000)).normalize();
    return { ...s, frame, approach };
  }
  const VIEW = 6378 * 3;

  it('swing about the body itself: an instant quarter circle right', () => {
    const { camera, cc, frame, approach } = flyToEarth();
    cc.orbitTarget('up', Math.PI / 2);
    for (let i = 0; i < 8; i++) frame(0.3);
    expect(cc.moving).toBe(false);
    close(cc.controls.target, 0, 0, 0);
    // A quarter turn right about +Y takes (x, z) to (z, -x).
    close(camera.position, VIEW * approach.z, 0, -VIEW * approach.x);
  });

  it('and a timed one, landing at the right place and distance', () => {
    const { camera, cc, frame, approach } = flyToEarth();
    cc.orbitTarget('up', Math.PI / 2, 1);
    for (let i = 0; i < 12; i++) frame(0.3);
    expect(cc.moving).toBe(false);
    close(camera.position, VIEW * approach.z, 0, -VIEW * approach.x);
  });

  it('dolly along the line to the body, not to where it used to be', () => {
    const { camera, cc, frame, approach } = flyToEarth();
    cc.dolly(10000);
    for (let i = 0; i < 8; i++) frame(0.3);
    const d = VIEW + 10000;
    close(camera.position, d * approach.x, 0, d * approach.z);
  });
});
