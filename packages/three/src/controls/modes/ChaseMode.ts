import * as THREE from 'three';
import { CameraModeName, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';

const _velDir = /* @__PURE__ */ new THREE.Vector3();
const _lookTarget = /* @__PURE__ */ new THREE.Vector3();
const _up = /* @__PURE__ */ new THREE.Vector3();
const _r = /* @__PURE__ */ new THREE.Vector3();
const _v = /* @__PURE__ */ new THREE.Vector3();

/**
 * Chase Camera — follows behind the velocity vector, looking forward along the trajectory.
 * Directly controls camera position and orientation each frame.
 * Scroll wheel adjusts follow distance.
 */
export class ChaseMode implements ICameraMode {
  readonly name = CameraModeName.CHASE;
  readonly allowsOrbitControls = false;
  readonly allowsKeyboard = false;

  private bodyName = '';
  private centerBodyName = '';
  private distanceKm = 100;
  /** Wheel listener for adjusting distance */
  private wheelHandler: ((e: WheelEvent) => void) | null = null;

  activate(ctx: CameraModeContext, params: CameraModeParams): void {
    this.bodyName = params.bodyName ?? '';
    this.centerBodyName = params.centerBodyName ?? '';
    this.distanceKm = params.offset ?? 100;

    // Listen to scroll wheel for distance adjustment
    const canvas = ctx.controls.domElement as HTMLElement | undefined;
    if (canvas) {
      this.wheelHandler = (e: WheelEvent) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.1 : 0.9;
        this.distanceKm = Math.max(0.001, this.distanceKm * factor); // 1 meter minimum
      };
      canvas.addEventListener('wheel', this.wheelHandler, { passive: false });
    }
  }

  update(ctx: CameraModeContext): void {
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm) return;

    const state = this.getStateVector(ctx);
    if (!state) return;

    _r.set(state[0], state[1], state[2]);
    _v.set(state[3], state[4], state[5]);

    const vLen = _v.length();
    if (vLen < 1e-10) return;

    _velDir.copy(_v).divideScalar(vLen);

    // Orbit normal for a stable "up" direction
    _up.crossVectors(_r, _v).normalize();
    if (_up.lengthSq() < 0.01) _up.set(0, 0, 1);

    // No smoothing needed — SPICE state vectors are inherently smooth (interpolated SPK).
    // Smoothing only adds lag that becomes visible at high time rates.

    // Position camera behind the velocity direction
    const sceneDist = this.distanceKm * ctx.scaleFactor;
    ctx.camera.position.copy(bm.position).addScaledVector(_velDir, -sceneDist);

    // Look ahead along velocity
    _lookTarget.copy(bm.position).addScaledVector(_velDir, sceneDist);
    ctx.camera.up.copy(_up);
    ctx.camera.lookAt(_lookTarget);
  }

  deactivate(ctx: CameraModeContext): void {
    this.bodyName = '';
    this.centerBodyName = '';

    // Clean up wheel listener
    if (this.wheelHandler) {
      const canvas = ctx.controls.domElement as HTMLElement | undefined;
      canvas?.removeEventListener('wheel', this.wheelHandler);
      this.wheelHandler = null;
    }
  }

  private getStateVector(ctx: CameraModeContext): [number, number, number, number, number, number] | null {
    if (!ctx.spice || !this.centerBodyName) return null;
    try {
      return ctx.spice.spkezr(
        this.bodyName, ctx.et, 'ECLIPJ2000', 'NONE', this.centerBodyName,
      ).state;
    } catch {
      return null;
    }
  }
}
