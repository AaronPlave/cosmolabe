/**
 * Surface navigation (#190) on a real `CameraController`: jumping and flying
 * to a pose on a body's surface, the surface pivot that follows the body as
 * it turns, and a flight that must not cut through the globe.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CameraController, SURFACE_PIVOT_CLEARANCE_KM } from '../CameraController.js';
import { CameraModeName } from '../CameraModes.js';
import type { BodyMesh } from '../../BodyMesh.js';
import type { SurfacePoint } from '../../SceneHit.js';
import { frameSurfacePoint } from '../../SurfaceNavigation.js';

function fakeElement(width = 800, height = 600) {
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

const R = 3390;

function fakeGlobe(name: string, position: THREE.Vector3): BodyMesh {
  return {
    position,
    displayRadius: R,
    scaleFactor: 1,
    hasTerrain: false,
    mesh: { quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) },
    body: { name, rotation: undefined, rotationAt: () => undefined },
    getDskMeshes: () => [],
  } as unknown as BodyMesh;
}

beforeAll(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 1e-6, 1e12);
  const cc = new CameraController(camera, fakeElement());
  const mars = fakeGlobe('Mars', new THREE.Vector3());
  cc.setModeContext(null, 0, 1, new Map([['Mars', mars]]));
  cc.focus(mars);
  camera.position.set(0, 0, 4 * R);
  cc.controls.target.set(0, 0, 0);
  camera.up.set(0, 1, 0);
  camera.lookAt(cc.controls.target);
  const frame = (seconds: number) => {
    now += seconds * 1000;
    cc.applyPendingOriginSwitch();
    cc.update();
  };
  return { camera, cc, mars, frame };
}

/** On the +X side of the globe (mesh frame), 100 km up, looking down at it. */
const overheadX = (): { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } => ({
  position: new THREE.Vector3(R + 100, 0, 0),
  target: new THREE.Vector3(R, 0, 0),
  up: new THREE.Vector3(0, 1, 0),
});

const close = (a: THREE.Vector3, b: THREE.Vector3, tol = 1e-6) => expect(a.distanceTo(b)).toBeLessThan(tol * Math.max(1, b.length()));

describe('jumpToSurface', () => {
  it('cuts to the pose, tracks the body and pivots on the surface point', () => {
    const { camera, cc, mars, frame } = setup();
    cc.jumpToSurface(mars, overheadX());
    expect(cc.trackedBody).toBe(mars);
    close(camera.position, new THREE.Vector3(R + 100, 0, 0));
    close(cc.controls.target, new THREE.Vector3(R, 0, 0));
    frame(0.016);
    // Not snapped back to the body's centre.
    close(cc.controls.target, new THREE.Vector3(R, 0, 0));
    expect(cc.surfacePivot?.body).toBe(mars);
  });

  it('keeps the geographic point under the camera as the body turns', () => {
    const { camera, cc, mars, frame } = setup();
    cc.jumpToSurface(mars, overheadX());
    frame(0.016);
    mars.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    frame(0.016);
    const ground = new THREE.Vector3(R, 0, 0).applyQuaternion(mars.mesh.quaternion);
    close(cc.controls.target, ground);
    close(camera.position, new THREE.Vector3(R + 100, 0, 0).applyQuaternion(mars.mesh.quaternion), 1e-4);
  });

  it('lets zoom approach the point instead of stopping at the body radius', () => {
    const { camera, cc, mars, frame } = setup();
    cc.jumpToSurface(mars, overheadX());
    frame(0.016);
    expect(cc.controls.minDistance).toBeLessThan(1);
    expect(camera.position.length()).toBeGreaterThan(R);
  });

  it('ends with any other navigation', () => {
    const { cc, mars, frame } = setup();
    cc.jumpToSurface(mars, overheadX());
    cc.frame(mars);
    frame(0.016);
    expect(cc.surfacePivot).toBeNull();
    expect(cc.controls.target.length()).toBeLessThan(1e-9);
  });
});

describe('near the ground of a globe without terrain', () => {
  const groundPose = (heightKm: number) => ({
    position: new THREE.Vector3(R + heightKm, 0, 0.014),
    target: new THREE.Vector3(R, 0, 0),
    up: new THREE.Vector3(1, 0, 0),
  });

  it('keeps a 2 m eye height instead of pushing it out to a fraction of the radius', () => {
    const { camera, cc, mars, frame } = setup();
    cc.jumpToSurface(mars, groundPose(0.002));
    for (let i = 0; i < 10; i++) frame(0.016);
    expect(camera.position.length() - R).toBeGreaterThan(0.0019);
    expect(camera.position.length() - R).toBeLessThan(0.0025);
  });

  it('floors a dive toward the ground at the 2 m clearance', () => {
    const { camera, cc, mars, frame } = setup();
    cc.jumpToSurface(mars, groundPose(0.010));
    frame(0.016);
    // Something drives the camera under the surface (an orbit about the pivot, say).
    camera.position.set(R - 0.5, 0, 0.01);
    frame(0.016);
    expect(camera.position.length() - R).toBeCloseTo(SURFACE_PIVOT_CLEARANCE_KM, 6);
    // The pivot stays on the ground.
    close(cc.controls.target, new THREE.Vector3(R, 0, 0));
  });
});

