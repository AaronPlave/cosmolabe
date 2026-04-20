import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { KeyboardControls } from './KeyboardControls.js';
import type { KeyboardControlsConfig } from './KeyboardControls.js';
import type { BodyMesh } from '../BodyMesh.js';
import { CameraModeName, type ICameraMode, type CameraModeContext, type CameraModeParams, type CameraModeSpice } from './CameraModes.js';
import { FreeOrbitMode } from './modes/FreeOrbitMode.js';
import { ScFixedMode } from './modes/ScFixedMode.js';
import { BodyFixedMode } from './modes/BodyFixedMode.js';
import { LvlhMode } from './modes/LvlhMode.js';
import { ChaseMode } from './modes/ChaseMode.js';
import { SurfaceMode } from './modes/SurfaceMode.js';
import { InstrumentMode } from './modes/InstrumentMode.js';

/** A saved camera viewpoint (position + target in scene coordinates) */
export interface CameraViewpoint {
  name: string;
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  /** If set, camera tracks this body name */
  trackBody?: string;
}

export interface FlyToOptions {
  /** Animation duration in seconds (default: 1.0) */
  duration?: number;
  /** Distance multiplier relative to body display radius (default: 3) */
  distanceMultiplier?: number;
  /** Scale factor for converting body radius to scene units */
  scaleFactor?: number;
}

export class CameraController {
  readonly controls: TrackballControls;
  readonly camera: THREE.PerspectiveCamera;
  /** Keyboard controls for roll, translation, and slew */
  readonly keyboard: KeyboardControls;

  /** Right-click drag sensitivity in radians per pixel (default: 0.003) */
  freeLookSensitivity = 0.003;

  /** Base speeds (adapted per-frame by distance to nearest body surface) */
  private readonly _baseRotateSpeed = 2.0;
  private readonly _baseZoomSpeed = 1.2;

  private _trackTarget: BodyMesh | null = null;
  /** The body the camera is orbiting (orbit target locked to origin) */
  get trackedBody(): BodyMesh | null { return this._trackTarget; }

  /**
   * The body used as the coordinate-system origin for rendering.
   * Set when tracking starts. Persists after un-tracking so the scene
   * doesn't jump. Only changes when a new body is tracked.
   */
  private _originBody: BodyMesh | null = null;
  get originBody(): BodyMesh | null { return this._originBody; }

  private _lookAtTarget: BodyMesh | null = null;
  get lookAtBody(): BodyMesh | null { return this._lookAtTarget; }
  private readonly _prevTargetPos = new THREE.Vector3();

  /** Deferred origin switch — applied by renderer before computing body positions */
  private _pendingOriginSwitch: BodyMesh | null = null;

  /** Named viewpoint presets (catalog-loaded + user-saved) */
  private _viewpoints = new Map<string, CameraViewpoint>();

  /** Animation state */
  private _anim: {
    startPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    startUp: THREE.Vector3;
    endPos: THREE.Vector3;
    endTarget: THREE.Vector3;
    endUp: THREE.Vector3;
    duration: number;
    elapsed: number;
    onComplete?: () => void;
    /** If set, endPos/endTarget track this body's position each frame */
    followBody?: BodyMesh;
    followDist?: number;
    followDir?: THREE.Vector3;
  } | null = null;
  private _lastAnimMs = 0;

  /** Frame timing for keyboard dt */
  private _lastFrameMs: number;

  /** Right-click free-look state */
  private _rightDragging = false;
  private _rightDragDx = 0;   // accumulated pixel delta since last update()
  private _rightDragDy = 0;
  private _prevMouseX = 0;
  private _prevMouseY = 0;

  /** Camera mode system */
  private readonly _modes: Map<CameraModeName, ICameraMode>;
  private _activeMode: ICameraMode;
  private _modeCtx: CameraModeContext | null = null;

  /** Current camera mode name */
  get mode(): CameraModeName { return this._activeMode.name; }

