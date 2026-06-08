import * as THREE from 'three';
import { CameraModeName, ensureQuatContinuity, bodyWorldOrientation, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';

const _offset = /* @__PURE__ */ new THREE.Vector3();
const _curQ = /* @__PURE__ */ new THREE.Quaternion();
const _deltaQ = /* @__PURE__ */ new THREE.Quaternion();

/**
 * Spacecraft-Locked Camera (KSP "Locked" mode).
 *
 * Camera orbits around the body, and the orbit frame co-rotates with the body's
 * attitude. TrackballControls active for orbit/zoom, WASD for translation,
 * all in the rotating frame.
 *
 * Attitude comes from the body's own rotation model via `bodyWorldOrientation`,
 * the same body→world composition `BodyMesh` renders with — so the camera tracks
 * the spacecraft exactly, whether the rotation is a SPICE CK, a TLE attitude, or
 * a catalog rotation, and without a J2000/ecliptic obliquity mismatch.
 */
export class ScFixedMode implements ICameraMode {
  readonly name = CameraModeName.SC_FIXED;
  readonly allowsOrbitControls = true;
  readonly allowsKeyboard = true;

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

      // Rotate orbit target around body center (preserves camera→target direction)
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
    // Same body→world composition the mesh renders with — works for SPICE CK,
    // TLE, and catalog rotations alike, with the obliquity already applied.
    return bodyWorldOrientation(bm, ctx.et, _curQ)?.clone() ?? null;
  }
}