describe('retargetSurface', () => {
  it('moves the pivot and the camera together once terrain arrives', () => {
    const { camera, cc, mars, frame } = setup();
    cc.jumpToSurface(mars, overheadX());
    frame(0.016);
    const before = camera.position.clone();
    expect(cc.retargetSurface(mars, new THREE.Vector3(-2.6, 0, 0))).toBe(true);
    frame(0.016);
    close(cc.controls.target, new THREE.Vector3(R - 2.6, 0, 0));
    close(camera.position, before.clone().add(new THREE.Vector3(-2.6, 0, 0)), 1e-6);
  });

  it('retargets a flight still on its way', () => {
    const { camera, cc, mars, frame } = setup();
    cc.flyToSurface(mars, overheadX());
    frame(0.1);
    expect(cc.retargetSurface(mars, new THREE.Vector3(5, 0, 0))).toBe(true);
    for (let i = 0; i < 200 && cc.flight; i++) frame(0.05);
    frame(0.016);
    close(camera.position, new THREE.Vector3(R + 105, 0, 0), 1e-6);
    close(cc.controls.target, new THREE.Vector3(R + 5, 0, 0));
  });

  it('does nothing without surface navigation on that body', () => {
    const { cc, mars } = setup();
    expect(cc.retargetSurface(mars, new THREE.Vector3(1, 0, 0))).toBe(false);
  });
});

describe('flyToSurface', () => {
  it('arcs round the globe to the far side without entering it, then pivots', () => {
    const { camera, cc, mars, frame } = setup();
    // Start just above the -X side; the destination is on +X, opposite.
    camera.position.set(-(R + 50), 0, 0);
    cc.controls.target.set(-R, 0, 0);
    cc.flyToSurface(mars, overheadX());
    let lowest = Infinity;
    for (let i = 0; i < 200 && cc.flight; i++) {
      frame(0.02);
      lowest = Math.min(lowest, camera.position.length());
    }
    expect(cc.flight).toBeNull();
    expect(lowest).toBeGreaterThan(R);
    frame(0.016);
    close(camera.position, new THREE.Vector3(R + 100, 0, 0), 1e-6);
    close(cc.controls.target, new THREE.Vector3(R, 0, 0));
    expect(cc.trackedBody).toBe(mars);
  });

  it('reports the body as the destination while it flies', () => {
    const { cc, mars, frame } = setup();
    cc.flyToSurface(mars, overheadX());
    frame(0.1);
    expect(cc.flight?.destination).toBe(mars);
  });

  it('stopped mid-way, leaves the camera where it is facing the target', () => {
    const { camera, cc, mars, frame } = setup();
    cc.flyToSurface(mars, overheadX(), { duration: 2 });
    frame(0.5);
    const at = camera.position.clone();
    expect(cc.stopFlight()).toBe(true);
    frame(0.016);
    close(camera.position, at, 1e-3);
    close(cc.controls.target, new THREE.Vector3(R, 0, 0));
    expect(cc.surfacePivot?.body).toBe(mars);
  });

  it('a line path stays on the segment', () => {
    const { camera, cc, mars, frame } = setup();
    const pose = { position: new THREE.Vector3(0, 0, R + 10), target: new THREE.Vector3(0, 0, R), up: new THREE.Vector3(0, 1, 0) };
    cc.flyToSurface(mars, pose, { path: 'line' });
    for (let i = 0; i < 100 && cc.flight; i++) {
      frame(0.05);
      expect(Math.abs(camera.position.x) + Math.abs(camera.position.y)).toBeLessThan(1e-6);
    }
    expect(camera.position.z).toBeCloseTo(R + 10, 6);
  });
});