  /** Bound event handlers (for cleanup) */
  private readonly _onRightDown: (e: MouseEvent) => void;
  private readonly _onMouseMove: (e: MouseEvent) => void;
  private readonly _onMouseUp: (e: MouseEvent) => void;
  private readonly _onContextMenu: (e: Event) => void;
  private readonly _domElement: HTMLElement;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    keyboardConfig?: KeyboardControlsConfig,
  ) {
    this.camera = camera;
    this._domElement = domElement;

    this.controls = new TrackballControls(camera, domElement);
    this.controls.rotateSpeed = 2.0;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.8;
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.15;
    this.controls.minDistance = 1e-10;
    this.controls.maxDistance = 1e12;
    // Disable right-click pan — we use right-click for free look instead
    this.controls.noPan = true;

    this.keyboard = new KeyboardControls(keyboardConfig);
    this._lastFrameMs = performance.now();

    // Initialize camera modes
    const freeOrbit = new FreeOrbitMode();
    this._modes = new Map<CameraModeName, ICameraMode>([
      [CameraModeName.FREE_ORBIT, freeOrbit],
      [CameraModeName.SC_FIXED, new ScFixedMode()],
      [CameraModeName.BODY_FIXED, new BodyFixedMode()],
      [CameraModeName.LVLH, new LvlhMode()],
      [CameraModeName.CHASE, new ChaseMode()],
      [CameraModeName.SURFACE, new SurfaceMode()],
      [CameraModeName.INSTRUMENT, new InstrumentMode()],
    ]);
    this._activeMode = freeOrbit;

    // --- Right-click free look ---
    // Capture phase so we intercept before TrackballControls
    this._onRightDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      e.stopPropagation();
      this._rightDragging = true;
      this._prevMouseX = e.clientX;
      this._prevMouseY = e.clientY;
    };

    this._onMouseMove = (e: MouseEvent) => {
      if (!this._rightDragging) return;
      this._rightDragDx += e.clientX - this._prevMouseX;
      this._rightDragDy += e.clientY - this._prevMouseY;
      this._prevMouseX = e.clientX;
      this._prevMouseY = e.clientY;
    };

    this._onMouseUp = (e: MouseEvent) => {
      if (e.button === 2) this._rightDragging = false;
    };

    this._onContextMenu = (e: Event) => e.preventDefault();

    domElement.addEventListener('mousedown', this._onRightDown, { capture: true });
    domElement.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
  }

  /** Focus on a body — move orbit target to body position */
  focusOn(bodyMesh: BodyMesh): void {
    this.controls.target.copy(bodyMesh.position);
  }

  /** Focus and zoom to a body — positions camera at a good viewing distance.
   *  With origin-shifting, the tracked body will be at (0,0,0) after the next frame. */
  zoomTo(bodyMesh: BodyMesh, scaleFactor: number): void {
    this.controls.target.set(0, 0, 0);
    // Position camera at 3× the body's display radius
    const viewDist = bodyMesh.displayRadius * scaleFactor * 3;
    const dir = this.camera.position.clone();
    if (dir.lengthSq() < 1e-20) dir.set(0, 0, 1);
    dir.normalize();
    this.camera.position.copy(dir).multiplyScalar(viewDist);
  }

  /** Animated fly-to: smoothly move camera to view a body.
   *  Handles cross-body flight: animates toward the body's current scene position
   *  (updating each frame as it moves), then switches origin on completion. */
  flyTo(bodyMesh: BodyMesh, opts?: FlyToOptions): void {
    const duration = opts?.duration ?? 1.0;
    const distMult = opts?.distanceMultiplier ?? 3;
    const sf = opts?.scaleFactor ?? 1e-6;

    // Disable tracking during animation so the orbit target can animate
    // freely (tracking resets it to origin each frame)
    this._trackTarget = null;

    const viewDist = bodyMesh.displayRadius * sf * distMult;
    const bodyPos = bodyMesh.position;

    // Approach from current camera direction relative to body
    const dir = this.camera.position.clone().sub(bodyPos);
    if (dir.lengthSq() < 1e-20) dir.set(0, 0.3, 1);
    dir.normalize();

    const endTarget = bodyPos.clone();
    const endPos = bodyPos.clone().addScaledVector(dir, viewDist);

    const anim = this._startAnimation(endPos, endTarget, this.camera.up.clone(), duration, () => {
      // Defer origin switch to next frame — if we switch now, body positions
      // (already computed this frame with the old origin) won't match the
      // camera's new coordinates, causing a one-frame flash.
      this._pendingOriginSwitch = bodyMesh;
    });

    // Track the body each frame so endpoints follow its motion
    anim.followBody = bodyMesh;
    anim.followDist = viewDist;
    anim.followDir = dir;
  }

  /** Animate camera to a saved viewpoint by name */
  goToViewpoint(name: string, duration = 1.0): boolean {
    const vp = this._viewpoints.get(name);
    if (!vp) return false;
    this._startAnimation(
      vp.position.clone(), vp.target.clone(), vp.up.clone(), duration,
    );
    return true;
  }

  /** Apply a viewpoint immediately (no animation) */
  applyViewpoint(vp: CameraViewpoint): void {
    this.cancelAnimation();
    this.camera.position.copy(vp.position);
    this.controls.target.copy(vp.target);
    this.camera.up.copy(vp.up);
  }

  /** Save current camera state as a named viewpoint */
  saveViewpoint(name: string): CameraViewpoint {
    const vp: CameraViewpoint = {
      name,
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      up: this.camera.up.clone(),
      trackBody: this._trackTarget?.body.name,
    };
    this._viewpoints.set(name, vp);
    return vp;
  }

  /** Add a viewpoint to the preset list */
  addViewpoint(vp: CameraViewpoint): void {
    this._viewpoints.set(vp.name, vp);
  }

  /** Get all registered viewpoints */
  getViewpoints(): CameraViewpoint[] {
    return Array.from(this._viewpoints.values());
  }

  /** Get a viewpoint by name */
  getViewpoint(name: string): CameraViewpoint | undefined {
    return this._viewpoints.get(name);
  }

  /** Track a body each frame — camera orbits the body, preserving the view offset.
   *  Also sets this body as the origin body for coordinate-system centering. */
  track(bodyMesh: BodyMesh | null): void {
    this._trackTarget = bodyMesh;
    if (bodyMesh) {
      this._originBody = bodyMesh;
      this.focusOn(bodyMesh);
      this._prevTargetPos.copy(bodyMesh.position);
    }
  }

  /** Set a "look at" body — orbit center moves to this body's position while
   *  origin-shifting still follows the origin body. Pass null to clear. */
  lookAt(bodyMesh: BodyMesh | null): void {
    this._lookAtTarget = bodyMesh;
  }

  /** Clear the look-at target (orbit center returns to tracked body) */
  clearLookAt(): void {
    this._lookAtTarget = null;
  }

  /**
   * Switch camera mode. Returns false if the mode name is unknown.
   * Switching to FREE_ORBIT re-enables orbit controls and keyboard.
   */
  setMode(modeName: CameraModeName, params: CameraModeParams = {}): boolean {
    const newMode = this._modes.get(modeName);
    if (!newMode) return false;

    // Deactivate current mode
    if (this._modeCtx) {
      this._activeMode.deactivate(this._modeCtx);
    }

    // Restore TrackballControls damping and camera up when leaving a non-FreeOrbit mode
    if (this._activeMode.name !== CameraModeName.FREE_ORBIT) {
      this.controls.staticMoving = false;
      this.controls.dynamicDampingFactor = 0.15;
      // Modes may set camera.up to unusual directions (e.g. surface normal).
      // Reset to prevent TrackballControls gimbal instability.
      if (modeName === CameraModeName.FREE_ORBIT) {
        this.camera.up.set(0, 1, 0);
      }
    }

    this._activeMode = newMode;

    // Enable/disable TrackballControls based on mode
    this.controls.enabled = newMode.allowsOrbitControls;

    // For orbit-allowing modes (SC_FIXED, BODY_FIXED) that use delta rotation,
    // disable TrackballControls damping to prevent fighting — damping nudges the
    // camera each frame, which the delta rotation then re-rotates, causing jitter.
    if (modeName !== CameraModeName.FREE_ORBIT && newMode.allowsOrbitControls) {
      this.controls.staticMoving = true;
    }

    // Set origin body to the mode's target for floating-point precision.
    // Without this, camera.position = largeBodyOffset + smallCameraOffset loses precision.
    if (params.bodyName && this._modeCtx) {
      const targetBm = this._modeCtx.bodyMeshes.get(params.bodyName);
      if (targetBm) {
        this._originBody = targetBm;
      }
    }

    // Activate new mode with context
    if (this._modeCtx) {
      newMode.activate(this._modeCtx, params);
    }

    return true;
  }

  /**
   * Set camera mode with automatic body-name resolution.
   * For spacecraft targets, resolves the appropriate body for each mode:
   * - SC_FIXED/LVLH/CHASE: uses the spacecraft itself
   * - BODY_FIXED/SURFACE: uses the parent celestial body (planet/moon)
   * - INSTRUMENT: activates the specified sensor
   *
   * @param modeName The camera mode to switch to
   * @param bodyMesh The body to target (usually the tracked body)
   * @param opts Extra options (sensorName for instrument mode)
   */
  setModeForBody(
    modeName: CameraModeName,
    bodyMesh: BodyMesh | null,
    opts?: { sensorName?: string },
  ): boolean {
    if (!bodyMesh) return this.setMode(modeName);

    const body = bodyMesh.body;
    const isSC = body.classification === 'spacecraft';
    const parentName = body.parentName ?? '';
    const celestialBody = isSC ? parentName : body.name;

    switch (modeName) {
      case CameraModeName.FREE_ORBIT:
        return this.setMode(CameraModeName.FREE_ORBIT);
      case CameraModeName.SC_FIXED:
        return this.setMode(CameraModeName.SC_FIXED, { bodyName: body.name });
      case CameraModeName.BODY_FIXED:
        return this.setMode(CameraModeName.BODY_FIXED, { bodyName: celestialBody });
      case CameraModeName.LVLH:
        return this.setMode(CameraModeName.LVLH, {
          bodyName: body.name, centerBodyName: parentName, axis: '-Z',
        });
      case CameraModeName.CHASE:
        return this.setMode(CameraModeName.CHASE, {
          bodyName: body.name, centerBodyName: parentName, offset: 100,
        });
      case CameraModeName.SURFACE:
        return this.setMode(CameraModeName.SURFACE, {
          bodyName: celestialBody, latDeg: 0, lonDeg: 0, altKm: 10,
          lookTarget: isSC ? body.name : undefined,
        });
      case CameraModeName.INSTRUMENT:
        return this.setMode(CameraModeName.INSTRUMENT, {
          sensorName: opts?.sensorName ?? '',
        });
      default:
        return this.setMode(modeName);
    }
  }

  /**
   * Track a body and restore the current camera mode.
   * Handles the zoom → track → mode-reactivation sequence.
   *
   * @param bodyMesh The body to track
   * @param scaleFactor Scale factor for zoom distance
   */
  trackBody(bodyMesh: BodyMesh, scaleFactor: number): void {
    const prevMode = this._activeMode.name;

    this.clearLookAt();
    this.zoomTo(bodyMesh, scaleFactor);
    this.track(bodyMesh);

    // track() calls focusOn() which sets controls.target to the body's current
    // scene position — but that's in the OLD origin's coordinates. After the origin
    // switch (next renderFrame), the body will be at (0,0,0). Set target there now
    // so the mode doesn't start with a stale target vector.
    this.controls.target.set(0, 0, 0);

    // Re-activate the mode with the new body. Mode.activate() only reads body
    // rotation (not position), so it's safe to call before the origin switch
    // settles — the first update() will use the correct positions from renderFrame.
    if (prevMode !== CameraModeName.FREE_ORBIT) {
      this.setModeForBody(prevMode, bodyMesh);
    }
  }

  /** Reset to Free Orbit mode, cancelling any animation and clearing look-at. */
  resetToFreeOrbit(): void {
    this.cancelAnimation();
    this.clearLookAt();
    if (this._activeMode.name !== CameraModeName.FREE_ORBIT) {
      this.setMode(CameraModeName.FREE_ORBIT);
      // Reset camera up to a sensible default — modes like Surface set it to the
      // local surface normal which can cause gimbal instability in TrackballControls.
      this.camera.up.set(0, 1, 0);
    }
  }

  /**
   * Cycle to the next camera mode. Excludes INSTRUMENT by default.
   * @param exclude Mode names to skip when cycling
   * @returns The new mode name
   */
  cycleMode(exclude: CameraModeName[] = [CameraModeName.INSTRUMENT]): CameraModeName {
    const allModes = [
      CameraModeName.FREE_ORBIT, CameraModeName.SC_FIXED, CameraModeName.BODY_FIXED,
      CameraModeName.LVLH, CameraModeName.CHASE, CameraModeName.SURFACE,
      CameraModeName.INSTRUMENT,
    ];
    const available = allModes.filter(m => !exclude.includes(m));
    const curIdx = available.indexOf(this._activeMode.name);
    const nextMode = available[(curIdx + 1) % available.length];
    this.setModeForBody(nextMode, this._trackTarget ?? this._originBody);
    return nextMode;
  }

  /** Get the mode instance (for mode-specific properties like InstrumentMode.sensorName) */
  getModeInstance<T extends ICameraMode>(modeName: CameraModeName): T | undefined {
    return this._modes.get(modeName) as T | undefined;
  }

  /**
   * Set the per-frame context for camera modes.
   * Must be called by the renderer each frame before update().
   */
  setModeContext(
    spice: CameraModeSpice | null,
    et: number,
    scaleFactor: number,
    bodyMeshes: Map<string, BodyMesh>,
  ): void {
    if (!this._modeCtx) {
      this._modeCtx = {
        camera: this.camera,
        controls: this.controls,
        bodyMeshes,
        spice,
        et,
        dt: 0,
        scaleFactor,
        originBody: this._originBody,
      };
    } else {
      this._modeCtx.spice = spice;
      this._modeCtx.et = et;
      this._modeCtx.scaleFactor = scaleFactor;
      this._modeCtx.bodyMeshes = bodyMeshes;
      this._modeCtx.originBody = this._originBody;
    }
  }

  /**
   * Smoothly slew (rotate) the camera to face a world-space position.
   * @param target World position to rotate toward
   * @param rate Angular rate in radians/second (default: 0.5)
   * @param onComplete Called when slew reaches the target direction
   */
  slewTo(target: THREE.Vector3, rate?: number, onComplete?: () => void): void {
    this.keyboard.slewTo(target, rate, onComplete);
  }

  /** Cancel any active slew */
  cancelSlew(): void {
    this.keyboard.cancelSlew();
  }

  /** Whether a slew is currently in progress */
  get slewing(): boolean {
    return this.keyboard.slewing;
  }

  /** Apply deferred origin switch from a completed fly-to animation.
   *  Must be called by the renderer BEFORE computing body positions so that
   *  camera coordinates and body positions use the same origin. */
  applyPendingOriginSwitch(): void {
    const body = this._pendingOriginSwitch;
    if (!body) return;
    this._pendingOriginSwitch = null;

    // Adjust camera from old-origin coords to new-origin coords
    const bodyPos = body.position; // still in old-origin coords from last frame
    this._originBody = body;
    this._trackTarget = body;
    this._prevTargetPos.copy(bodyPos);
    this.camera.position.sub(bodyPos);
    this.controls.target.set(0, 0, 0);
  }

  /** Whether a fly-to/viewpoint animation is currently playing */
  get animating(): boolean { return this._anim !== null; }

  /** Cancel any in-progress camera animation */
  cancelAnimation(): void {
    this._anim = null;
  }

  /**
   * Adapt orbit/zoom speeds based on altitude above the nearest body surface.
   * Only Globe/Ellipsoid bodies participate — spacecraft and tiny bodies are
   * ignored. When far from all bodies, speeds stay at their base values.
   *
   * sqrt(altitude / (10 × bodyRadius)): speeds reach base level at 10× the
   * body's radius above the surface, and decrease smoothly as you zoom in:
   *   ratio=10    → factor=1.0   (10× radius above surface — base speeds)
   *   ratio=2     → factor=0.45  (default flyTo distance)
   *   ratio=0.5   → factor=0.22  (zoomed in closer)
   *   ratio=0.1   → factor=0.1   (low orbit)
   *   ratio=0.01  → factor=0.03  (near surface)
   *
   * Call once per frame before update().
   */
  adaptSpeeds(bodyMeshes: Iterable<BodyMesh>, scaleFactor: number): void {
    // When focused on a spacecraft or other non-Globe body, keep base speeds —
    // nearby planet proximity shouldn't slow down inspection of that object.
    // Uses originBody (persists after un-tracking via WASD/free-look).
    if (this._originBody) {
      const gt = this._originBody.body.geometryType;
      if (gt !== 'Globe' && gt !== 'Ellipsoid') {
        this.controls.rotateSpeed = this._baseRotateSpeed;
        this.controls.zoomSpeed = this._baseZoomSpeed;
        return;
      }
    }

    let minAltRatio = Infinity;

    for (const bm of bodyMeshes) {
      const gt = bm.body.geometryType;
      if (gt !== 'Globe' && gt !== 'Ellipsoid') continue;
      const surfaceR = bm.displayRadius * scaleFactor;
      if (surfaceR < 1e-20) continue;
      const dist = this.camera.position.distanceTo(bm.position);
      const altitude = Math.max(dist - surfaceR, 0);
      const ratio = altitude / surfaceR;
      if (ratio < minAltRatio) minAltRatio = ratio;
    }

    if (!isFinite(minAltRatio)) return; // no nearby Globe — keep base speeds

    const factor = Math.max(Math.min(Math.sqrt(minAltRatio / 10), 1), 0.01);
    this.controls.rotateSpeed = this._baseRotateSpeed * factor;
    this.controls.zoomSpeed = this._baseZoomSpeed * factor;
  }

  update(): void {
    // Frame timing
    const now = performance.now();
    const dt = Math.min((now - this._lastFrameMs) / 1000, 0.1); // cap at 100ms
    this._lastFrameMs = now;

    // Update mode context dt
    if (this._modeCtx) {
      this._modeCtx.dt = dt;
      this._modeCtx.originBody = this._originBody;
    }

    // Advance fly-to animation if active (works in all modes)
    if (this._anim) {
      const animDt = (now - this._lastAnimMs) / 1000;
      this._lastAnimMs = now;
      this._anim.elapsed += animDt;

      // If following a body, update endpoints to track its moving position
      if (this._anim.followBody && this._anim.followDir && this._anim.followDist != null) {
        const bodyPos = this._anim.followBody.position;
        this._anim.endTarget.copy(bodyPos);
        this._anim.endPos.copy(bodyPos).addScaledVector(this._anim.followDir, this._anim.followDist);
      }

      const t = Math.min(this._anim.elapsed / this._anim.duration, 1);
      const s = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      this.camera.position.lerpVectors(this._anim.startPos, this._anim.endPos, s);
      this.controls.target.lerpVectors(this._anim.startTarget, this._anim.endTarget, s);
      this.camera.up.lerpVectors(this._anim.startUp, this._anim.endUp, s).normalize();
      this.camera.lookAt(this.controls.target);

      if (t >= 1) {
        const onComplete = this._anim.onComplete;
        this._anim = null;
        // Clear stale TrackballControls damping that accumulated while
        // controls.update() was skipped during the animation.
        (this.controls as any)._lastAngle = 0;
        (this.controls as any)._zoomStart?.copy((this.controls as any)._zoomEnd);
        onComplete?.();
      }
      return; // Animation takes priority over mode updates
    }

    // --- Non-FreeOrbit modes: delegate to active mode ---
    if (this._activeMode.name !== CameraModeName.FREE_ORBIT) {
      // Discard right-click drag — modes handle their own orientation via delta rotation.
      // Right-click in these modes would fight with the mode's target/quaternion control.
      this._rightDragDx = 0;
      this._rightDragDy = 0;

      // Orbit controls (before mode update so mode sees user-adjusted position)
      if (this._activeMode.allowsOrbitControls) {
        this.controls.update();
      }

      // Mode update: applies delta rotation to position, target, quaternion, and up.
      // The mode rotates ALL of these consistently so the camera-to-target direction
      // and screen-space axes stay correct. No lookAt needed.
      if (this._modeCtx) {
        this._activeMode.update(this._modeCtx);
      }

      // Keyboard (WASD/roll) — camera quaternion is already correct from mode update,
      // so getWorldDirection() returns proper screen-space directions.
      if (this._activeMode.allowsKeyboard) {
        this.keyboard.update(this.camera, this.controls.target, dt);
      }
      return;
    }

    // --- FreeOrbit mode: existing behavior ---

    // Right-click free look
    if (this._rightDragDx !== 0 || this._rightDragDy !== 0) {
      this._trackTarget = null;

      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();

      const q = new THREE.Quaternion();
      q.premultiply(
        new THREE.Quaternion().setFromAxisAngle(this.camera.up, -this._rightDragDx * this.freeLookSensitivity),
      );
      q.premultiply(
        new THREE.Quaternion().setFromAxisAngle(right, -this._rightDragDy * this.freeLookSensitivity),
      );

      const dist = this.camera.position.distanceTo(this.controls.target);
      const newDir = forward.applyQuaternion(q).normalize();
      this.controls.target.copy(this.camera.position).addScaledVector(newDir, dist);
      this.camera.up.applyQuaternion(q).normalize();

      this._rightDragDx = 0;
      this._rightDragDy = 0;
    }

    // Tracking: lock orbit target to the tracked body at origin
    if (this._trackTarget) {
      this.controls.target.set(0, 0, 0);
    }

    // Mouse left-drag orbit + scroll zoom
    this.controls.update();

    // Keyboard: roll (Q/E), translation (WASD/ZC), slew
    this.keyboard.update(this.camera, this.controls.target, dt);

    // Keyboard translation while tracking → un-track (origin body persists)
    if (this.keyboard.translatedThisFrame && this._trackTarget) {
      this._trackTarget = null;
    }

    // After all controls, override orientation to face the lookAt body.
    if (this._lookAtTarget) {
      this.camera.lookAt(this._lookAtTarget.position);
    }
  }

  dispose(): void {
    this._anim = null;
    this._viewpoints.clear();
    this.keyboard.dispose();
    this.controls.dispose();

    this._domElement.removeEventListener('mousedown', this._onRightDown, { capture: true });
    this._domElement.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
  }

  private _startAnimation(
    endPos: THREE.Vector3,
    endTarget: THREE.Vector3,
    endUp: THREE.Vector3,
    duration: number,
    onComplete?: () => void,
  ): NonNullable<typeof this._anim> {
    this._anim = {
      startPos: this.camera.position.clone(),
      startTarget: this.controls.target.clone(),
      startUp: this.camera.up.clone(),
      endPos,
      endTarget,
      endUp,
      duration,
      elapsed: 0,
      onComplete,
    };
    this._lastAnimMs = performance.now();
    return this._anim;
  }
}
