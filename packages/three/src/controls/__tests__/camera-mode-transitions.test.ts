/**
 * Camera mode transitions (#253) on a real `CameraController`:
 *
 * - Slice A: entering Surface Flight / Surface Explorer without a named
 *   destination puts the observer at the region being looked at, at a
 *   practical height, heading where the view was heading — never 0°, 0° or
 *   an orbital altitude — while a named 0°, 0° is honoured; leaving again
 *   keeps the view.
 * - Slice B: right-drag free look turns the view in place in body-fixed and
 *   SC-fixed frames, keeping the frame lock as time runs.
 *
 * Frames run in the renderer's order — origin switch, body positions under the
 * current origin, then `update()`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { Quaternion } from '@cosmolabe/core';
import { CameraController } from '../CameraController.js';
import { CameraModeName, bodyWorldOrientation } from '../CameraModes.js';
import { flightEntryCapKm, surfaceEntryPose, EXPLORER_ENTRY_CLEARANCE_KM } from '../surfaceEntry.js';
import { bodyFixedToGeodeticRad, geodeticToBodyFixedKm } from '../surfaceNavigation.js';
import type { BodyMesh } from '../../BodyMesh.js';

const MOON_R = 1737.4;
const DEG = Math.PI / 180;

function fakeElement(width = 800, height = 600): HTMLElement {
  const noop = { addEventListener() {}, removeEventListener() {} };
  return {
    addEventListener() {},
    removeEventListener() {},
    style: {},
    ownerDocument: { ...noop, defaultView: noop, documentElement: { clientLeft: 0, clientTop: 0 } },
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLElement;
}

/** Spin about the ecliptic pole at `degPerSec`; none when zero. */
function spin(degPerSec: number) {
  if (!degPerSec) return { rotation: undefined, rotationAt: () => undefined };
  return {
    rotation: { sourceFrame: 'EclipticJ2000' },
    rotationAt: (et: number): Quaternion => {
      const h = (degPerSec * et * DEG) / 2;
      return [Math.cos(h), 0, 0, Math.sin(h)];
    },
  };
}

function fakeBody(
  name: string, radius: number, position: THREE.Vector3,
  opts: {
    classification?: string; parentName?: string; spinDegPerSec?: number;
    elevationKm?: number; polarRadius?: number;
  } = {},
): BodyMesh {
  const { classification, parentName, spinDegPerSec = 0, elevationKm, polarRadius = radius } = opts;
  const bm = {
    position,
    displayRadius: radius,
    scaleFactor: 1,
    hasTerrain: elevationKm !== undefined,
    sampleTerrainElevation: () => (elevationKm !== undefined ? { elevationKm } : null),
    body: {
      name, classification, parentName,
      radii: classification === 'spacecraft' ? undefined : [radius, radius, polarRadius],
      ...spin(spinDegPerSec),
    },
    // As BodyMesh renders a globe: body→world, then the Y-pole geometry's
    // pre-rotation onto the body's Z pole.
    mesh: { quaternion: new THREE.Quaternion() },
    bodyToWorldQuaternion: (out: THREE.Quaternion) => out.copy(GLOBE_PRE_ROTATION).invert().premultiply(bm.mesh.quaternion),
    /** Orient the mesh for `et`, as `BodyMesh.updatePosition` does. */
    orient(et: number) {
      const q = bodyWorldOrientation(bm as unknown as BodyMesh, et, new THREE.Quaternion());
      bm.mesh.quaternion.copy(q ?? new THREE.Quaternion()).multiply(GLOBE_PRE_ROTATION);
    },
  };
  bm.orient(0);
  return bm as unknown as BodyMesh;
}

const GLOBE_PRE_ROTATION = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const orient = (bm: BodyMesh, et: number) => (bm as unknown as { orient(et: number): void }).orient(et);

