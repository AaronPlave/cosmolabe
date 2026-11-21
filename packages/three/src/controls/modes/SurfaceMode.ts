import * as THREE from 'three';
import { CameraModeName, ensureQuatContinuity, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';
import { attachPointerInput, keyEventInScope, pinchZoomFactor } from '../PointerInput.js';
import type { BodyMesh } from '../../BodyMesh.js';
import { bodyFixedToGeodeticRad, geodeticToBodyFixedKm, type Ellipsoid } from '../surfaceNavigation.js';

const _surfaceNormal = /* @__PURE__ */ new THREE.Vector3();
const _forward = /* @__PURE__ */ new THREE.Vector3();
const _right = /* @__PURE__ */ new THREE.Vector3();
const _move = /* @__PURE__ */ new THREE.Vector3();
const _lookTarget = /* @__PURE__ */ new THREE.Vector3();
const _toBody = /* @__PURE__ */ new THREE.Vector3();
const _bodyWorldQ = /* @__PURE__ */ new THREE.Quaternion();
const _invBodyQ = /* @__PURE__ */ new THREE.Quaternion();

/** Lowest height above the floor (terrain, or the ellipsoid without terrain), km. */
const MIN_CLEARANCE_KM = 0.01;

/**
 * Surface Flight Camera — WASD flight over a body's surface, airplane-style.
 *
 * Controls:
 * - W/S: fly forward/backward in the look direction (pitch changes altitude)
 * - A/D: strafe left/right
 * - Mouse drag / one-finger drag: look around (yaw/pitch, horizon stays level)
 * - Scroll wheel / two-finger pinch: adjust altitude directly
 * - Shift: speed boost
 *
 * Cruise speed starts at twice the entry clearance per second and remains
 * fixed across terrain relief. Wheel/pinch selects a new altitude and speed.
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
  private altitudeFactor = 1;
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
  private dragDx = 0;
  private dragDy = 0;
  private handlers: {
    keydown: (e: KeyboardEvent) => void; keyup: (e: KeyboardEvent) => void;
    wheel: (e: WheelEvent) => void; blur: () => void;
  } | null = null;
  private detachPointerInput: (() => void) | null = null;

  activate(ctx: CameraModeContext, params: CameraModeParams): void {
    this.bodyName = params.bodyName ?? '';
    this.altitudeKm = params.altKm ?? 10;
    this.speedKmPerSec = this.altitudeKm * 2;
    this.altitudeFactor = 1;
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

    // Body-fixed heading at this lat/lon: north turned clockwise (toward east)
    // by `headingDeg`. Yaw then starts at zero, so the heading is the base the
    // mode carries over movement.
    const headingRad = (params.headingDeg ?? 0) * Math.PI / 180;
    const ch = Math.cos(headingRad), sh = Math.sin(headingRad);
    this.bodyFixedForward.set(
      ch * -sinLat * cosLon + sh * -sinLon,
      ch * -sinLat * sinLon + sh * cosLon,
      ch * cosLat,
    ).normalize();
    this.pitch = Math.max(-1.4, Math.min(1.4, (params.pitchDeg ?? 0) * Math.PI / 180));

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
    // Choose cruise speed once from the real entry clearance. Terrain relief
    // and later sampling/LOD changes must not act like throttle input.
    this.clampAboveFloor(ctx, bm);
    this.speedKmPerSec = this.altitudeKm * 2;

    // Set up event listeners
    const canvas = ctx.controls.domElement as HTMLElement;
    if (canvas && !this.handlers) {
      this.handlers = {
        keydown: (e: KeyboardEvent) => {
          if (!keyEventInScope(e, canvas)) return;
          const tag = (e.target as HTMLElement)?.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          this.keys.add(e.code);
        },
        keyup: (e: KeyboardEvent) => { this.keys.delete(e.code); },
        wheel: (e: WheelEvent) => {
          e.preventDefault();
          this.zoomAltitude(e.deltaY > 0 ? 1.15 : 0.87);
        },
        blur: () => { this.keys.clear(); },
      };
      window.addEventListener('keydown', this.handlers.keydown);
      window.addEventListener('keyup', this.handlers.keyup);
      canvas.addEventListener('wheel', this.handlers.wheel, { passive: false });
      window.addEventListener('blur', this.handlers.blur);

      this.detachPointerInput = attachPointerInput(canvas, {
        preventContextMenu: true,
        onButtonDown: (e) => {
          if (e.button === 0 || e.button === 2) this.dragging = true;
        },
        onButtonDrag: (dx, dy) => {
          if (!this.dragging) return;
          this.dragDx += dx;
          this.dragDy += dy;
        },
        onButtonUp: () => { this.dragging = false; },
        // One finger looks around, as a left-drag does.
        onDrag: (dx, dy) => {
          this.dragDx += dx;
          this.dragDy += dy;
        },
        // Two fingers change altitude. There is nothing to pan — WASD moves the
        // camera — so the centroid drag is ignored.
        onPinch: (scale) => { this.zoomAltitude(pinchZoomFactor(scale)); },
        onCancel: () => { this.dragging = false; },
      });
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

    if (this.altitudeFactor !== 1) this.clampAboveFloor(ctx, bm);

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

    // Height above the floor — sampled terrain where the body has it, the
    // reference ellipsoid where it does not — measured geodetically, as the
    // entry pose places the camera. A radial distance against the equatorial
    // radius would read an oblate body's poles as tens of km underground
    // (Earth ≈ 21 km) and throw the camera up on the first frame.
    this.clampAboveFloor(ctx, bm);

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
      canvas?.removeEventListener('wheel', this.handlers.wheel);
      window.removeEventListener('keydown', this.handlers.keydown);
      window.removeEventListener('keyup', this.handlers.keyup);
      window.removeEventListener('blur', this.handlers.blur);
      this.handlers = null;
    }
    this.detachPointerInput?.();
    this.detachPointerInput = null;
  }

  /**
   * Keep the camera at least `MIN_CLEARANCE_KM` above the floor along the
   * geodetic normal. Only an explicit altitude adjustment changes cruise
   * speed; terrain relief or a new terrain sample cannot change the throttle.
   */
  private clampAboveFloor(ctx: CameraModeContext, bm: BodyMesh): void {
    const radii = bm.body.radii;
    if (!radii) return;
    const sf = ctx.scaleFactor;
    const a = radii[0];
    const c = radii[2] ?? a;
    const ell: Ellipsoid = { a, e2: 1 - (c * c) / (a * a) };

    _toBody.copy(ctx.camera.position).sub(bm.position).divideScalar(sf);
    if (this.hasBodyQuat) _toBody.applyQuaternion(_invBodyQ.copy(this.curBodyQuat).invert());
    if (_toBody.lengthSq() < 1e-20) return;
    const g = bodyFixedToGeodeticRad([_toBody.x, _toBody.y, _toBody.z], ell);
    const terrainKm = bm.hasTerrain
      ? bm.sampleTerrainElevation(g.latRad * 180 / Math.PI, g.lonRad * 180 / Math.PI)?.elevationKm ?? 0
      : 0;

    const zooming = this.altitudeFactor !== 1;
    const clearanceKm = Math.max(MIN_CLEARANCE_KM, g.altKm - terrainKm);
    const requestedKm = Math.max(MIN_CLEARANCE_KM, clearanceKm * this.altitudeFactor);
    const floorKm = terrainKm + MIN_CLEARANCE_KM;
    if (zooming || g.altKm < floorKm) {
      const p = geodeticToBodyFixedKm(g.latRad, g.lonRad, zooming ? terrainKm + requestedKm : floorKm, ell);
      _toBody.set(p[0], p[1], p[2]);
      if (this.hasBodyQuat) _toBody.applyQuaternion(this.curBodyQuat);
      ctx.camera.position.copy(bm.position).addScaledVector(_toBody, sf);
    }
    this.altitudeKm = zooming ? requestedKm : clearanceKm;
    if (zooming) this.speedKmPerSec = requestedKm * 2;
    this.altitudeFactor = 1;
  }

  /** Scale altitude (and the speed derived from it) by a zoom factor. */
  private zoomAltitude(factor: number): void {
    this.altitudeFactor *= factor;
  }

  private getBodyQuat(_ctx: CameraModeContext, bm: BodyMesh): THREE.Quaternion | null {
    // Body→world orientation read off the rendered mesh (catalog rotation
    // model + obliquity, or the globe's own pole when there is no rotation
    // model), so surface lat/lon placement and horizon stay locked to the
    // rendered terrain — the frame Surface Explorer and the entry pose use.
    // Callers copy the result, so a shared scratch is safe.
    return bm.bodyToWorldQuaternion(_bodyWorldQ);
  }
}
