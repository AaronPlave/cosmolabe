import * as THREE from 'three';
import { CameraModeName, type ICameraMode, type CameraModeContext, type CameraModeParams } from '../CameraModes.js';
import { attachPointerInput, pinchZoomFactor } from '../PointerInput.js';
import type { BodyMesh } from '../../BodyMesh.js';
import {
  bodyFixedToGeodeticRad, clipRayToFloor, dollyAlongView, headingPitchOf, localFrame, moveAlongSurface, viewDirection,
  type Ellipsoid, type FloorFn, type SurfacePose, type Vec3,
} from '../surfaceNavigation.js';

const _tmpV = /* @__PURE__ */ new THREE.Vector3();
const _lookTarget = /* @__PURE__ */ new THREE.Vector3();
const _rotMat = /* @__PURE__ */ new THREE.Matrix4();
const _tmpMat = /* @__PURE__ */ new THREE.Matrix4();
const _tmpQ = /* @__PURE__ */ new THREE.Quaternion();
const _tmpScale = /* @__PURE__ */ new THREE.Vector3();

/** Minimum camera height above sampled terrain enforced by wheel/pinch dolly, km. */
const DOLLY_TERRAIN_CLEARANCE_KM = 0.002;

/** Conventional Z-up body-fixed vector → body geometry Y-up (x, z, -y). */
function bodyFixedToGeometry(v: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v[0], v[2], -v[1]);
}