beforeAll(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** World direction of a body-fixed (Z-up) vector on `bm`, as last oriented. */
function worldDir(bm: BodyMesh, v: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(...v).applyQuaternion(bm.bodyToWorldQuaternion(new THREE.Quaternion()));
}

/** World → body-fixed (Z-up) direction on `bm`, as last oriented. */
function toBodyFixed(bm: BodyMesh, v: THREE.Vector3): THREE.Vector3 {
  return v.clone().applyQuaternion(bm.bodyToWorldQuaternion(new THREE.Quaternion()).invert());
}

/** Body-fixed (Z-up) lat/lon/radius of a world point on `bm`, as last oriented. */
function bodyFixedOf(bm: BodyMesh, world: THREE.Vector3) {
  const v = toBodyFixed(bm, world.clone().sub(bm.position));
  const r = v.length();
  return { latDeg: Math.asin(v.z / r) / DEG, lonDeg: Math.atan2(v.y, v.x) / DEG, r };
}

/**
 * The Moon at the origin, focused; optionally a spacecraft beside it. The
 * camera hangs `altKm` above body-fixed (lat, lon), looking at the Moon's
 * centre with north at the top of the screen.
 */
function setup(opts: { spinDegPerSec?: number; elevationKm?: number; withCraft?: boolean } = {}) {
  let now = 1000;
  let et = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 1e-6, 1e12);
  const cc = new CameraController(camera, fakeElement());
  const moonAbs = new THREE.Vector3(0, 0, 0);
  const moon = fakeBody('Moon', MOON_R, moonAbs.clone(), { spinDegPerSec: opts.spinDegPerSec, elevationKm: opts.elevationKm });
  const bodies = new Map([['Moon', moon]]);
  const craftAbs = new THREE.Vector3(MOON_R + 100, 0, 0);
  const craft = fakeBody('LRO', 0.002, craftAbs.clone(), { classification: 'spacecraft', parentName: 'Moon' });
  if (opts.withCraft) bodies.set('LRO', craft);
  cc.setModeContext(null, et, 1, bodies);
  cc.focus(moon);

  const place = () => {
    const origin = cc.originBody === craft ? craftAbs : moonAbs;
    moon.position.copy(moonAbs).sub(origin);
    craft.position.copy(craftAbs).sub(origin);
    orient(moon, et);
  };
  const frame = (seconds = 0.1, advanceEt = 0) => {
    now += seconds * 1000;
    et += advanceEt;
    cc.applyPendingOriginSwitch();
    place();
    cc.setModeContext(null, et, 1, bodies);
    cc.update();
  };
  /** Hang the camera over (lat, lon), looking at the centre, `screenUp` (body-fixed) at the top. */
  const hover = (latDeg: number, lonDeg: number, altKm: number, screenUp: [number, number, number] = [0, 0, 1]) => {
    const p = geodeticToBodyFixedKm(latDeg * DEG, lonDeg * DEG, altKm, { a: MOON_R, e2: 0 });
    camera.position.copy(moon.position).add(worldDir(moon, p));
    camera.up.copy(worldDir(moon, screenUp));
    cc.controls.target.copy(moon.position);
    camera.lookAt(moon.position);
  };
  const rightDrag = (dx: number, dy: number) => {
    const drag = cc as unknown as { _rightDragDx: number; _rightDragDy: number };
    drag._rightDragDx += dx;
    drag._rightDragDy += dy;
  };
  return { camera, cc, moon, craft, bodies, frame, hover, rightDrag, et: () => et };
}

const forward = (camera: THREE.PerspectiveCamera) => camera.getWorldDirection(new THREE.Vector3());

