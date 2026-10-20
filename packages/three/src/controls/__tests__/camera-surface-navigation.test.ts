/**
 * Surface navigation (#190) on a real `CameraController`: jumping and flying
 * to a pose on a body's surface, the surface pivot that follows the body as
 * it turns, and a flight that must not cut through the globe.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../CameraController.js';
import type { BodyMesh } from '../../BodyMesh.js';

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
