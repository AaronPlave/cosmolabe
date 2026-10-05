/**
 * Generic frame-locked camera (#13): Body-Fixed, SC-Locked and LVLH are
 * instances of one `FrameLockedMode` over a `FrameOrientationSource`, and an
 * arbitrary SPICE frame goes through the same `composeBodyToWorldQuat`
 * composition as the rendered meshes — never a bare conjugate.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { composeBodyToWorldQuat, mat3ToQuat, quatToMat3 } from '@cosmolabe/core';
import type { Quaternion, RotationMatrix } from '@cosmolabe/core';
import { CameraModeName, type CameraModeContext, type CameraModeSpice } from '../CameraModes.js';
import { bodyRotationFrame, lvlhFrame, spiceFrame } from '../frameOrientation.js';
import { FrameLockedMode } from '../modes/FrameLockedMode.js';
import { BodyFixedMode } from '../modes/BodyFixedMode.js';
import { ScFixedMode } from '../modes/ScFixedMode.js';
import { LvlhMode } from '../modes/LvlhMode.js';
import type { BodyMesh } from '../../BodyMesh.js';

const OBLIQUITY_RAD = ((84381.448 / 3600) * Math.PI) / 180;

const axis = new THREE.Vector3(0.3, 0.4, 0.866).normalize();
function spinAt(deg: number): Quaternion {
  const q = new THREE.Quaternion().setFromAxisAngle(axis, (deg * Math.PI) / 180);
  return [q.w, q.x, q.y, q.z];
}

/** Body rotating 10°/s about `axis`, stated in EquatorJ2000. */
function fakeBodyMesh(name: string, position = new THREE.Vector3(5, -2, 1)): BodyMesh {
  return {
    position,
    body: { name, rotation: { sourceFrame: 'EquatorJ2000' }, rotationAt: (et: number) => spinAt(10 * et) },
  } as unknown as BodyMesh;
}

function fakeSpice(over: Partial<CameraModeSpice> = {}): CameraModeSpice {
  return {
    pxform: (_from, _to, et) => [...quatToMat3(spinAt(10 * et))],
    spkezr: () => { throw new Error('no SPK'); },
    ...over,
  };
}

function fakeCtx(bms: BodyMesh[], spice: CameraModeSpice | null = fakeSpice()): CameraModeContext {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(8, 1, 3);
  camera.lookAt(5, -2, 1);
  return {
    camera,
    controls: { target: new THREE.Vector3(5, -2, 1) } as unknown as CameraModeContext['controls'],
    bodyMeshes: new Map(bms.map((b) => [b.body.name, b])),
    spice,
    et: 0,
    dt: 0,
    scaleFactor: 1,
    originBody: null,
  };
}

const toThree = (q: Quaternion) => new THREE.Quaternion(q[1], q[2], q[3], q[0]);

describe('spiceFrame (arbitrary furnished frame)', () => {
  it('composes pxform(J2000→frame) through composeBodyToWorldQuat, obliquity included', () => {
    const m = quatToMat3(spinAt(40));
    const ctx = fakeCtx([], fakeSpice({ pxform: () => [...m] }));
    const got = spiceFrame('SOME_FRAME').orientation(ctx, new THREE.Quaternion())!;
    const expected = toThree(composeBodyToWorldQuat(mat3ToQuat(m as RotationMatrix), 'J2000'));
    expect(got.angleTo(expected)).toBeLessThan(1e-9);

    // A bare conjugate would drop the J2000→ecliptic leg: exactly the obliquity off.
    const q = spinAt(40);
    const bare = new THREE.Quaternion(-q[1], -q[2], -q[3], q[0]);
    expect(got.angleTo(bare)).toBeCloseTo(OBLIQUITY_RAD, 6);
  });

  it('asks pxform for J2000 → the named frame', () => {
    const calls: string[] = [];
    const ctx = fakeCtx([], fakeSpice({ pxform: (f, t) => { calls.push(`${f}->${t}`); return [1, 0, 0, 0, 1, 0, 0, 0, 1]; } }));
    spiceFrame('IAU_MOON').orientation(ctx, new THREE.Quaternion());
    expect(calls).toEqual(['J2000->IAU_MOON']);
  });

  it('returns null without SPICE or when pxform throws (coverage gap)', () => {
    expect(spiceFrame('X').orientation(fakeCtx([], null), new THREE.Quaternion())).toBeNull();
    const gap = fakeCtx([], fakeSpice({ pxform: () => { throw new Error('CK gap'); } }));
    expect(spiceFrame('X').orientation(gap, new THREE.Quaternion())).toBeNull();
  });

  it('agrees with the body rotation model when that model is the same rotation from J2000', () => {
    // Same source→frame rotation stated two ways must land on the same basis.
    const ctx = fakeCtx([fakeBodyMesh('Moon')]);
    ctx.et = 3;
    const viaSpice = spiceFrame('IAU_MOON').orientation(ctx, new THREE.Quaternion())!;
    const viaBody = bodyRotationFrame('Moon').orientation(ctx, new THREE.Quaternion())!;
    expect(viaSpice.angleTo(viaBody)).toBeLessThan(1e-9);
  });
});