describe('surface entry (slice A)', () => {
  for (const mode of [CameraModeName.SURFACE, CameraModeName.SURFACE_EXPLORER]) {
    it(`${mode}: enters over the region in view, at a practical height, not 0°, 0° or orbital altitude`, () => {
      const { camera, cc, moon, frame, hover } = setup();
      hover(30, 60, 10000);
      expect(cc.setModeForBody(mode, moon)).toBe(true);
      for (let i = 0; i < 3; i++) frame();
      expect(cc.mode).toBe(mode);
      const at = bodyFixedOf(moon, camera.position);
      expect(at.latDeg).toBeCloseTo(30, 3);
      expect(at.lonDeg).toBeCloseTo(60, 3);
      const expected = mode === CameraModeName.SURFACE ? flightEntryCapKm(MOON_R) : EXPLORER_ENTRY_CLEARANCE_KM;
      expect(at.r - MOON_R).toBeCloseTo(expected, 3);
      // Looking toward the horizon, not up and not straight into the ground.
      const up = camera.position.clone().sub(moon.position).normalize();
      const pitch = Math.asin(forward(camera).dot(up));
      expect(pitch).toBeLessThanOrEqual(1e-6);
      expect(pitch).toBeGreaterThan(-0.36);
    });
  }

  it('heads where the top of the screen was when looking straight down', () => {
    for (const [screenUp, headingDeg] of [[[0, 0, 1], 0], [[-Math.sin(60 * DEG), Math.cos(60 * DEG), 0], 90]] as const) {
      const { camera, cc, moon, hover } = setup();
      hover(0, 60, 5000, [...screenUp]);
      cc.setModeForBody(CameraModeName.SURFACE_EXPLORER, moon);
      // North and east at (0°, 60°), body-fixed.
      const north = new THREE.Vector3(0, 0, 1);
      const east = new THREE.Vector3(-Math.sin(60 * DEG), Math.cos(60 * DEG), 0);
      const f = forward(camera);
      expect(Math.atan2(f.dot(east), f.dot(north)) / DEG).toBeCloseTo(headingDeg, 3);
    }
  });

  it('enters where the centre of an oblique view rests, not beneath the camera', () => {
    const { camera, cc, moon } = setup();
    const surfacePoint = new THREE.Vector3(...geodeticToBodyFixedKm(20 * DEG, 10 * DEG, 0, { a: MOON_R, e2: 0 }));
    camera.position.set(MOON_R * 2, -MOON_R * 2, MOON_R);
    camera.up.set(0, 0, 1);
    cc.controls.target.copy(surfacePoint);
    camera.lookAt(surfacePoint);
    const pose = surfaceEntryPose(moon, camera, 1, 'explorer')!;
    expect(pose.source).toBe('sightline');
    expect(pose.latDeg).toBeCloseTo(20, 6);
    expect(pose.lonDeg).toBeCloseTo(10, 6);
    // The rendered pick wins over the ellipsoid when it lands on this body.
    const picked = surfaceEntryPose(moon, camera, 1, 'explorer', () => ({
      bodyName: 'Moon', latDeg: 0, lonDeg: 0, altKm: 0, bodyFixedHitKm: [0, MOON_R, 0],
    }))!;
    expect(picked.lonDeg).toBeCloseTo(90, 6);
    cc.setModeForBody(CameraModeName.SURFACE_EXPLORER, moon);
    const at = bodyFixedOf(moon, camera.position);
    expect(at.latDeg).toBeCloseTo(20, 3);
    expect(at.lonDeg).toBeCloseTo(10, 3);
  });

  it('falls back to the point beneath the camera when the view misses the body', () => {
    const { camera, cc, moon, hover } = setup();
    hover(-15, 120, 8000);
    camera.lookAt(camera.position.clone().multiplyScalar(2)); // straight away from the Moon
    expect(surfaceEntryPose(moon, camera, 1, 'flight')!.source).toBe('sub-camera');
    cc.setModeForBody(CameraModeName.SURFACE, moon);
    const at = bodyFixedOf(moon, camera.position);
    expect(at.latDeg).toBeCloseTo(-15, 3);
    expect(at.lonDeg).toBeCloseTo(120, 3);
  });

  it('locates the region in the body frame of a rotating body, and holds it as the body turns', () => {
    const { camera, cc, moon, frame, hover } = setup({ spinDegPerSec: 10 });
    frame(0.1, 3); // the body has turned 30°
    hover(-40, -70, 6000);
    cc.setModeForBody(CameraModeName.SURFACE, moon);
    for (let i = 0; i < 5; i++) frame(0.1, 1);
    const at = bodyFixedOf(moon, camera.position);
    expect(at.latDeg).toBeCloseTo(-40, 2);
    expect(at.lonDeg).toBeCloseTo(-70, 2);
  });

  it('handles a pole without NaN or a flip', () => {
    const { camera, cc, moon, hover } = setup();
    hover(-90, 0, 3000, [1, 0, 0]);
    cc.setModeForBody(CameraModeName.SURFACE_EXPLORER, moon);
    expect(camera.position.toArray().every(Number.isFinite)).toBe(true);
    const at = bodyFixedOf(moon, camera.position);
    expect(at.latDeg).toBeCloseTo(-90, 3);
    expect(at.r).toBeGreaterThan(MOON_R);
    // Heading along body +X, the old top of the screen.
    expect(forward(camera).x).toBeGreaterThan(0.9);
  });

  it('enters above terrain that lies below the reference surface', () => {
    for (const mode of [CameraModeName.SURFACE, CameraModeName.SURFACE_EXPLORER]) {
      const { camera, cc, moon, hover } = setup({ elevationKm: -4 });
      hover(10, 10, 9000);
      cc.setModeForBody(mode, moon);
      const clearance = bodyFixedOf(moon, camera.position).r - (MOON_R - 4);
      const expected = mode === CameraModeName.SURFACE ? flightEntryCapKm(MOON_R) : EXPLORER_ENTRY_CLEARANCE_KM;
      expect(clearance, mode).toBeCloseTo(expected, 3);
    }
  });

  it('keeps a camera already near the surface where it is, heading and pitch included', () => {
    const { camera, cc, moon, hover } = setup();
    hover(5, 5, 2);
    // Look north and slightly down.
    const pos = camera.position.clone();
    const up = pos.clone().normalize();
    const north = new THREE.Vector3(0, 0, 1).addScaledVector(up, -up.z).normalize();
    camera.up.copy(up);
    camera.lookAt(pos.clone().add(north.clone().multiplyScalar(Math.cos(0.1)).addScaledVector(up, -Math.sin(0.1))));
    const pose = surfaceEntryPose(moon, camera, 1, 'flight')!;
    expect(pose.source).toBe('near-surface');
    expect(pose.headingDeg).toBeCloseTo(0, 3);
    expect(pose.pitchDeg).toBeCloseTo(-0.1 / DEG, 3);
    expect(pose.altKm).toBeCloseTo(2, 6);
    cc.setModeForBody(CameraModeName.SURFACE, moon);
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-6);
  });

  it('enters on the parent body when a spacecraft is tracked, in the parent body\'s coordinates', () => {
    const { camera, cc, moon, craft, frame, hover } = setup({ withCraft: true });
    cc.focus(craft);
    frame();
    expect(cc.originBody).toBe(craft);
    hover(0, 30, 4000);
    cc.setModeForBody(CameraModeName.SURFACE_EXPLORER, craft);
    expect(cc.originBody).toBe(moon);
    frame();
    // The Moon is now the origin; the camera stands on it, not a spacecraft-offset away.
    expect(moon.position.length()).toBeLessThan(1e-9);
    const at = bodyFixedOf(moon, camera.position);
    expect(at.lonDeg).toBeCloseTo(30, 3);
    expect(at.r - MOON_R).toBeCloseTo(EXPLORER_ENTRY_CLEARANCE_KM, 3);
  });

  it('honours an explicitly named 0°, 0°', () => {
    for (const mode of [CameraModeName.SURFACE, CameraModeName.SURFACE_EXPLORER]) {
      const { camera, cc, moon, hover } = setup();
      hover(45, 100, 5000);
      cc.setMode(mode, { bodyName: 'Moon', latDeg: 0, lonDeg: 0, altKm: 1 });
      const at = bodyFixedOf(moon, camera.position);
      expect(at.latDeg, mode).toBeCloseTo(0, 6);
      expect(at.lonDeg, mode).toBeCloseTo(0, 6);
      expect(at.r - MOON_R, mode).toBeCloseTo(1, 6);
    }
  });

  it('back to free orbit keeps the view, and surface again resumes where it was', () => {
    // With terrain, as in the lunar and Mars demos: the renderer's terrain
    // clamp is the floor. Without it free orbit keeps the camera above the
    // reference sphere plus 0.01%, which is higher than an explorer's eye.
    const { camera, cc, moon, frame, hover } = setup({ elevationKm: 0 });
    hover(30, 60, 10000);
    cc.setModeForBody(CameraModeName.SURFACE_EXPLORER, moon);
    frame();
    const pos = camera.position.clone();
    const dir = forward(camera);

    cc.setModeForBody(CameraModeName.FREE_ORBIT, cc.modeSubject);
    for (let i = 0; i < 3; i++) frame();
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-6);
    expect(forward(camera).angleTo(dir)).toBeLessThan(1e-6);
    // The view is no longer on the Moon's centre, so free orbit has let go of
    // it; the Moon is still what a mode change applies to.
    expect(cc.trackedBody).toBeNull();
    expect(cc.modeSubject).toBe(moon);

    cc.setModeForBody(CameraModeName.SURFACE_EXPLORER, cc.modeSubject);
    frame();
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-6);
    expect(forward(camera).angleTo(dir)).toBeLessThan(1e-6);
  });

  it('back to a co-rotating frame keeps the view too', () => {
    const { camera, cc, moon, frame, hover } = setup();
    hover(30, 60, 10000);
    cc.setModeForBody(CameraModeName.SURFACE, moon);
    frame();
    const pos = camera.position.clone();
    const dir = forward(camera);
    cc.setModeForBody(CameraModeName.BODY_FIXED, cc.modeSubject);
    for (let i = 0; i < 3; i++) frame();
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-6);
    expect(forward(camera).angleTo(dir)).toBeLessThan(1e-6);
  });

  it('the mode menu and the M cycle resolve the same body after a free look lets go of it', () => {
    const { cc, moon, frame, hover, rightDrag } = setup();
    hover(0, 0, 5000);
    rightDrag(50, 0);
    frame();
    expect(cc.trackedBody).toBeNull();
    expect(cc.modeSubject).toBe(moon);
    expect(cc.setModeForBody(CameraModeName.SURFACE, cc.modeSubject)).toBe(true);
    expect(cc.mode).toBe(CameraModeName.SURFACE);
    // Cycling from Surface Flight lands on Surface Explorer on the same body.
    expect(cc.cycleMode()).toBe(CameraModeName.SURFACE_EXPLORER);
    expect(cc.originBody).toBe(moon);
  });

  it('a mode that needs a body is refused, changing nothing, when there is none', () => {
    const { cc } = setup();
    for (const mode of [CameraModeName.SURFACE, CameraModeName.SURFACE_EXPLORER, CameraModeName.BODY_FIXED, CameraModeName.SC_FIXED]) {
      expect(cc.setModeForBody(mode, null), mode).toBe(false);
      expect(cc.mode).toBe(CameraModeName.FREE_ORBIT);
    }
  });
});

