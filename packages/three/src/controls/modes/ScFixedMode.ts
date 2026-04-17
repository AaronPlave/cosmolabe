import * as THREE from 'three';
import { CameraModeName, ensureQuatContinuity, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';

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
 * Works with any rotation source:
 * 1. SPICE CK frame (pxform) — for spacecraft with CK kernels
 * 2. RotationModel quaternion — for TLE spacecraft, catalog rotations, etc.
 */
export class ScFixedMode implements ICameraMode {
  readonly name = CameraModeName.SC_FIXED;
  readonly allowsOrbitControls = true;
  readonly allowsKeyboard = true;

  private bodyName = '';
  private frameName = '';
  private readonly prevQuat = new THREE.Quaternion();
  private hasPrevQuat = false;

  activate(ctx: CameraModeContext, params: CameraModeParams): void {
    this.bodyName = params.bodyName ?? '';
    this.frameName = params.frameName ?? '';
    this.hasPrevQuat = false;

    if (!this.frameName) {
      this.frameName = this.resolveFrameName(ctx);
    }

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
    this.frameName = '';
    this.hasPrevQuat = false;
  }

  private getOrientationQuat(ctx: CameraModeContext): THREE.Quaternion | null {
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm) return null;

    // Path 1: SPICE pxform
    if (this.frameName && ctx.spice) {
      try {
        const r = ctx.spice.pxform(this.frameName, 'ECLIPJ2000', ctx.et);
        const m = new THREE.Matrix4();
        m.set(
          r[0], r[1], r[2], 0,
          r[3], r[4], r[5], 0,
          r[6], r[7], r[8], 0,
          0,    0,    0,    1,
        );
        _curQ.setFromRotationMatrix(m);
        return _curQ.clone();
      } catch { /* CK gap */ }
    }

    // Path 2: RotationModel
    if (bm.body.rotation) {
      const q = bm.body.rotationAt(ctx.et);
      if (q) {
        _curQ.set(-q[1], -q[2], -q[3], q[0]); // conjugate: body→inertial
        return _curQ.clone();
      }
    }

    return null;
  }

  private resolveFrameName(ctx: CameraModeContext): string {
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm || !ctx.spice) return '';

    const geoFrame = bm.body.geometryData?.spiceFrame as string | undefined;
    if (geoFrame) return geoFrame;

    if (bm.body.naifId != null) {
      try {
        if (ctx.spice.frmnam) {
          const name = ctx.spice.frmnam(bm.body.naifId * 1000);
          if (name) return name;
        }
      } catch { /* */ }

      try {
        if (ctx.spice.cidfrm) {
          const result = ctx.spice.cidfrm(bm.body.naifId);
          if (result) return result.frname;
        }
      } catch { /* */ }

      const upperName = this.bodyName.toUpperCase().replace(/\s+/g, '_');
      for (const candidate of [`${upperName}_SC_BUS`, `${upperName}_SPACECRAFT`, `IAU_${upperName}`]) {
        try {
          ctx.spice.pxform(candidate, 'ECLIPJ2000', ctx.et);
          return candidate;
        } catch { /* try next */ }
      }
    }

    return '';
  }
}