describe('releaseSurface', () => {
  const pose = () => ({ position: new THREE.Vector3(R + 100, 30, 0), target: new THREE.Vector3(R, 0, 0), up: new THREE.Vector3(0, 1, 0) });
  const forward = (camera: THREE.PerspectiveCamera) => camera.getWorldDirection(new THREE.Vector3());

  it('after landing: keeps the camera location and tracks the body centre, with no pivot', () => {
    const { camera, cc, mars, frame } = setup();
    cc.jumpToSurface(mars, pose());
    frame(0.016);
    const at = camera.position.clone();
    expect(cc.releaseSurface()).toBe(true);
    for (let i = 0; i < 5; i++) frame(0.016);
    expect(cc.surfaceNavigating).toBe(false);
    expect(cc.surfacePivot).toBeNull();
    expect(cc.trackedBody).toBe(mars);
    close(camera.position, at, 1e-9);
    close(cc.controls.target, mars.position, 1e-9);
    expect(forward(camera).dot(mars.position.clone().sub(camera.position).normalize())).toBeCloseTo(1, 9);
    // Released: the body turns under the camera rather than carrying it.
    mars.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    frame(0.016);
    close(camera.position, at, 1e-9);
    // Nothing left for terrain to retarget, and a second release is a no-op.
    expect(cc.retargetSurface(mars, new THREE.Vector3(1, 0, 0))).toBe(false);
    expect(cc.releaseSurface()).toBe(false);
  });

  it('holds the orbit point at the body centre as the body moves', () => {
    // The floating origin keeps a tracked body at the origin; the orbit
    // point must follow that body, without the released coordinate offset.
    const { cc, mars, frame } = setup();
    cc.jumpToSurface(mars, pose());
    frame(0.016);
    cc.releaseSurface();
    frame(0.016);
    const offset = cc.controls.target.clone().sub(mars.position);
    close(offset, new THREE.Vector3());
    mars.position.set(50, -20, 10);
    frame(0.016);
    close(cc.controls.target.clone().sub(mars.position), offset, 1e-9);
  });

  it('keeps a 2 m eye height instead of pushing it up once released', () => {
    const { camera, cc, mars, frame } = setup();
    cc.jumpToSurface(mars, { position: new THREE.Vector3(R + 0.002, 0, 0.014), target: new THREE.Vector3(R, 0, 0), up: new THREE.Vector3(1, 0, 0) });
    frame(0.016);
    cc.releaseSurface();
    for (let i = 0; i < 5; i++) frame(0.016);
    expect(camera.position.length() - R).toBeLessThan(0.0025);
  });

  it('during a flight: stops where it is and resumes body-centred tracking without a pivot', () => {
    const { camera, cc, mars, frame } = setup();
    cc.flyToSurface(mars, pose(), { duration: 2 });
    frame(0.5);
    const at = camera.position.clone();
    expect(cc.releaseSurface()).toBe(true);
    expect(cc.flight).toBeNull();
    for (let i = 0; i < 5; i++) frame(0.016);
    close(camera.position, at, 1e-9);
    close(cc.controls.target, mars.position, 1e-9);
    expect(forward(camera).dot(mars.position.clone().sub(camera.position).normalize())).toBeCloseTo(1, 9);
    expect(cc.trackedBody).toBe(mars);
    expect(cc.surfaceNavigating).toBe(false);
  });

  it('clears a completed flight before its deferred origin switch', () => {
    const { camera, cc, mars, frame } = setup();
    cc.flyToSurface(mars, pose(), { duration: 1 });
    frame(1);
    const at = camera.position.clone();
    expect(cc.releaseSurface()).toBe(true);
    frame(0.016);
    expect(cc.trackedBody).toBe(mars);
    expect(cc.surfaceNavigating).toBe(false);
    close(cc.controls.target, mars.position, 1e-9);
    close(camera.position, at, 1e-9);
  });

  it('returns a body-fixed orbit to the body centre too', () => {
    const { camera, cc, mars, frame } = setup();
    cc.setMode(CameraModeName.BODY_FIXED, { bodyName: 'Mars' });
    cc.jumpToSurface(mars, pose());
    frame(0.016);
    const at = camera.position.clone();
    expect(cc.releaseSurface()).toBe(true);
    frame(0.016);
    expect(cc.trackedBody).toBe(mars);
    expect(cc.surfaceNavigating).toBe(false);
    close(cc.controls.target, mars.position, 1e-9);
    close(camera.position, at, 1e-9);
  });

  it('ends with the next navigation', () => {
    const { cc, mars, frame } = setup();
    cc.jumpToSurface(mars, pose());
    frame(0.016);
    cc.releaseSurface();
    cc.frame(mars);
    frame(0.016);
    expect(cc.controls.target.length()).toBeLessThan(1e-9);
  });
});