describe('surface flight floor and mode validation (review of #269)', () => {
  /** An Earth-shaped body at the origin, the camera far out over (lat, lon). */
  function oblate(opts: { elevationKm?: number } = {}) {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 1e-6, 1e12);
    const cc = new CameraController(camera, fakeElement());
    const a = 6378.137, c = 6356.752;
    const earth = fakeBody('Earth', a, new THREE.Vector3(), { polarRadius: c, elevationKm: opts.elevationKm });
    const bodies = new Map([['Earth', earth]]);
    cc.setModeContext(null, 0, 1, bodies);
    cc.focus(earth);
    camera.position.set(0, 0, 3 * a);
    camera.lookAt(0, 0, 0);
    const frame = () => {
      now += 100;
      cc.setModeContext(null, 0, 1, bodies);
      cc.update();
    };
    /** Geodetic height of the camera above the ellipsoid, km. */
    const height = () => {
      const p = camera.position.clone().sub(earth.position);
      const { altKm } = bodyFixedToGeodeticRad([p.x, p.y, p.z], { a, e2: 1 - (c * c) / (a * a) });
      return altKm;
    };
    return { camera, cc, earth, bodies, frame, height };
  }

  it('keeps a Surface Flight entry near an oblate body\'s pole at its height over several frames', () => {
    const { cc, frame, height } = oblate();
    cc.setMode(CameraModeName.SURFACE, { bodyName: 'Earth', latDeg: 85, lonDeg: 20, altKm: 0.1 });
    expect(height()).toBeCloseTo(0.1, 6);
    for (let i = 0; i < 5; i++) frame();
    // A radial floor at the equatorial radius would throw it ~21 km up here.
    expect(height()).toBeCloseTo(0.1, 6);
  });

  it('pushes Surface Flight up to terrain plus clearance, not just the ellipsoid', () => {
    const { cc, frame, height } = oblate({ elevationKm: 2 });
    cc.setMode(CameraModeName.SURFACE, { bodyName: 'Earth', latDeg: 40, lonDeg: 0, altKm: 0.5 });
    frame();
    expect(height()).toBeCloseTo(2.01, 6);
  });

  it('refuses a surface mode on a parent body that is not loaded, or has no shape, changing nothing', () => {
    const { cc, bodies } = oblate();
    const lost = fakeBody('Probe', 0.001, new THREE.Vector3(9000, 0, 0), { classification: 'spacecraft', parentName: 'Ghost' });
    const shapeless = fakeBody('Rock', 1, new THREE.Vector3(9000, 0, 0), { classification: 'spacecraft' });
    const onRock = fakeBody('Hopper', 0.001, new THREE.Vector3(9001, 0, 0), { classification: 'spacecraft', parentName: 'Rock' });
    for (const bm of [lost, shapeless, onRock]) bodies.set(bm.body.name, bm);
    cc.setModeForBody(CameraModeName.BODY_FIXED, bodies.get('Earth')!);
    for (const craft of [lost, onRock]) {
      for (const mode of [CameraModeName.SURFACE, CameraModeName.SURFACE_EXPLORER]) {
        expect(cc.setModeForBody(mode, craft), `${mode} on ${craft.body.name}`).toBe(false);
        expect(cc.mode).toBe(CameraModeName.BODY_FIXED);
        expect(cc.originBody?.body.name).toBe('Earth');
      }
    }
  });

  it('cycleMode skips modes it cannot enter and reports the mode it did', () => {
    const camera = new THREE.PerspectiveCamera();
    const cc = new CameraController(camera, fakeElement());
    cc.setModeContext(null, 0, 1, new Map());
    // Nothing tracked and no origin: every mode but free orbit needs a body.
    expect(cc.cycleMode()).toBe(CameraModeName.FREE_ORBIT);
    expect(cc.mode).toBe(CameraModeName.FREE_ORBIT);

    const { cc: withEarth } = oblate();
    expect(withEarth.cycleMode()).toBe(CameraModeName.SC_FIXED);
    expect(withEarth.mode).toBe(CameraModeName.SC_FIXED);
  });
});