/** Body geometry Y-up → conventional Z-up body-fixed. */
function geometryToBodyFixed(v: THREE.Vector3): Vec3 {
  return [v.x, -v.z, v.y];
}

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
 * The renderer's clampCameraAboveSurfaces() handles terrain collision; wheel
 * and pinch dolly (including while orbiting) additionally stop at a small
 * clearance above sampled terrain.
 *
 * All motion is a displacement in the local East/North/Up frame (or along the
 * view ray) in body-fixed space, converted back to geodetic coordinates — see
 * `surfaceNavigation.ts`. "Up" is the geodetic ellipsoid normal. Nothing
 * divides by cos(latitude), so navigation is continuous at and over the poles.
 *
 * Controls:
 * - Left-click drag: pan (terrain follows the drag, like grabbing a map)
 * - Right-click drag: raycast to surface pivot, orbit camera around it
 *   (horizontal = yaw around surface normal, vertical = tilt around camera right axis)
 * - WASD: translate along the surface in heading direction
 * - Scroll wheel / two-finger pinch: dolly zoom along the camera's look direction
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

  private get ellipsoid(): Ellipsoid {
    return { a: this.re, e2: this.e2 };
  }

  /** Geodetic state as one value for the pure navigation helpers. Setting it marks the camera dirty. */
  private get pose(): SurfacePose {
    return { latRad: this.latRad, lonRad: this.lonRad, altKm: this.altKm, headingRad: this.heading, pitchRad: this.pitch };
  }

  private set pose(p: SurfacePose) {
    this.latRad = p.latRad;
    this.lonRad = p.lonRad;
    this.altKm = p.altKm;
    this.heading = p.headingRad;
    this.pitch = p.pitchRad;
    this.dirty = true;
  }

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
    wheel: (e: WheelEvent) => void; blur: () => void;
  } | null = null;
  private detachPointerInput: (() => void) | null = null;

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
      if (km.lengthSq() > 1e-20) {
        const g = bodyFixedToGeodeticRad(geometryToBodyFixed(km), this.ellipsoid);
        this.latRad = g.latRad;
        this.lonRad = g.lonRad;
        // Allow negative altKm for below-ellipsoid terrain (e.g., Gale Crater).
        // Floor at -20 km matches the dolly clamp.
        this.altKm = Math.max(-20, g.altKm);
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
      if (sample) {
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
        wheel: (e: WheelEvent) => {
          e.preventDefault();
          this.dolly(this.wheelStepKm(e.deltaY), ctx);
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
          if (e.button === 0) {
            this.leftDragging = true;
          } else if (e.button === 2) {
            this.rightDragging = true;
            this.initOrbitPivot(e.clientX, e.clientY, ctx);
          }
          this.dragDx = 0;
          this.dragDy = 0;
        },
        onButtonDrag: (dx, dy) => {
          if (!this.leftDragging && !this.rightDragging) return;
          this.dragDx += dx;
          this.dragDy += dy;
        },
        onButtonUp: (e) => {
          if (e.button === 0) this.leftDragging = false;
          if (e.button === 2) this.endOrbit();
        },
        // One finger looks around (left-drag), two orbit the pivot (right-drag)
        // while the pinch between them dollies.
        onCountChange: (count, x, y) => {
          this.dragDx = 0;
          this.dragDy = 0;
          this.leftDragging = count === 1;
          if (count >= 2) {
            if (!this.rightDragging) {
              this.rightDragging = true;
              this.initOrbitPivot(x, y, ctx);
            }
          } else if (this.rightDragging) {
            this.endOrbit();
          }
        },
        onDrag: (dx, dy) => {
          this.dragDx += dx;
          this.dragDy += dy;
        },
        onPinch: (scale, dx, dy) => {
          this.dragDx += dx;
          this.dragDy += dy;
          this.dolly(this.pinchStepKm(scale), ctx);
        },
        onCancel: () => {
          this.leftDragging = false;
          this.endOrbit();
        },
      });
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
      if (sample) {
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
      // Dragging down pulls the terrain toward you (move forward); dragging right
      // pulls it right (move left), like grabbing a map.
      const kmPerPx = Math.max(this.altAboveTerrainKm, 0.005) * 0.003;
      this.pose = moveAlongSurface(this.pose, this.dragDy * kmPerPx, -this.dragDx * kmPerPx, this.ellipsoid);

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
      const kmPerSec = Math.max(this.altAboveTerrainKm, 0.005) * 3.0 * speedMod;

      let fwd = 0, rgt = 0;
      if (this.keys.has('KeyW')) fwd += 1;
      if (this.keys.has('KeyS')) fwd -= 1;
      if (this.keys.has('KeyD')) rgt += 1;
      if (this.keys.has('KeyA')) rgt -= 1;

      if (fwd !== 0 || rgt !== 0) {
        this.suppressGeodetic = false;
        const step = kmPerSec * ctx.dt;
        this.pose = moveAlongSurface(this.pose, fwd * step, rgt * step, this.ellipsoid);
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
      canvas?.removeEventListener('wheel', this.handlers.wheel);
      window.removeEventListener('keydown', this.handlers.keydown);
      window.removeEventListener('keyup', this.handlers.keyup);
      window.removeEventListener('blur', this.handlers.blur);
      this.handlers = null;
    }
    this.detachPointerInput?.();
    this.detachPointerInput = null;
  }

  // ─── Camera positioning ──────────────────────────────────────────────

  /** Compute camera world position + orientation from geodetic state. */
  private applyCameraFromGeodetic(ctx: CameraModeContext, bm: BodyMesh): void {
    const sf = ctx.scaleFactor;
    const bodyQ = this.getBodyQuat(ctx, bm);
    const toWorldDir = (v: Vec3) => {
      const w = bodyFixedToGeometry(v, new THREE.Vector3());
      if (bodyQ) w.applyQuaternion(bodyQ);
      return w;
    };

    const { a, e2 } = this.ellipsoid;
    const sinLat = Math.sin(this.latRad);
    const cosLat = Math.cos(this.latRad);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const posBf: Vec3 = [
      (N + this.altKm) * cosLat * Math.cos(this.lonRad),
      (N + this.altKm) * cosLat * Math.sin(this.lonRad),
      (N * (1 - e2) + this.altKm) * sinLat,
    ];
    ctx.camera.position.copy(bm.position).addScaledVector(toWorldDir(posBf), sf);

    // Orientation from the geodetic (ellipsoid-normal) local frame.
    const frame = localFrame(this.latRad, this.lonRad);
    const upW = toWorldDir(frame.up).normalize();
    const lookW = toWorldDir(viewDirection(frame, this.heading, this.pitch)).normalize();

    ctx.camera.up.copy(upW);
    _lookTarget.copy(ctx.camera.position).addScaledVector(lookW, 0.001);
    ctx.camera.lookAt(_lookTarget);
  }

  // ─── Right-click orbit ───────────────────────────────────────────────

  /** Raycast to find orbit pivot using the renderer's pickSurface. */
  /** End an orbit gesture — the right button released, or the fingers lifted. */
  private endOrbit(): void {
    this.rightDragging = false;
    this.hasPivot = false;
    this.hidePivotDot();
  }

  /** Height above the terrain the camera last sampled, for zoom speed. */
  private get zoomReferenceAltKm(): number {
    // Fresh altitude estimate from altKm (updated every scroll) and the last
    // terrain sample, instead of the 10-frame-stale altAboveTerrainKm.
    return Math.max(0.001, this.altKm - this.lastTerrainElev);
  }

  /**
   * Signed distance, in km, that a wheel `deltaY` dollies the camera along its
   * look direction. deltaY > 0 = scroll down on Mac natural scroll = zoom OUT.
   */
  private wheelStepKm(deltaY: number): number {
    // Log-normalize deltaY for consistent feel across platforms/trackpads.
    const normalizedDelta = Math.log2(Math.abs(deltaY) + 1);
    const alt = this.zoomReferenceAltKm;
    const scrollCoeff = alt > 1.0 ? 0.06 : 0.03;
    // Linear speed — no quadratic brake. The renderer's surface clamp prevents
    // going through terrain, so the brake is unnecessary and makes the last
    // 100m approach to surface painfully slow.
    const rawSpeed = alt * scrollCoeff * normalizedDelta;
    // Floor ensures camera can always scroll out even if trapped below terrain
    const speed = Math.max(0.003 * normalizedDelta, rawSpeed);
    return deltaY > 0 ? -speed : speed;
  }

  /**
   * The same step for a pinch increment, as a fraction of the height above
   * terrain rather than through the wheel curve above: that curve's
   * log-normalization is calibrated for whole wheel notches and would turn each
   * tiny pinch ratio into a near-full notch, sending the camera underground
   * within one gesture. A fraction composes across increments, so the zoom
   * depends on the gesture and not on the device's event rate.
   */
  private pinchStepKm(scale: number): number {
    const fraction = 1 - pinchZoomFactor(scale);
    const magnitude = Math.abs(fraction);
    // Floor mirrors wheelStepKm's, for a camera trapped below terrain.
    const speed = Math.max(0.003 * magnitude, this.zoomReferenceAltKm * magnitude);
    return fraction < 0 ? -speed : speed;
  }

  /**
   * Dolly by `stepKm` along the look direction.
   *
   * While orbiting, the camera is what's authoritative — `update()` rewrites the
   * geodetic state from it — so the step has to move the camera itself. Writing
   * it into latRad/lonRad/altKm there would be overwritten before it was ever
   * applied, which is how a pinch over terrain used to do nothing at all.
   */
  private dolly(stepKm: number, ctx: CameraModeContext): void {
    if (this.rightDragging && this.hasPivot) {
      ctx.camera.getWorldDirection(_tmpV);
      const bm = ctx.bodyMeshes.get(this.bodyName);
      let t = stepKm;
      if (bm) {
        // Same terrain clearance as the geodetic dolly, on the camera's own ray.
        const bodyQ = this.getBodyQuat(ctx, bm);
        const invQ = bodyQ ? bodyQ.clone().invert() : null;
        const startKm = ctx.camera.position.clone().sub(bm.position).divideScalar(ctx.scaleFactor);
        const dirKm = _tmpV.clone();
        if (invQ) { startKm.applyQuaternion(invQ); dirKm.applyQuaternion(invQ); }
        t = clipRayToFloor(geometryToBodyFixed(startKm), geometryToBodyFixed(dirKm), stepKm, this.ellipsoid, this.terrainFloor(bm));
      }
      ctx.camera.position.addScaledVector(_tmpV, t * ctx.scaleFactor);
      return;
    }
    this.dollyGeodetic(stepKm, ctx);
  }

  /**
   * Dolly along the view ray in body-fixed space, stopping at a small clearance
   * above sampled terrain (a camera already below it can still back out).
   */
  private dollyGeodetic(stepKm: number, ctx: CameraModeContext): void {
    this.suppressGeodetic = false;
    const bm = ctx.bodyMeshes.get(this.bodyName);
    const next = dollyAlongView(this.pose, stepKm, this.ellipsoid, bm ? this.terrainFloor(bm) : undefined);
    next.altKm = Math.max(-20, Math.min(10000, next.altKm));
    next.pitchRad = Math.max(-1.5, Math.min(0.3, next.pitchRad));
    this.pose = next;
  }

  /** Sampled terrain height plus the dolly clearance, km above the ellipsoid. */
  private terrainFloor(bm: BodyMesh): FloorFn {
    return (latRad, lonRad) => {
      const sample = bm.sampleTerrainElevation(latRad * 180 / Math.PI, lonRad * 180 / Math.PI);
      return sample ? sample.elevationKm + DOLLY_TERRAIN_CLEARANCE_KM : null;
    };
  }

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

    // Orbit around the exact rendered raycast intersection. The reported
    // lat/lon and altitude describe the CPU terrain sample and are deliberately
    // not another point on the ray; reconstructing Cartesian coordinates from
    // them causes visible parallax near the surface.
    const [ecefX, ecefY, ecefZ] = hit.bodyFixedHitKm;
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

    // Yaw/tilt about the geodetic normal at the pivot, not the radial direction.
    const pivotGeo = bodyFixedToGeodeticRad(geometryToBodyFixed(this.pivotBodyFixed), this.ellipsoid);
    const pivotUp = bodyFixedToGeometry(localFrame(pivotGeo.latRad, pivotGeo.lonRad).up, new THREE.Vector3());
    if (bodyQ) pivotUp.applyQuaternion(bodyQ);
    pivotUp.normalize();
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
    const invQ = bodyQ ? bodyQ.clone().invert() : null;

    const km = ctx.camera.position.clone().sub(bm.position).divideScalar(sf);
    if (invQ) km.applyQuaternion(invQ);
    if (km.lengthSq() < 1e-20) return;

    // No latitude clamp: the pose is well-defined on the polar axis, and a clamp
    // would teleport the camera ~1.7 km on the Moon near the south pole.
    const g = bodyFixedToGeodeticRad(geometryToBodyFixed(km), this.ellipsoid);
    this.latRad = g.latRad;
    this.lonRad = g.lonRad;
    // Allow negative altKm: surface terrain on Mars (e.g., Gale Crater at ~-5 km)
    // sits below the IAU reference ellipsoid. Floor at -20 km to bracket the deepest
    // Mars basins (Hellas ~-8 km) with margin; matches the dolly clamp.
    this.altKm = Math.max(-20, g.altKm);

    // Heading/pitch of the look direction in the geodetic local frame.
    const look = new THREE.Vector3(0, 0, -1).transformDirection(ctx.camera.matrixWorld);
    if (invQ) look.applyQuaternion(invQ);
    const hp = headingPitchOf(geometryToBodyFixed(look), localFrame(g.latRad, g.lonRad), this.heading);
    this.heading = hp.headingRad;
    this.pitch = Math.max(-1.5, Math.min(0.3, hp.pitchRad));
  }

  // ─── Coordinate conversions ──────────────────────────────────────────

  /** Convert body-fixed pivot position to world space. No geodetic conversion = no mismatch. */
  private pivotToWorld(sf: number, bodyPos: THREE.Vector3, bodyQ: THREE.Quaternion | null): THREE.Vector3 {
    const v = this.pivotBodyFixed.clone();
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