describe('framing a picked point repeatedly', () => {
  const pick = { bodyName: 'Mars', bodyFixedPositionKm: [R, 0, 0], source: 'ellipsoid' } as unknown as SurfacePoint;

  it('Frame here twice does not move the camera again', () => {
    const { camera, cc, mars, frame } = setup();
    camera.position.set(2 * R, 0, 2 * R);
    camera.lookAt(0, 0, 0);
    const poses: THREE.Vector3[] = [];
    for (let i = 0; i < 3; i++) {
      cc.jumpToSurface(mars, frameSurfacePoint(mars, camera, pick, 1, 34)!);
      frame(0.016);
      poses.push(camera.position.clone());
    }
    expect(poses[0].distanceTo(new THREE.Vector3(R, 0, 0))).toBeCloseTo(34, 6);
    close(poses[1], poses[0], 1e-9);
    close(poses[2], poses[0], 1e-9);
  });

  it('Fly to here lands at the same framing, not a further zoom', () => {
    const { camera, cc, mars, frame } = setup();
    camera.position.set(2 * R, 0, 2 * R);
    camera.lookAt(0, 0, 0);
    const landed: THREE.Vector3[] = [];
    for (let i = 0; i < 2; i++) {
      cc.flyToSurface(mars, frameSurfacePoint(mars, camera, pick, 1, 34)!, { path: 'line' });
      for (let k = 0; k < 200 && cc.flight; k++) frame(0.05);
      frame(0.016);
      landed.push(camera.position.clone());
    }
    expect(landed[0].distanceTo(new THREE.Vector3(R, 0, 0))).toBeCloseTo(34, 6);
    close(landed[1], landed[0], 1e-9);
  });
});


describe('Navigate panel flights and local controls', () => {
  it('does not launch an arc at a landed destination, including below the datum', () => {
    const { cc, mars, camera, frame } = setup();
    Object.assign(mars, { hasTerrain: true });
    const pose = overheadX();
    pose.target.set(R - 5.3, 0, 0);
    pose.position.set(R - 5.3 + 0.002, 0, 0.014);
    cc.jumpToSurface(mars, pose);
    frame(0.016);
    const at = camera.position.clone();
    for (let i = 0; i < 3; i++) {
      cc.flyToSurface(mars, pose);
      expect(cc.flight).toBeNull();
      frame(0.016);
      close(camera.position, at, 1e-12);
    }
    expect(cc.surfacePivot).not.toBeNull();
  });

  it('ignores identical clicks while flying instead of restarting the clock', () => {
    const { cc, mars, frame } = setup();
    cc.flyToSurface(mars, overheadX(), { duration: 1 });
    for (let i = 0; i < 11; i++) {
      frame(0.1);
      if (cc.flight) cc.flyToSurface(mars, overheadX(), { duration: 1 });
    }
    expect(cc.flight).toBeNull();
  });

  it('keeps nearby surface travel local, with no planetary cruise lift', () => {
    const { cc, mars, camera, frame } = setup();
    const from = overheadX(); from.position.x = R + 0.01;
    cc.jumpToSurface(mars, from);
    frame(0.016);
    const to = { position: from.position.clone(), target: from.target.clone(), up: from.up.clone() };
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.001);
    to.position.applyQuaternion(q); to.target.applyQuaternion(q);
    cc.flyToSurface(mars, to, { duration: 1 });
    for (let i = 0; i < 11; i++) {
      frame(0.1);
      expect(camera.position.length() - R).toBeCloseTo(0.01, 6);
    }
  });

  it('keeps local clearance while returning released controls to body-centred speeds', () => {
    const { cc, mars, camera, frame } = setup();
    Object.assign(mars.body, { geometryType: 'Globe' });
    Object.assign(mars, {
      hasTerrain: true,
      sampleTerrainBodyFixed: () => ({ elevationKm: -5.3 }),
      terrainBodyFixedToGeodetic: () => ({ heightKm: camera.position.length() - R }),
    });
    const pose = overheadX(); pose.target.x = R - 5.3;
    pose.position.set(R - 5.3 + 0.002, 0, 0.014);
    cc.jumpToSurface(mars, pose); frame(0.016);
    cc.adaptSpeeds([mars], 1);
    const rotate = cc.controls.rotateSpeed, zoom = cc.controls.zoomSpeed;
    expect(rotate).toBeGreaterThan(0.5);
    expect(zoom).toBeGreaterThan(0.5);
    expect(cc.keyboard.altitudeRefSceneUnits).toBeCloseTo(0.002, 5);
    cc.releaseSurface(); frame(0.016); cc.adaptSpeeds([mars], 1);
    close(cc.controls.target, mars.position, 1e-9);
    expect(cc.controls.rotateSpeed).toBeGreaterThan(0);
    expect(cc.controls.rotateSpeed).toBeLessThan(rotate);
    expect(cc.controls.zoomSpeed).toBeGreaterThan(0);
    expect(cc.controls.zoomSpeed).toBeLessThan(zoom);
    expect(cc.keyboard.altitudeRefSceneUnits).toBeCloseTo(0.002, 5);
    // A higher eye in the same below-datum basin uses its actual 10 m clearance.
    camera.position.x += 0.008;
    cc.adaptSpeeds([mars], 1);
    expect(cc.keyboard.altitudeRefSceneUnits).toBeCloseTo(0.01, 5);
  });
});