describe('free look in co-rotating frames (slice B)', () => {
  for (const mode of [CameraModeName.BODY_FIXED, CameraModeName.SC_FIXED]) {
    it(`${mode}: right-drag turns the view in place and the look holds as the body turns`, () => {
      const { camera, cc, moon, frame, hover, rightDrag } = setup({ spinDegPerSec: 10 });
      hover(0, 0, 5000);
      cc.setModeForBody(mode, moon);
      frame();
      const before = camera.position.clone();
      const dirBefore = forward(camera);

      rightDrag(200, -100);
      frame();
      expect(cc.mode).toBe(mode);
      expect(cc.originBody).toBe(moon);
      expect(cc.trackedBody).toBe(moon);
      expect(camera.position.distanceTo(before)).toBeLessThan(1e-6);
      expect(forward(camera).angleTo(dirBefore)).toBeGreaterThan(0.3);

      // The camera's position and view, in the body's frame, survive time running.
      const toBody = (v: THREE.Vector3) => toBodyFixed(moon, v);
      const posBf = toBody(camera.position.clone().sub(moon.position));
      const dirBf = toBody(forward(camera));
      for (let i = 0; i < 5; i++) frame(0.1, 2);
      expect(toBody(camera.position.clone().sub(moon.position)).distanceTo(posBf)).toBeLessThan(1e-6);
      expect(toBody(forward(camera)).angleTo(dirBf)).toBeLessThan(1e-6);
    });
  }

  it('a free look ends a look-at but keeps the frame', () => {
    const { camera, cc, moon, craft, bodies, frame, hover, rightDrag } = setup({ spinDegPerSec: 10 });
    bodies.set('LRO', craft);
    hover(0, 0, 5000);
    cc.setModeForBody(CameraModeName.BODY_FIXED, moon);
    cc.lookAt(craft);
    frame();
    rightDrag(0, 150);
    frame();
    expect(cc.lookAtBody).toBeNull();
    expect(cc.mode).toBe(CameraModeName.BODY_FIXED);
    const dir = forward(camera);
    frame(0.1, 1);
    // No phantom aim pulling the view back to the spacecraft.
    expect(forward(camera).angleTo(dir)).toBeLessThan(0.2);
    expect(Math.abs(forward(camera).dot(craft.position.clone().sub(camera.position).normalize()))).toBeLessThan(0.99);
  });

  it('back to free orbit after a free look does not snap the view to the body', () => {
    const { camera, cc, moon, frame, hover, rightDrag } = setup();
    hover(0, 0, 5000);
    cc.setModeForBody(CameraModeName.BODY_FIXED, moon);
    frame();
    rightDrag(-120, 40);
    frame();
    const pos = camera.position.clone();
    const dir = forward(camera);
    cc.setModeForBody(CameraModeName.FREE_ORBIT, cc.modeSubject);
    for (let i = 0; i < 3; i++) frame();
    expect(camera.position.distanceTo(pos)).toBeLessThan(1e-6);
    expect(forward(camera).angleTo(dir)).toBeLessThan(1e-6);
    expect(cc.trackedBody).toBeNull();
  });

  it('modes that own the view still ignore a right-drag', () => {
    const { camera, cc, moon, frame, hover, rightDrag } = setup();
    hover(0, 0, 5000);
    cc.setMode(CameraModeName.LVLH, { bodyName: 'Moon', centerBodyName: 'Moon' });
    frame();
    const q = camera.quaternion.clone();
    rightDrag(200, 200);
    frame();
    expect(camera.quaternion.angleTo(q)).toBeLessThan(1e-9);
    expect(cc.trackedBody).toBe(moon);
  });
});