describe('the existing locked modes are FrameLockedMode instances', () => {
  it('Body-Fixed, SC-Locked and LVLH share the generic mechanism', () => {
    for (const m of [new BodyFixedMode(), new ScFixedMode(), new LvlhMode()]) {
      expect(m).toBeInstanceOf(FrameLockedMode);
    }
    expect(new BodyFixedMode().name).toBe(CameraModeName.BODY_FIXED);
    expect(new ScFixedMode().allowsKeyboard).toBe(true);
    expect(new LvlhMode().allowsOrbitControls).toBe(false);
  });

  it('exposes the resolved frame identity', () => {
    const ctx = fakeCtx([fakeBodyMesh('LRO')]);
    const sc = new ScFixedMode();
    sc.activate(ctx, { bodyName: 'LRO' });
    expect(sc.frameId).toBe('body:LRO');
    sc.activate(ctx, { bodyName: 'LRO', frameName: 'LRO_SC_BUS' });
    expect(sc.frameId).toBe('spice:LRO_SC_BUS');
    const lvlh = new LvlhMode();
    lvlh.activate(ctx, { bodyName: 'LRO', centerBodyName: 'MOON' });
    expect(lvlh.frameId).toBe('lvlh:LRO/MOON');
    lvlh.deactivate(ctx);
    expect(lvlh.frameId).toBeNull();
  });

  for (const [label, frameName] of [['body rotation', undefined], ['SPICE frame', 'IAU_MOON']] as const) {
    it(`Body-Fixed co-rotates the camera with the frame (${label})`, () => {
      const bm = fakeBodyMesh('Moon');
      const ctx = fakeCtx([bm]);
      const mode = new BodyFixedMode();
      mode.activate(ctx, { bodyName: 'Moon', frameName });

      // Camera offset expressed in the body frame must stay constant.
      const frameAt = (et: number) => {
        ctx.et = et;
        return bodyRotationFrame('Moon').orientation(ctx, new THREE.Quaternion())!;
      };
      const local0 = ctx.camera.position.clone().sub(bm.position).applyQuaternion(frameAt(0).invert());
      ctx.et = 2.5;
      mode.update(ctx);
      const local1 = ctx.camera.position.clone().sub(bm.position).applyQuaternion(frameAt(2.5).invert());
      expect(local1.distanceTo(local0)).toBeLessThan(1e-9);
    });
  }
});

describe('LVLH as an attached frame lock', () => {
  // r and v chosen off-axis so every LVLH axis is distinct from the world axes.
  const state: [number, number, number, number, number, number] = [7000, 1200, -300, -0.5, 7.4, 0.9];

  /** The pre-refactor LvlhMode basis, written out independently. */
  function legacy(axisLabel: string): { forward: THREE.Vector3; up: THREE.Vector3 } {
    const r = new THREE.Vector3(state[0], state[1], state[2]);
    const v = new THREE.Vector3(state[3], state[4], state[5]);
    const d = r.clone().normalize().negate();
    const n = new THREE.Vector3().crossVectors(r, v).normalize();
    const a = new THREE.Vector3().crossVectors(n, d).normalize();
    const zen = d.clone().negate();
    switch (axisLabel) {
      case '-Z': return { forward: d, up: a };
      case '+Z': return { forward: zen, up: a };
      case '+X': return { forward: a, up: zen };
      case '-X': return { forward: a.clone().negate(), up: zen };
      case '+Y': return { forward: n, up: zen };
      default: return { forward: n.clone().negate(), up: zen };
    }
  }

  for (const axisLabel of ['-Z', '+Z', '+X', '-X', '+Y', '-Y'] as const) {
    it(`matches the legacy basis looking ${axisLabel}`, () => {
      const bm = fakeBodyMesh('LRO', new THREE.Vector3(10, 20, 30));
      const ctx = fakeCtx([bm], fakeSpice({ spkezr: () => ({ state, lightTime: 0 }) }));
      const mode = new LvlhMode();
      mode.activate(ctx, { bodyName: 'LRO', centerBodyName: 'MOON', axis: axisLabel, offset: 2 });
      mode.update(ctx);

      const want = legacy(axisLabel);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      expect(forward.angleTo(want.forward)).toBeLessThan(1e-9);
      expect(ctx.camera.up.angleTo(want.up)).toBeLessThan(1e-9);
      const expectedPos = bm.position.clone().addScaledVector(want.forward, -2);
      expect(ctx.camera.position.distanceTo(expectedPos)).toBeLessThan(1e-9);
    });
  }

  it('the LVLH frame is a proper rotation (right-handed)', () => {
    const ctx = fakeCtx([], fakeSpice({ spkezr: () => ({ state, lightTime: 0 }) }));
    const q = lvlhFrame('LRO', 'MOON').orientation(ctx, new THREE.Quaternion())!;
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    expect(m.determinant()).toBeCloseTo(1, 12);
  });
});
