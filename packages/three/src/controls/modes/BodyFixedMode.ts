import * as THREE from 'three';
import { CameraModeName, ensureQuatContinuity, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';

const _offset = /* @__PURE__ */ new THREE.Vector3();
const _curQ = /* @__PURE__ */ new THREE.Quaternion();
const _deltaQ = /* @__PURE__ */ new THREE.Quaternion();

/**
 * Body-Fixed Camera (Celestia-style Sync Orbit).
 * Camera co-rotates with the body so surface features stay fixed.
 * TrackballControls active for orbit/zoom in the rotating frame.
 */
export class BodyFixedMode implements ICameraMode {
  readonly name = CameraModeName.BODY_FIXED;
  readonly allowsOrbitControls = true;
  readonly allowsKeyboard = false;

  private bodyName = '';
  private readonly prevQuat = new THREE.Quaternion();
  private hasPrevQuat = false;

  activate(ctx: CameraModeContext, params: CameraModeParams): void {
    this.bodyName = params.bodyName ?? '';
    this.hasPrevQuat = false;

    const q = this.getOrientationQuat(ctx);
    if (q) {
      this.prevQuat.copy(q);
      this.hasPrevQuat = true;
    }
  }

  update(ctx: CameraModeContext): void {
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm) return;

    const curQuat = this.getOrientationQuat(ctx);
    if (!curQuat) return;

    if (this.hasPrevQuat) {
      ensureQuatContinuity(curQuat, this.prevQuat);
      _deltaQ.copy(this.prevQuat).invert().premultiply(curQuat);

      // Rotate camera position around body center
      _offset.copy(ctx.camera.position).sub(bm.position);
      _offset.applyQuaternion(_deltaQ);
      ctx.camera.position.copy(bm.position).add(_offset);

      // Rotate orbit target around body center
      _offset.copy(ctx.controls.target).sub(bm.position);
      _offset.applyQuaternion(_deltaQ);
      ctx.controls.target.copy(bm.position).add(_offset);

      // Rotate camera orientation and up vector
      ctx.camera.quaternion.premultiply(_deltaQ);
      ctx.camera.up.applyQuaternion(_deltaQ).normalize();
    }

    this.prevQuat.copy(curQuat);
    this.hasPrevQuat = true;
  }

  deactivate(_ctx: CameraModeContext): void {
    this.bodyName = '';
    this.hasPrevQuat = false;
  }

  private getOrientationQuat(ctx: CameraModeContext): THREE.Quaternion | null {
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm) return null;

    if (ctx.spice) {
      const frameName = 'IAU_' + this.bodyName.toUpperCase().replace(/\s+/g, '_');
      try {
        const r = ctx.spice.pxform(frameName, 'ECLIPJ2000', ctx.et);
        const m = new THREE.Matrix4();
        m.set(
          r[0], r[1], r[2], 0,
          r[3], r[4], r[5], 0,
          r[6], r[7], r[8], 0,
          0,    0,    0,    1,
        );
        _curQ.setFromRotationMatrix(m);
        return _curQ.clone();
      } catch { /* fall through */ }
    }

    if (bm.body.rotation) {
      const q = bm.body.rotationAt(ctx.et);
      if (q) {
        _curQ.set(-q[1], -q[2], -q[3], q[0]);
        return _curQ.clone();
      }
    }

    return null;
  }
}
