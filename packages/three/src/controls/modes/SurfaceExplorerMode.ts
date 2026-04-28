import * as THREE from 'three';
import { CameraModeName, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';
import type { BodyMesh } from '../../BodyMesh.js';

const _tmpV = /* @__PURE__ */ new THREE.Vector3();
const _lookTarget = /* @__PURE__ */ new THREE.Vector3();
const _rotMat = /* @__PURE__ */ new THREE.Matrix4();
const _tmpMat = /* @__PURE__ */ new THREE.Matrix4();
const _tmpQ = /* @__PURE__ */ new THREE.Quaternion();
const _tmpScale = /* @__PURE__ */ new THREE.Vector3();

/** Construct a matrix that rotates around a world-space point by a quaternion. */
function makeRotateAroundPoint(point: THREE.Vector3, quat: THREE.Quaternion, target: THREE.Matrix4): void {
  target.makeTranslation(-point.x, -point.y, -point.z);
  _tmpMat.makeRotationFromQuaternion(quat);
  target.premultiply(_tmpMat);
  _tmpMat.makeTranslation(point.x, point.y, point.z);
  target.premultiply(_tmpMat);
}

/**
 * Surface Explorer Camera — ground-level navigation over planetary terrain.
 *
 * Camera altitude is above the reference ellipsoid (not terrain-following).
 * The renderer's clampCameraAboveSurfaces() handles terrain collision.
 *
 * Controls:
 * - Left-click drag: pan (terrain follows the drag, like grabbing a map)
 * - Right-click drag: raycast to surface pivot, orbit camera around it
 *   (horizontal = yaw around surface normal, vertical = tilt around camera right axis)
 * - WASD: translate along the surface in heading direction
 * - Scroll wheel: dolly zoom along the camera's look direction
 * - Shift: speed boost (5×)
 */
export class SurfaceExplorerMode implements ICameraMode {
  readonly name = CameraModeName.SURFACE_EXPLORER;
  readonly allowsOrbitControls = false;
  readonly allowsKeyboard = false;

  private bodyName = '';

  // --- Authoritative geodetic state (body-fixed) ---
  private latRad = 0;
  private lonRad = 0;
  /** Heading: 0 = north, π/2 = east, π = south (increases clockwise) */
  private heading = 0;
  /** Pitch in radians: 0 = horizon, negative = look down */
  private pitch = -0.3;
  /** Altitude above reference ellipsoid in km */
  private altKm = 0.05;
  /** Visual altitude above terrain in km (for speed scaling only, not positioning) */
  private altAboveTerrainKm = 0.01;
  /** Last sampled terrain elevation in km (relative to reference sphere). Used by scroll
   *  handler for a fresh altitude estimate so speed tracks altKm changes each scroll. */
  private lastTerrainElev = 0;

  // --- Body geometry cache ---
  private re = 1;
  private e2 = 0;

  // --- Timing ---
  private frameCount = 0;
  /** Reposition camera periodically even without input (handles body rotation). */
  private static readonly IDLE_UPDATE_INTERVAL = 30;
  private dirty = true;
  private prevEt = 0;
  /** Suppresses geodetic reposition after orbit until user does another input */
  private suppressGeodetic = false;
  /** Previous body quaternion for co-rotation during orbit */
  private readonly prevBodyQuat = new THREE.Quaternion();

  // --- Input ---
  private readonly keys = new Set<string>();
  private leftDragging = false;
  private rightDragging = false;
  private prevMouseX = 0;
  private prevMouseY = 0;
  private dragDx = 0;
  private dragDy = 0;

  // --- Right-click orbit pivot ---
  private hasPivot = false;
  /** Pivot in body-fixed geometry Y-up coordinates (km). No geodetic conversion needed. */
  private readonly pivotBodyFixed = new THREE.Vector3();

  // --- Pivot dot visual ---
  private pivotDot: THREE.Mesh | null = null;
  private pivotDotParent: THREE.Object3D | null = null;

  // --- Event handlers ---
  private handlers: {
    keydown: (e: KeyboardEvent) => void; keyup: (e: KeyboardEvent) => void;
    mousedown: (e: MouseEvent) => void; mousemove: (e: MouseEvent) => void;
    mouseup: (e: MouseEvent) => void; wheel: (e: WheelEvent) => void;
    blur: () => void; contextmenu: (e: Event) => void;
  } | null = null;

  activate(ctx: CameraModeContext, params: CameraModeParams): void {
    this.bodyName = params.bodyName ?? '';
    this.altKm = params.altKm ?? 0.05;
    this.heading = 0;
    this.pitch = -0.3;
    this.keys.clear();
    this.dragDx = 0;
    this.dragDy = 0;
    this.leftDragging = false;
    this.rightDragging = false;
    this.hasPivot = false;
    this.frameCount = 0;
    this.dirty = true;
    this.prevEt = ctx.et;

    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm || !bm.body.radii) return;

    this.re = bm.body.radii[0];
    const rp = bm.body.radii[2];
    this.e2 = 1 - (rp * rp) / (this.re * this.re);

    // Derive initial lat/lon from current camera position instead of defaulting to (0,0).
    // This way switching to Surface Explorer keeps you where you were.
    if (params.latDeg === 0 && params.lonDeg === 0) {
      const bodyQ = this.getBodyQuat(ctx, bm);
      const km = ctx.camera.position.clone().sub(bm.position).divideScalar(ctx.scaleFactor);
      if (bodyQ) km.applyQuaternion(bodyQ.clone().invert());
      const ecefX = km.x, ecefY = -km.z, ecefZ = km.y;
      const r = Math.sqrt(ecefX * ecefX + ecefY * ecefY + ecefZ * ecefZ);
      if (r > 1e-10) {
        const geocLat = Math.asin(Math.max(-1, Math.min(1, ecefZ / r)));
        this.latRad = Math.atan(Math.tan(geocLat) / (1 - this.e2));
        this.lonRad = Math.atan2(ecefY, ecefX);
        // Derive altitude from camera distance
        const sinLat = Math.sin(this.latRad);
        const cosLat = Math.cos(this.latRad);
        const N = this.re / Math.sqrt(1 - this.e2 * sinLat * sinLat);
        // Allow negative altKm for below-ellipsoid terrain (e.g., Gale Crater).
        // Floor at -20 km matches the wheel scroll handler's clamp.
        this.altKm = Math.max(-20, (cosLat > 0.01)
          ? Math.sqrt(ecefX * ecefX + ecefY * ecefY) / cosLat - N
          : Math.abs(ecefZ) / Math.abs(sinLat) - N * (1 - this.e2));
      }
    } else {
      this.latRad = (params.latDeg ?? 0) * Math.PI / 180;
      this.lonRad = (params.lonDeg ?? 0) * Math.PI / 180;

      // Adjust altitude for terrain elevation at this position.
      // altKm is relative to the reference sphere, so terrain below the sphere
      // (e.g., Dingo Gap on Mars ~-4.5 km) requires a negative altKm to sit near the surface.
      const sample = bm.sampleTerrainElevation(
        this.latRad * 180 / Math.PI, this.lonRad * 180 / Math.PI,
      );
      if (sample && sample.angularDistDeg < 1.0) {
        const clearance = this.altKm;
        this.altKm = sample.elevationKm + clearance;
      }
    }

    this.applyCameraFromGeodetic(ctx, bm);

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
          if (e.button === 0) {
            this.leftDragging = true;
          } else if (e.button === 2) {
            this.rightDragging = true;
            this.initOrbitPivot(e.clientX, e.clientY, ctx);
          }
          this.prevMouseX = e.clientX;
          this.prevMouseY = e.clientY;
          this.dragDx = 0;
          this.dragDy = 0;
        },
        mousemove: (e: MouseEvent) => {
          if (!this.leftDragging && !this.rightDragging) return;
          this.dragDx += e.clientX - this.prevMouseX;
          this.dragDy += e.clientY - this.prevMouseY;
          this.prevMouseX = e.clientX;
          this.prevMouseY = e.clientY;
        },
        mouseup: (e: MouseEvent) => {
          if (e.button === 0) this.leftDragging = false;
          if (e.button === 2) {
            this.rightDragging = false;
            this.hasPivot = false;
            this.hidePivotDot();
          }
        },
        wheel: (e: WheelEvent) => {
          e.preventDefault();
          this.suppressGeodetic = false;
          // Dolly zoom along the camera's look direction (heading + pitch).
          // Log-normalize deltaY for consistent feel across platforms/trackpads.
          // deltaY > 0 = scroll down on Mac natural scroll = zoom OUT.
          const normalizedDelta = Math.log2(Math.abs(e.deltaY) + 1);
          // Fresh altitude estimate from altKm (updated every scroll) and the last
          // terrain sample, instead of the 10-frame-stale altAboveTerrainKm.
          const alt = Math.max(0.001, this.altKm - this.lastTerrainElev);
          const scrollCoeff = alt > 1.0 ? 0.06 : 0.03;
          // Linear speed — no quadratic brake. The renderer's surface clamp prevents
          // going through terrain, so the brake is unnecessary and makes the last
          // 100m approach to surface painfully slow.
          const rawSpeed = alt * scrollCoeff * normalizedDelta;
          // Floor ensures camera can always scroll out even if trapped below terrain
          const speed = Math.max(0.003 * normalizedDelta, rawSpeed);
          const sign = e.deltaY > 0 ? -1 : 1;
          const cosPitch = Math.cos(this.pitch);
          const sinPitch = Math.sin(this.pitch);

          // Horizontal: forward/back along heading
          const angStep = (sign * speed * cosPitch) / this.re;
          const cosH = Math.cos(this.heading);
          const sinH = Math.sin(this.heading);
          const cosLat = Math.cos(this.latRad);
          const safeCos = cosLat > 0.01 ? 1 / cosLat : 100;
          this.latRad += cosH * angStep;
          this.lonRad += sinH * angStep * safeCos;

          // Vertical: along pitch direction
          this.altKm = Math.max(-20, Math.min(10000, this.altKm + sign * speed * sinPitch));
          this.dirty = true;
        },
        blur: () => {
          this.keys.clear();
          this.leftDragging = false;
          this.rightDragging = false;
          this.hasPivot = false;
          this.hidePivotDot();
        },
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

    this.frameCount++;

    // Time changed → body rotated → must reposition
    if (Math.abs(ctx.et - this.prevEt) > 1e-6) {
      this.dirty = true;
      this.prevEt = ctx.et;
    }

    // --- Sample terrain for speed scaling (every 10 frames, doesn't affect positioning) ---
    if (this.frameCount % 10 === 0) {
      const latDeg = this.latRad * 180 / Math.PI;
      const lonDeg = this.lonRad * 180 / Math.PI;
      const sample = bm.sampleTerrainElevation(latDeg, lonDeg);
      // Use actual camera distance to body center (avoids ellipsoid-vs-sphere mismatch)
      const distToCenter = ctx.camera.position.distanceTo(bm.position) / ctx.scaleFactor;
      const altAboveSphere = distToCenter - this.re;
      if (sample && sample.angularDistDeg < 1.0) {
        this.altAboveTerrainKm = Math.max(0.0001, altAboveSphere - sample.elevationKm);
        this.lastTerrainElev = sample.elevationKm;
      } else {
        // No terrain sample. When altAboveSphere is zero or negative (camera is at or below
        // the reference sphere, as at Dingo Gap), clamp to a moderate fallback so scroll speed
        // stays usable. Without this, speed → 0 at the sphere surface and the camera locks.
        this.altAboveTerrainKm = altAboveSphere > 0
          ? Math.max(0.0001, altAboveSphere)
          : 0.1;
      }
    }

    // --- Left-drag: pan (clears orbit suppression so geodetic takes over again) ---
    if (this.leftDragging && (this.dragDx !== 0 || this.dragDy !== 0)) {
      this.suppressGeodetic = false;
      // Speed based on distance to terrain. Min floor ensures movement even on the ground.
      const angPerPx = (Math.max(this.altAboveTerrainKm, 0.005) / this.re) * 0.003;
      const cosLat = Math.cos(this.latRad);
      const safeCos = cosLat > 0.01 ? 1 / cosLat : 100;
      const cosH = Math.cos(this.heading);
      const sinH = Math.sin(this.heading);

      this.latRad += (this.dragDy * cosH + this.dragDx * sinH) * angPerPx;
      this.lonRad += (this.dragDy * sinH - this.dragDx * cosH) * angPerPx * safeCos;
      this.latRad = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.latRad));

      this.dragDx = 0;
      this.dragDy = 0;
      this.dirty = true;
    }

    // --- Right-drag: orbit around pivot ---
    const isOrbiting = this.rightDragging && this.hasPivot;
    if (isOrbiting) this.suppressGeodetic = true;
    // Suppress geodetic reposition during orbit AND after release until user does other input
    const orbitApplied = this.suppressGeodetic;

    // Co-rotate camera with body during orbit (so we don't zoom around when time plays)
    if (isOrbiting || this.suppressGeodetic) {
      const bodyQ = this.getBodyQuat(ctx, bm);
      if (bodyQ) {
        const dq = this.prevBodyQuat.clone().invert().premultiply(bodyQ);
        // Rotate camera position around body center
        const offset = ctx.camera.position.clone().sub(bm.position);
        offset.applyQuaternion(dq);
        ctx.camera.position.copy(bm.position).add(offset);
        // Rotate camera orientation too
        ctx.camera.quaternion.premultiply(dq);
        ctx.camera.up.applyQuaternion(dq).normalize();
        this.prevBodyQuat.copy(bodyQ);
      }
      // Keep latRad/lonRad/altKm/heading/pitch in sync with where the orbit-driven
      // camera actually is. Without this, when a subsequent WASD/wheel/translate
      // clears suppressGeodetic, applyCameraFromGeodetic uses pre-orbit state and
      // snaps the camera back to the wrong altitude/look angle.
      this.updateGeodeticFromCamera(ctx, bm);
    }
    if (this.rightDragging && (this.dragDx !== 0 || this.dragDy !== 0)) {
      if (this.hasPivot) {
        this.applyWorldSpaceOrbit(this.dragDx, this.dragDy, ctx, bm);
      } else {
        // No pivot (clicked sky) → free look
        this.heading += this.dragDx * 0.003;
        this.pitch -= this.dragDy * 0.003;
        this.pitch = Math.max(-1.5, Math.min(0.3, this.pitch));
        this.dirty = true;
      }
      this.dragDx = 0;
      this.dragDy = 0;
    }

    // --- WASD ---
    if (this.keys.size > 0) {
      const speedMod = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 5 : 1;
      const angSpeed = (Math.max(this.altAboveTerrainKm, 0.005) / this.re) * 3.0 * speedMod;
      const cosLat = Math.cos(this.latRad);
      const safeCos = cosLat > 0.01 ? 1 / cosLat : 100;
      const cosH = Math.cos(this.heading);
      const sinH = Math.sin(this.heading);

      let fwd = 0, rgt = 0;
      if (this.keys.has('KeyW')) fwd += 1;
      if (this.keys.has('KeyS')) fwd -= 1;
      if (this.keys.has('KeyD')) rgt += 1;
      if (this.keys.has('KeyA')) rgt -= 1;

      if (fwd !== 0 || rgt !== 0) {
        this.suppressGeodetic = false;
        this.latRad += (fwd * cosH - rgt * sinH) * angSpeed * ctx.dt;
        this.lonRad += (fwd * sinH + rgt * cosH) * angSpeed * ctx.dt * safeCos;
        this.latRad = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.latRad));
        this.dirty = true;
      }
    }

    // --- Apply camera from geodetic (skip when orbit set it directly) ---
    if (!orbitApplied && (this.dirty || this.frameCount % SurfaceExplorerMode.IDLE_UPDATE_INTERVAL === 0)) {
      this.applyCameraFromGeodetic(ctx, bm);
      this.dirty = false;
    }

    if (this.hasPivot) {
      this.updatePivotDotPosition(ctx, bm);
    }
  }

  deactivate(ctx: CameraModeContext): void {
    this.bodyName = '';
    this.keys.clear();
    this.leftDragging = false;
    this.rightDragging = false;
    this.hasPivot = false;
    this.hidePivotDot();
    this.disposePivotDot();

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

  // ─── Camera positioning ──────────────────────────────────────────────

  /** Compute camera world position + orientation from geodetic state. */
  private applyCameraFromGeodetic(ctx: CameraModeContext, bm: BodyMesh): void {
    const sf = ctx.scaleFactor;
    const sinLat = Math.sin(this.latRad);
    const cosLat = Math.cos(this.latRad);
    const cosLon = Math.cos(this.lonRad);
    const sinLon = Math.sin(this.lonRad);
    const N = this.re / Math.sqrt(1 - this.e2 * sinLat * sinLat);

    const ecefX = (N + this.altKm) * cosLat * cosLon;
    const ecefY = (N + this.altKm) * cosLat * sinLon;
    const ecefZ = (N * (1 - this.e2) + this.altKm) * sinLat;
    _tmpV.set(ecefX, ecefZ, -ecefY);

    const bodyQ = this.getBodyQuat(ctx, bm);
    if (bodyQ) _tmpV.applyQuaternion(bodyQ);
    ctx.camera.position.copy(bm.position).addScaledVector(_tmpV, sf);

    // Orientation
    const normalW = new THREE.Vector3().copy(ctx.camera.position).sub(bm.position).normalize();

    const northGeo = new THREE.Vector3(-sinLat * cosLon, cosLat, sinLat * sinLon);
    if (bodyQ) northGeo.applyQuaternion(bodyQ);
    northGeo.addScaledVector(normalW, -northGeo.dot(normalW));
    if (northGeo.lengthSq() < 1e-10) {
      northGeo.set(1, 0, 0);
      if (bodyQ) northGeo.applyQuaternion(bodyQ);
      northGeo.addScaledVector(normalW, -northGeo.dot(normalW));
    }
    northGeo.normalize();

    const headingQ = new THREE.Quaternion().setFromAxisAngle(normalW, -this.heading);
    const forward = northGeo.clone().applyQuaternion(headingQ);
    const right = new THREE.Vector3().crossVectors(forward, normalW).normalize();

    const pitchQ = new THREE.Quaternion().setFromAxisAngle(right, this.pitch);
    const lookDir = forward.clone().applyQuaternion(pitchQ);

    ctx.camera.up.copy(normalW);
    _lookTarget.copy(ctx.camera.position).addScaledVector(lookDir, 0.001);
    ctx.camera.lookAt(_lookTarget);
  }

  // ─── Right-click orbit ───────────────────────────────────────────────

  /** Raycast to find orbit pivot using the renderer's pickSurface. */
  private initOrbitPivot(clientX: number, clientY: number, ctx: CameraModeContext): void {
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm || !ctx.pickSurface) { this.hasPivot = false; return; }

    const canvas = ctx.controls.domElement as HTMLElement;
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const hit = ctx.pickSurface(ndcX, ndcY);

    // Debug: enable with window.__surfExDebug = true
    if (typeof window !== 'undefined' && (window as any).__surfExDebug) {
      const sf = ctx.scaleFactor;
      const camDist = ctx.camera.position.distanceTo(bm.position) / sf;
      console.log(`[SurfEx] pick ndc=(${ndcX.toFixed(3)},${ndcY.toFixed(3)}) hit=${hit ? `body=${hit.bodyName} lat=${hit.latDeg.toFixed(4)} lon=${hit.lonDeg.toFixed(4)} alt=${hit.altKm.toFixed(4)}` : 'null'} camAlt=${this.altKm.toFixed(4)} camDistBody=${camDist.toFixed(2)} altAboveTerrain=${this.altAboveTerrainKm.toFixed(4)}`);
    }

    if (!hit) { this.hasPivot = false; return; }

    // Store pivot as body-fixed ECEF (geometry Y-up) in km.
    // pickSurface returns geocentric lat/lon/alt (spherical). Convert directly
    // to Cartesian — no geodetic formulas, no ellipsoid-vs-sphere mismatch.
    const latRad = hit.latDeg * Math.PI / 180;
    const lonRad = hit.lonDeg * Math.PI / 180;
    const r = this.re + hit.altKm; // spherical radius at hit point
    const cosLat = Math.cos(latRad);
    const ecefX = r * cosLat * Math.cos(lonRad);
    const ecefY = r * cosLat * Math.sin(lonRad);
    const ecefZ = r * Math.sin(latRad);
    // ECEF Z-up → geometry Y-up
    this.pivotBodyFixed.set(ecefX, ecefZ, -ecefY);
    this.hasPivot = true;

    // Initialize body quaternion tracking for co-rotation during orbit
    const bodyQ = this.getBodyQuat(ctx, bm);
    if (bodyQ) this.prevBodyQuat.copy(bodyQ);

    this.showPivotDot(ctx, bm);
  }

  /**
   * World-space orbit around the pivot point (EnvironmentControls-style).
   * Rotates camera.matrixWorld directly — no geodetic round-trip during orbit.
   */
  private applyWorldSpaceOrbit(dx: number, dy: number, ctx: CameraModeContext, bm: BodyMesh): void {
    const sf = ctx.scaleFactor;
    const bodyQ = this.getBodyQuat(ctx, bm);

    const pivotWorld = this.pivotToWorld(sf, bm.position, bodyQ);

    ctx.camera.updateMatrixWorld(true);

    const pivotUp = pivotWorld.clone().sub(bm.position).normalize();
    const domHeight = (ctx.controls.domElement as HTMLElement).clientHeight;

    // Horizontal: yaw around surface normal at pivot
    if (dx !== 0) {
      _tmpQ.setFromAxisAngle(pivotUp, -dx * 2 * Math.PI / domHeight);
      makeRotateAroundPoint(pivotWorld, _tmpQ, _rotMat);
      ctx.camera.matrixWorld.premultiply(_rotMat);
    }

    // Vertical: tilt around camera's right axis at pivot
    if (dy !== 0) {
      const right = new THREE.Vector3(1, 0, 0).transformDirection(ctx.camera.matrixWorld);

      // Clamp: don't let camera go below the surface
      const offset = ctx.camera.position.clone().sub(pivotWorld);
      _tmpQ.setFromAxisAngle(right, -dy * 2 * Math.PI / domHeight);
      const testOffset = offset.clone().applyQuaternion(_tmpQ);
      if (testOffset.clone().add(pivotWorld).sub(bm.position).dot(pivotUp) > 0) {
        makeRotateAroundPoint(pivotWorld, _tmpQ, _rotMat);
        ctx.camera.matrixWorld.premultiply(_rotMat);
      }
    }

    ctx.camera.matrixWorld.decompose(ctx.camera.position, ctx.camera.quaternion, _tmpScale);

    // Update geodetic state for when orbit ends
    this.updateGeodeticFromCamera(ctx, bm);
  }

  /** Public entry: re-derive internal state from current camera. Called by
   *  CameraController after flyTo/viewpoint apply so the next update() doesn't
   *  snap the camera back to stale stored geodetic state. */
  syncFromCamera(ctx: CameraModeContext): void {
    if (!this.bodyName) return;
    const bm = ctx.bodyMeshes.get(this.bodyName);
    if (!bm || !bm.body.radii) return;
    this.updateGeodeticFromCamera(ctx, bm);
    this.suppressGeodetic = false;
    this.dirty = false;
  }

  /** Derive geodetic state from current camera world position + orientation. */
  private updateGeodeticFromCamera(ctx: CameraModeContext, bm: BodyMesh): void {
    const sf = ctx.scaleFactor;
    const bodyQ = this.getBodyQuat(ctx, bm);

    const km = ctx.camera.position.clone().sub(bm.position).divideScalar(sf);
    if (bodyQ) km.applyQuaternion(bodyQ.clone().invert());

    const ecefX = km.x;
    const ecefY = -km.z;
    const ecefZ = km.y;
    const r = Math.sqrt(ecefX * ecefX + ecefY * ecefY + ecefZ * ecefZ);
    if (r < 1e-10) return;

    // Bowring's closed-form geocentric→geodetic conversion: exact at any altitude.
    // The naïve formula `atan(tan(geocLat) / (1 - e²))` is only valid on the ellipsoid
    // surface; off-surface it produces small lateral position drift on round-trip.
    const a = this.re;
    const b = a * Math.sqrt(1 - this.e2);
    const ePrime2 = this.e2 / (1 - this.e2);
    const p = Math.sqrt(ecefX * ecefX + ecefY * ecefY);
    const u = Math.atan2(ecefZ * a, p * b);
    const sinU = Math.sin(u);
    const cosU = Math.cos(u);
    this.latRad = Math.atan2(
      ecefZ + ePrime2 * b * sinU * sinU * sinU,
      p - this.e2 * a * cosU * cosU * cosU,
    );
    this.lonRad = Math.atan2(ecefY, ecefX);
    this.latRad = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.latRad));

    // Ellipsoidal altitude (consistent with applyCameraFromGeodetic).
    // Allow negative altKm: surface terrain on Mars (e.g., Gale Crater at ~-5 km)
    // sits below the IAU reference ellipsoid. Floor at -20 km to bracket the deepest
    // Mars basins (Hellas ~-8 km) with margin; matches wheel scroll handler's clamp.
    const sinLat = Math.sin(this.latRad);
    const cosLat = Math.cos(this.latRad);
    const N = a / Math.sqrt(1 - this.e2 * sinLat * sinLat);
    this.altKm = Math.max(-20, (cosLat > 0.01)
      ? p / cosLat - N
      : Math.abs(ecefZ) / Math.abs(sinLat) - N * (1 - this.e2));

    // Derive heading/pitch from look direction
    const normalW = ctx.camera.position.clone().sub(bm.position).normalize();
    const lookDir = new THREE.Vector3(0, 0, -1).transformDirection(ctx.camera.matrixWorld);

    const northGeo = new THREE.Vector3(-sinLat * Math.cos(this.lonRad), cosLat, sinLat * Math.sin(this.lonRad));
    if (bodyQ) northGeo.applyQuaternion(bodyQ);
    northGeo.addScaledVector(normalW, -northGeo.dot(normalW));
    if (northGeo.lengthSq() < 1e-10) {
      northGeo.set(1, 0, 0);
      if (bodyQ) northGeo.applyQuaternion(bodyQ);
      northGeo.addScaledVector(normalW, -northGeo.dot(normalW));
    }
    northGeo.normalize();

    const eastW = new THREE.Vector3().crossVectors(northGeo, normalW).normalize();
    const lookHoriz = lookDir.clone().addScaledVector(normalW, -lookDir.dot(normalW));
    const horizLen = lookHoriz.length();
    if (horizLen > 1e-10) {
      lookHoriz.normalize();
      this.heading = Math.atan2(lookHoriz.dot(eastW), lookHoriz.dot(northGeo));
    }
    this.pitch = Math.atan2(lookDir.dot(normalW), horizLen);
    this.pitch = Math.max(-1.5, Math.min(0.3, this.pitch));
  }

  // ─── Coordinate conversions ──────────────────────────────────────────

  /** Convert body-fixed pivot position to world space. No geodetic conversion = no mismatch. */
  private pivotToWorld(sf: number, bodyPos: THREE.Vector3, bodyQ: THREE.Quaternion | null): THREE.Vector3 {
    const v = this.pivotBodyFixed.clone();
    if (bodyQ) v.applyQuaternion(bodyQ);
    return v.multiplyScalar(sf).add(bodyPos);
  }

  private geodeticToWorld(
    latRad: number, lonRad: number, altKm: number,
    sf: number, bodyPos: THREE.Vector3, bodyQ: THREE.Quaternion | null,
  ): THREE.Vector3 {
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const cosLon = Math.cos(lonRad);
    const sinLon = Math.sin(lonRad);
    const N = this.re / Math.sqrt(1 - this.e2 * sinLat * sinLat);
    const v = new THREE.Vector3(
      (N + altKm) * cosLat * cosLon,
      (N * (1 - this.e2) + altKm) * sinLat,
      -(N + altKm) * cosLat * sinLon,
    );
    if (bodyQ) v.applyQuaternion(bodyQ);
    return v.multiplyScalar(sf).add(bodyPos);
  }

  // ─── Pivot dot ───────────────────────────────────────────────────────

  private showPivotDot(ctx: CameraModeContext, bm: BodyMesh): void {
    if (!this.pivotDot) {
      // Flat ring billboard — no perspective distortion at screen edges
      const geo = new THREE.RingGeometry(0.75, 1.0, 32);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, depthTest: false, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide,
      });
      this.pivotDot = new THREE.Mesh(geo, mat);
      this.pivotDot.renderOrder = 999;
    }
    // Add to marker scene (renders last, after CRR depth clear) so dot is
    // always visible on top of both global terrain and surface tile overlays.
    const targetParent = ctx.markerScene ?? bm;
    if (this.pivotDotParent !== targetParent) {
      if (this.pivotDotParent) this.pivotDotParent.remove(this.pivotDot);
      targetParent.add(this.pivotDot);
      this.pivotDotParent = targetParent;
    }
    this.pivotDot.visible = true;
    this.updatePivotDotPosition(ctx, bm);
  }

  private updatePivotDotPosition(ctx: CameraModeContext, bm: BodyMesh): void {
    if (!this.pivotDot || !this.hasPivot) return;
    const sf = ctx.scaleFactor;
    const bodyQ = this.getBodyQuat(ctx, bm);
    const pivotWorld = this.pivotToWorld(sf, bm.position, bodyQ);
    // In marker scene: position is in world space (not body-local)
    if (ctx.markerScene && this.pivotDotParent === ctx.markerScene) {
      this.pivotDot.position.copy(pivotWorld);
    } else {
      this.pivotDot.position.copy(pivotWorld).sub(bm.position);
    }
    this.pivotDot.quaternion.copy(ctx.camera.quaternion);
    const camDist = ctx.camera.position.distanceTo(pivotWorld);
    this.pivotDot.scale.setScalar(Math.max(camDist * 0.005, sf * 0.0001));
  }

  private hidePivotDot(): void {
    if (this.pivotDot) this.pivotDot.visible = false;
  }

  private disposePivotDot(): void {
    if (this.pivotDot) {
      if (this.pivotDotParent) {
        this.pivotDotParent.remove(this.pivotDot);
        this.pivotDotParent = null;
      }
      this.pivotDot.geometry.dispose();
      (this.pivotDot.material as THREE.Material).dispose();
      this.pivotDot = null;
    }
  }

  // ─── Body quaternion ─────────────────────────────────────────────────

  /**
   * Uses bm.mesh.quaternion directly — the authoritative rotation set by the
   * renderer, including mesh pre-rotation and frame conversions.
   */
  private getBodyQuat(_ctx: CameraModeContext, bm: BodyMesh): THREE.Quaternion | null {
    return bm.mesh.quaternion;
  }
}
