import * as THREE from 'three';
import { CameraModeName, ensureQuatContinuity, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';
import type { BodyMesh } from '../../BodyMesh.js';

const _surfaceNormal = /* @__PURE__ */ new THREE.Vector3();
const _forward = /* @__PURE__ */ new THREE.Vector3();
const _right = /* @__PURE__ */ new THREE.Vector3();
const _move = /* @__PURE__ */ new THREE.Vector3();
const _lookTarget = /* @__PURE__ */ new THREE.Vector3();
const _toBody = /* @__PURE__ */ new THREE.Vector3();

/**
 * Surface Flight Camera — WASD flight over a body's surface, airplane-style.
 *
 * Controls:
 * - W/S: fly forward/backward in the look direction (pitch changes altitude)
 * - A/D: strafe left/right
 * - Mouse drag: look around (yaw/pitch, horizon stays level)
 * - Scroll wheel: adjust altitude directly
 * - Shift: speed boost
 *
 * The camera co-rotates with the body. Heading is maintained as a body-fixed
 * direction that's updated after movement to prevent drift.
 */
export class SurfaceMode implements ICameraMode {
  readonly name = CameraModeName.SURFACE;
  readonly allowsOrbitControls = false;
  /** false = not handled by CameraController's KeyboardControls; SurfaceMode manages its own input */
  readonly allowsKeyboard = false;

  private bodyName = '';
  private altitudeKm = 10;
  private speedKmPerSec = 10;
  private yaw = 0;
  private pitch = 0;

  /** Forward direction stored in body-fixed coordinates (stable reference) */
  private readonly bodyFixedForward = new THREE.Vector3();
  /** Previous frame's body orientation for delta rotation */
  private readonly prevQuat = new THREE.Quaternion();
  private hasPrevQuat = false;
  /** Current body→J2000 quaternion (cached for body-fixed conversions) */
  private readonly curBodyQuat = new THREE.Quaternion();
  private hasBodyQuat = false;

  private readonly keys = new Set<string>();
  private dragging = false;
  private prevMouseX = 0;
  private prevMouseY = 0;
  private dragDx = 0;
  private dragDy = 0;
  private handlers: {
    keydown: (e: KeyboardEvent) => void; keyup: (e: KeyboardEvent) => void;
    mousedown: (e: MouseEvent) => void; mousemove: (e: MouseEvent) => void;
    mouseup: (e: MouseEvent) => void; wheel: (e: WheelEvent) => void;
    blur: () => void; contextmenu: (e: Event) => void;
  } | null = null;

  activate(ctx: CameraModeContext, params: CameraModeParams): void {
    this.bodyName = params.bodyName ?? '';
    this.altitudeKm = params.altKm ?? 10;
    this.speedKmPerSec = this.altitudeKm * 2;
    this.yaw = 0;
    this.pitch = 0;
    this.keys.clear();
    this.dragDx = 0;
    this.dragDy = 0;
    this.hasPrevQuat = false;
    this.hasBodyQuat = false;

    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm || !bm.body.radii) return;

    const latDeg = params.latDeg ?? 0;
    const lonDeg = params.lonDeg ?? 0;
    const re = bm.body.radii[0];
    const rp = bm.body.radii[2];
    const latRad = latDeg * Math.PI / 180;
    const lonRad = lonDeg * Math.PI / 180;
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    const cosLon = Math.cos(lonRad);
    const sinLon = Math.sin(lonRad);
    const e2 = 1 - (rp * rp) / (re * re);
    const N = re / Math.sqrt(1 - e2 * sinLat * sinLat);

    // Body-fixed surface position
    const posKm = new THREE.Vector3(
      (N + this.altitudeKm) * cosLat * cosLon,
      (N + this.altitudeKm) * cosLat * sinLon,
      (N * (1 - e2) + this.altitudeKm) * sinLat,
    );

    // Body-fixed north at this lat/lon
    this.bodyFixedForward.set(-sinLat * cosLon, -sinLat * sinLon, cosLat).normalize();

    // Transform to J2000
    const bodyQ = this.getBodyQuat(ctx, bm);
    if (bodyQ) {
      posKm.applyQuaternion(bodyQ);
      this.prevQuat.copy(bodyQ);
      this.hasPrevQuat = true;
      this.curBodyQuat.copy(bodyQ);
      this.hasBodyQuat = true;
    }

    ctx.camera.position.copy(bm.position).addScaledVector(posKm, ctx.scaleFactor);

    // Set up event listeners
    const canvas = ctx.controls.domElement as HTMLElement;
    if (canvas && !this.handlers) {
      this.handlers = {
        keydown: (e: KeyboardEvent) => {
          const tag = (e.target as HTMLElement)?.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          this.keys.add(e.code);
        },
        keyup: (e: KeyboardEvent) => { this.keys.delete(e.code); },
        mousedown: (e: MouseEvent) => {
          if (e.button === 0 || e.button === 2) {
            this.dragging = true;
            this.prevMouseX = e.clientX;
            this.prevMouseY = e.clientY;
          }
        },
        mousemove: (e: MouseEvent) => {
          if (!this.dragging) return;
          this.dragDx += e.clientX - this.prevMouseX;
          this.dragDy += e.clientY - this.prevMouseY;
          this.prevMouseX = e.clientX;
          this.prevMouseY = e.clientY;
        },
        mouseup: () => { this.dragging = false; },
        wheel: (e: WheelEvent) => {
          e.preventDefault();
          const factor = e.deltaY > 0 ? 1.15 : 0.87;
          this.altitudeKm = Math.max(0.01, this.altitudeKm * factor);
          this.speedKmPerSec = this.altitudeKm * 2;
        },
        blur: () => { this.keys.clear(); this.dragging = false; },
        contextmenu: (e: Event) => { e.preventDefault(); },
      };
      canvas.addEventListener('mousedown', this.handlers.mousedown, { capture: true });
      canvas.addEventListener('contextmenu', this.handlers.contextmenu);
      window.addEventListener('keydown', this.handlers.keydown);
      window.addEventListener('keyup', this.handlers.keyup);
      window.addEventListener('mousemove', this.handlers.mousemove);
      window.addEventListener('mouseup', this.handlers.mouseup);
      canvas.addEventListener('wheel', this.handlers.wheel, { passive: false });
      window.addEventListener('blur', this.handlers.blur);
    }
  }

  update(ctx: CameraModeContext): void {
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm || !bm.body.radii) return;

    const sf = ctx.scaleFactor;

    // Co-rotate camera position with the body
    const bodyQ = this.getBodyQuat(ctx, bm);
    if (bodyQ && this.hasPrevQuat) {
      ensureQuatContinuity(bodyQ, this.prevQuat);
      const dq = this.prevQuat.clone().invert().premultiply(bodyQ);
      _toBody.copy(ctx.camera.position).sub(bm.position);
      _toBody.applyQuaternion(dq);
      ctx.camera.position.copy(bm.position).add(_toBody);
    }
    if (bodyQ) {
      this.prevQuat.copy(bodyQ);
      this.hasPrevQuat = true;
      this.curBodyQuat.copy(bodyQ);
      this.hasBodyQuat = true;
    }

    // Surface normal at camera position
    _toBody.copy(ctx.camera.position).sub(bm.position);
    const currentDist = _toBody.length();
    if (currentDist < 1e-20) return;
    _surfaceNormal.copy(_toBody).divideScalar(currentDist);

    // Mouse look
    if (this.dragDx !== 0 || this.dragDy !== 0) {
      this.yaw -= this.dragDx * 0.003;
      this.pitch -= this.dragDy * 0.003;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
      this.dragDx = 0;
      this.dragDy = 0;
    }

    // Compute forward direction from body-fixed heading.
    // Transform bodyFixedForward to J2000, then project onto tangent plane.
    // This is stable everywhere including poles because bodyFixedForward is
    // chosen at activation to be non-degenerate, and gets updated after movement.
    _forward.copy(this.bodyFixedForward);
    if (this.hasBodyQuat) {
      _forward.applyQuaternion(this.curBodyQuat);
    }

    // Project onto tangent plane → base heading (before yaw)
    _forward.addScaledVector(_surfaceNormal, -_forward.dot(_surfaceNormal));
    if (_forward.lengthSq() < 1e-10) {
      // At exact pole with north heading — use body-fixed +X as fallback
      _forward.set(1, 0, 0);
      if (this.hasBodyQuat) _forward.applyQuaternion(this.curBodyQuat);
      _forward.addScaledVector(_surfaceNormal, -_forward.dot(_surfaceNormal));
    }
    _forward.normalize();

    // Save pre-yaw forward for heading updates after movement
    const baseForward = _forward.clone();

    // Apply yaw (visual only — not baked into bodyFixedForward)
    if (this.yaw !== 0) {
      const yawQ = new THREE.Quaternion().setFromAxisAngle(_surfaceNormal, this.yaw);
      _forward.applyQuaternion(yawQ).normalize();
    }
    _right.crossVectors(_forward, _surfaceNormal).normalize();

    // Build pitched look direction (for both rendering AND movement)
    const pitchedForward = _forward.clone();
    if (this.pitch !== 0) {
      const pitchQ = new THREE.Quaternion().setFromAxisAngle(_right, this.pitch);
      pitchedForward.applyQuaternion(pitchQ);
    }

    // WASD movement — W/S use pitched direction so pitch controls altitude
    const speedMod = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 5 : 1;
    const moveAmt = this.speedKmPerSec * ctx.dt * speedMod * sf;
    _move.set(0, 0, 0);

    if (this.keys.has('KeyW')) _move.addScaledVector(pitchedForward, moveAmt);
    if (this.keys.has('KeyS')) _move.addScaledVector(pitchedForward, -moveAmt);
    if (this.keys.has('KeyD')) _move.addScaledVector(_right, moveAmt);
    if (this.keys.has('KeyA')) _move.addScaledVector(_right, -moveAmt);

    if (_move.lengthSq() > 0) {
      ctx.camera.position.add(_move);

      // After movement, re-project the BASE heading (pre-yaw) onto the new tangent
      // plane and save to body-fixed. Using baseForward (not _forward) prevents
      // yaw from accumulating into bodyFixedForward each frame.
      _toBody.copy(ctx.camera.position).sub(bm.position);
      const newNormal = _toBody.clone().normalize();
      const newFwd = baseForward.clone();
      newFwd.addScaledVector(newNormal, -newFwd.dot(newNormal));
      if (newFwd.lengthSq() > 1e-10) {
        newFwd.normalize();
        if (this.hasBodyQuat) {
          newFwd.applyQuaternion(this.curBodyQuat.clone().invert());
        }
        this.bodyFixedForward.copy(newFwd);
      }
    }

    // Update altitude from radial distance (pitch-based movement changes it)
    _toBody.copy(ctx.camera.position).sub(bm.position);
    const dist = _toBody.length() / sf;
    this.altitudeKm = Math.max(0.01, dist - bm.body.radii[0]);
    this.speedKmPerSec = this.altitudeKm * 2;

    // Minimum altitude clamp — don't go underground
    const minAlt = 0.01; // 10 meters
    const minDist = (bm.body.radii[0] + minAlt) * sf;
    const actualDist = _toBody.length();
    if (actualDist < minDist && actualDist > 1e-20) {
      _surfaceNormal.copy(_toBody).divideScalar(actualDist);
      ctx.camera.position.copy(bm.position).addScaledVector(_surfaceNormal, minDist);
    }

    // Recompute normal after all position adjustments
    _toBody.copy(ctx.camera.position).sub(bm.position);
    _surfaceNormal.copy(_toBody).normalize();

    // Camera up = surface normal (horizon level)
    ctx.camera.up.copy(_surfaceNormal);

    // Look direction
    _lookTarget.copy(ctx.camera.position).addScaledVector(pitchedForward, 0.001);
    ctx.camera.lookAt(_lookTarget);
  }

  deactivate(ctx: CameraModeContext): void {
    this.bodyName = '';
    this.keys.clear();
    this.dragging = false;

    if (this.handlers) {
      const canvas = ctx.controls.domElement as HTMLElement;
      canvas?.removeEventListener('mousedown', this.handlers.mousedown, { capture: true } as EventListenerOptions);
      canvas?.removeEventListener('contextmenu', this.handlers.contextmenu);
      canvas?.removeEventListener('wheel', this.handlers.wheel);
      window.removeEventListener('keydown', this.handlers.keydown);
      window.removeEventListener('keyup', this.handlers.keyup);
      window.removeEventListener('mousemove', this.handlers.mousemove);
      window.removeEventListener('mouseup', this.handlers.mouseup);
      window.removeEventListener('blur', this.handlers.blur);
      this.handlers = null;
    }
  }

  private getBodyQuat(ctx: CameraModeContext, bm: BodyMesh): THREE.Quaternion | null {
    const r = this.getBodyFixedMatrix(ctx);
    if (r) {
      const m = new THREE.Matrix4();
      m.set(
        r[0], r[1], r[2], 0,
        r[3], r[4], r[5], 0,
        r[6], r[7], r[8], 0,
        0,    0,    0,    1,
      );
      const q = new THREE.Quaternion();
      q.setFromRotationMatrix(m);
      return q;
    }
    if (bm.body.rotation) {
      const q = bm.body.rotation.rotationAt(ctx.et);
      if (q) {
        return new THREE.Quaternion(-q[1], -q[2], -q[3], q[0]);
      }
    }
    return null;
  }

  private getBodyFixedMatrix(ctx: CameraModeContext): number[] | null {
    if (!ctx.spice) return null;
    const frameName = 'IAU_' + this.bodyName.toUpperCase().replace(/\s+/g, '_');
    try {
      return ctx.spice.pxform(frameName, 'ECLIPJ2000', ctx.et);
    } catch {
      return null;
    }
  }
}
