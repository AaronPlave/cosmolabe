import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SurfaceMode } from '../modes/SurfaceMode.js';
import type { CameraModeContext } from '../CameraModes.js';
import type { BodyMesh } from '../../BodyMesh.js';

function setup() {
  const view = new EventTarget();
  vi.stubGlobal('window', view);
  const canvas = Object.assign(new EventTarget(), { ownerDocument: { defaultView: view } });
  const camera = new THREE.PerspectiveCamera();
  let elevationKm = 0;
  const body = {
    body: { radii: [1737.4, 1737.4, 1737.4] }, position: new THREE.Vector3(), hasTerrain: true,
    bodyToWorldQuaternion: (q: THREE.Quaternion) => q.identity(),
    sampleTerrainElevation: () => ({ elevationKm }),
  } as unknown as BodyMesh;
  const ctx = { camera, controls: { domElement: canvas }, bodyMeshes: new Map([['Moon', body]]), scaleFactor: 1, dt: 0 } as unknown as CameraModeContext;
  const mode = new SurfaceMode();
  mode.activate(ctx, { bodyName: 'Moon', latDeg: 0, lonDeg: 0, altKm: 1 });
  const key = (type: string, code: string) => view.dispatchEvent(Object.assign(new Event(type), { code }));
  const frame = (dt: number) => {
    const p = camera.position.clone(); ctx.dt = dt; mode.update(ctx);
    return camera.position.distanceTo(p);
  };
  return { mode, ctx, camera, key, frame, terrain: (height: number) => { elevationKm = height; },
    wheel: (deltaY: number) => canvas.dispatchEvent(Object.assign(new Event('wheel'), { deltaY })) };
}
afterEach(() => vi.unstubAllGlobals());

describe('Surface Flight cruise pacing', () => {
  it('travels the same distance per elapsed second at 30, 60, 120 Hz and irregular pacing', () => {
    for (const steps of [Array(30).fill(1 / 30), Array(60).fill(1 / 60), Array(120).fill(1 / 120), Array(20).fill([.01, .04]).flat()]) {
      const s = setup(); s.key('keydown', 'KeyD');
      const distance = steps.reduce((sum, dt) => sum + s.frame(dt), 0);
      expect(distance).toBeCloseTo(2, 8);
      s.mode.deactivate(s.ctx);
    }
  });
  it('does not treat crater relief or a newly loaded terrain height as throttle input', () => {
    const s = setup(); s.key('keydown', 'KeyD');
    for (const elevation of [0, -.8, .8, 0, -.5]) {
      s.terrain(elevation);
      // Sample the new floor while stationary, then measure travel.
      s.frame(0);
      expect(s.frame(.02)).toBeCloseTo(.04, 8);
    }
    s.mode.deactivate(s.ctx);
  });
  it('applies wheel altitude physically once, updates cruise speed, and keeps the floor', () => {
    const s = setup();
    s.wheel(1); s.frame(0);
    expect(s.camera.position.length() - 1737.4).toBeCloseTo(1.15, 8);
    s.frame(0);
    expect(s.camera.position.length() - 1737.4).toBeCloseTo(1.15, 8);
    s.key('keydown', 'KeyD');
    expect(s.frame(.02)).toBeCloseTo(2.3 * .02, 8);
    s.key('keyup', 'KeyD');
    for (let n = 0; n < 100; n++) s.wheel(-1);
    s.frame(0);
    expect(s.camera.position.length() - 1737.4).toBeCloseTo(.01, 8);
    s.mode.deactivate(s.ctx);
  });
  it('keeps Shift boost explicit and clears held input on blur', () => {
    const s = setup(); s.key('keydown', 'KeyD'); s.key('keydown', 'ShiftLeft');
    expect(s.frame(.02)).toBeCloseTo(.2, 8);
    window.dispatchEvent(new Event('blur'));
    expect(s.frame(.02)).toBe(0);
    s.mode.deactivate(s.ctx);
  });
});
