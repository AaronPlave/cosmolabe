import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { KeyboardControls } from './KeyboardControls.js';
import { attachPointerInput } from './PointerInput.js';
import type { KeyboardControlsConfig } from './KeyboardControls.js';
import type { BodyMesh } from '../BodyMesh.js';
import {
  CameraModeName,
  type ICameraMode,
  type CameraModeContext,
  type CameraModeParams,
  type CameraModeSpice,
  type CameraSurfacePickResult,
} from './CameraModes.js';
import { FreeOrbitMode } from './modes/FreeOrbitMode.js';
import { ScFixedMode } from './modes/ScFixedMode.js';
import { BodyFixedMode } from './modes/BodyFixedMode.js';
import { LvlhMode } from './modes/LvlhMode.js';
import { ChaseMode } from './modes/ChaseMode.js';
import { SurfaceMode } from './modes/SurfaceMode.js';
import { InstrumentMode } from './modes/InstrumentMode.js';
import { SurfaceExplorerMode } from './modes/SurfaceExplorerMode.js';

/** A saved camera viewpoint (position + target in scene coordinates) */
export interface CameraViewpoint {
  name: string;
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  /** If set, camera tracks this body name */
  trackBody?: string;
  /**
   * If set, the moment this viewpoint depicts, in ephemeris seconds past J2000
   * (a catalog Viewpoint's `time`, already resolved). Applying the viewpoint
   * seeks the clock to it; a viewpoint that leaves this undefined leaves the
   * clock where it is.
   */
  epoch?: number;
}

/** The scripted camera moves `orbitTarget`, `dolly` and `crane` start. */
type CameraMoveKind = 'orbit-up' | 'orbit-right' | 'dolly' | 'crane';

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

  /** Shift+wheel FOV adjustment sensitivity (multiplicative; default: 0.001 per deltaY unit) */
  fovWheelSensitivity = 0.001;
  /** Clamp range for shift+wheel FOV adjustment (degrees) */
  fovMinDeg = 1;
  fovMaxDeg = 120;
  /** Continuous internal FOV; rounded to int when written to the camera. Lazy-init from camera.fov on first wheel event. */
  private _fovTargetDeg: number | null = null;

  /** Base speeds (adapted per-frame by distance to nearest body surface) */
  private readonly _baseRotateSpeed = 2.0;
  private readonly _baseZoomSpeed = 1.2;

  private _trackTarget: BodyMesh | null = null;
  /** The body the camera is orbiting (orbit target locked to origin) */
  get trackedBody(): BodyMesh | null { return this._trackTarget; }

  /** The body the camera is currently tracking OR animating toward.
   *  Use this when behavior should engage as soon as a flyTo starts (e.g., the
   *  surface clamp skip), not wait until the animation completes and tracking
   *  is officially set. Also covers the gap between animation completion and
   *  the next frame's applyPendingOriginSwitch — without _pendingOriginSwitch
   *  here, the clamp would briefly engage and snap the camera out. */
  get focusBody(): BodyMesh | null {
    return this._anim?.followBody ?? this._pendingOriginSwitch ?? this._trackTarget;
  }

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

  /** Right-button free-look state (mouse and pen; a finger orbits instead) */
  private _rightDragging = false;
  private _rightDragDx = 0;   // accumulated pixel delta since last update()
  private _rightDragDy = 0;

  /** Two-finger pan, accumulated in pixels since the last update() */
  private _touchPanDx = 0;
  private _touchPanDy = 0;

  /** Camera mode system */
  private readonly _modes: Map<CameraModeName, ICameraMode>;
  private _activeMode: ICameraMode;
  private _modeCtx: CameraModeContext | null = null;

  /** Current camera mode name */
  get mode(): CameraModeName { return this._activeMode.name; }

  /** Bound event handlers (for cleanup) */
  private readonly _detachPointerInput: () => void;
  private readonly _onWheel: (e: WheelEvent) => void;
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
      [CameraModeName.SURFACE_EXPLORER, new SurfaceExplorerMode()],
      [CameraModeName.INSTRUMENT, new InstrumentMode()],
    ]);
    this._activeMode = freeOrbit;

    // --- Right-button free look ---
    // Mouse and pen only: a finger has no second button, and TrackballControls
    // already gives touch a one-finger orbit and a two-finger pinch zoom.
    // The pointerdown runs in the capture phase so we intercept before
    // TrackballControls — and, because the capture phase reaches the window
    // first, `App.svelte`'s window-level listener still sees the right-click
    // before this `stopPropagation`.
    this._detachPointerInput = attachPointerInput(domElement, {
      preventContextMenu: true,
      onButtonDown: (e) => {
        if (e.button !== 2) return;
        e.stopPropagation();
        this._rightDragging = true;
      },
      onButtonDrag: (dx, dy) => {
        if (!this._rightDragging) return;
        this._rightDragDx += dx;
        this._rightDragDy += dy;
      },
      onButtonUp: (e) => {
        if (e.button === 2) this._rightDragging = false;
      },
      onCancel: () => { this._rightDragging = false; },
      // Two-finger drag pans. TrackballControls computes the same centroid
      // motion for touch, but only applies it when `noPan` is false — and
      // `noPan` is what keeps a right-mouse drag from panning *and* free
      // looking at once. Panning here keeps those two independent.
      onPinch: (_scale, dx, dy) => {
        this._touchPanDx += dx;
        this._touchPanDy += dy;
      },
    });

    // Shift + wheel adjusts FOV instead of zooming. Capture phase to intercept
    // before TrackballControls's wheel handler so it doesn't also dolly the camera.
    this._onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      // Browsers (notably macOS) remap shift+vertical-wheel to horizontal scroll,
      // so the delta arrives on deltaX. Use whichever axis has the larger magnitude.
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const cam = this.camera;
      // Re-sync from camera if FOV was changed externally (e.g. DisplaySettings slider).
      if (this._fovTargetDeg === null || Math.round(this._fovTargetDeg) !== cam.fov) {
        this._fovTargetDeg = cam.fov;
      }
      const next = this._fovTargetDeg * Math.exp(delta * this.fovWheelSensitivity);
      this._fovTargetDeg = Math.max(this.fovMinDeg, Math.min(this.fovMaxDeg, next));
      const rounded = Math.round(this._fovTargetDeg);
      if (rounded === cam.fov) return;
      cam.fov = rounded;
      cam.updateProjectionMatrix();
    };

    domElement.addEventListener('wheel', this._onWheel, { capture: true, passive: false });

    // Without this the browser claims a touch drag as a scroll or a pinch as a
    // page zoom, and the gesture never reaches the canvas.
    domElement.style.touchAction = 'none';
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

  /**
   * The zoom floor for orbiting `body`: its surface, or effectively none when
   * the renderer's terrain clamp owns the ground, or when nothing is orbited.
   *
   * Recomputed every frame in every orbit-controlled mode. It used to run only
   * on the free-orbit path, so a body-fixed or SC-fixed camera kept the floor
   * of whatever free orbit last tracked — Earth's radius, say, while placed
   * 5000 km from the Moon's centre.
   */
  private _updateMinDistance(body: BodyMesh | null): void {
    if (body) {
      const sf = body.scaleFactor;
      if (body.hasTerrain) {
        // With terrain configured, the renderer's per-frame
        // `clampCameraAboveSurfaces` owns the actual ground floor: it samples
        // real terrain at the camera's lat/lon and only pushes the camera up
        // when it would clip the rendered mesh. Importantly that clamp is
        // already body-agnostic — it works with the same logic for Jezero
        // (below the IAU mean), Olympus Mons (above), Hellas, the lunar South
        // Pole-Aitken basin, etc. Drop the trackball minDistance to effectively
        // zero so the controls don't gate zoom-in before the terrain clamp can
        // run. No body-specific magic numbers.
        this.controls.minDistance = 1e-10;
      } else {
        // No terrain data — the reference ellipsoid IS the ground. Use the
        // existing displayRadius floor.
        this.controls.minDistance = body.displayRadius * sf * 1.0001;
      }
    } else {
      this.controls.minDistance = 1e-10;
    }
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
      case CameraModeName.SURFACE_EXPLORER:
        return this.setMode(CameraModeName.SURFACE_EXPLORER, {
          bodyName: celestialBody, latDeg: 0, lonDeg: 0, altKm: 0.05,
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

  /**
   * Stop tracking the current body. The camera stays where it is — origin body
   * is preserved so the scene doesn't jump — but the orbit target is freed and
   * the camera no longer locks to (0,0,0) each frame. If currently in a
   * tracking-dependent mode (anything other than FREE_ORBIT), also returns
   * to FREE_ORBIT since those modes are meaningless without a target.
   * Idempotent: safe to call when nothing is tracked.
   */
  stopTracking(): void {
    this._trackTarget = null;
    this.clearLookAt();
    if (this._activeMode.name !== CameraModeName.FREE_ORBIT) {
      this.setMode(CameraModeName.FREE_ORBIT);
      this.camera.up.set(0, 1, 0);
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
      CameraModeName.SURFACE_EXPLORER, CameraModeName.INSTRUMENT,
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
    pickSurface?: (ndcX: number, ndcY: number) => CameraSurfacePickResult | null,
    markerScene?: THREE.Scene,
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
        pickSurface: pickSurface ?? undefined,
        markerScene,
      };
    } else {
      this._modeCtx.spice = spice;
      this._modeCtx.et = et;
      if (pickSurface !== undefined) this._modeCtx.pickSurface = pickSurface ?? undefined;
      if (markerScene !== undefined) this._modeCtx.markerScene = markerScene;
      this._modeCtx.scaleFactor = scaleFactor;
      this._modeCtx.bodyMeshes = bodyMeshes;
      this._modeCtx.originBody = this._originBody;
    }
  }

  /**
   * Re-derive the active mode's state from the camera as it stands, at scene
   * time `et` — for a caller that has just placed the camera itself, between
   * frames. `et` is passed in because the mode context's is the last frame's,
   * and the clock may have moved since.
   */
  syncModeFromCamera(et: number): void {
    if (!this._modeCtx) return;
    this._modeCtx.et = et;
    this._activeMode.syncFromCamera?.(this._modeCtx);
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

    // Adjust camera from old-origin coords to new-origin coords. Skip the
    // subtract if the body was already origin — the flyTo lerped the camera to
    // its true endPos (followBody.position + dir * dist); subtracting bodyPos
    // would yank the camera away by the body's rendered offset (relevant for
    // surface-locked bodies whose rendered position isn't at origin).
    const wasAlreadyOrigin = this._originBody === body;
    const bodyPos = body.position;
    this._originBody = body;
    this._trackTarget = body;
    this._prevTargetPos.copy(bodyPos);
    if (!wasAlreadyOrigin) {
      this.camera.position.sub(bodyPos);
    }
    this.controls.target.copy(bodyPos);

    // Defer mode-state resync to after body positions are recomputed under
    // the new origin — syncing now would use stale body positions and produce
    // wrong lat/lon (e.g., snapping Surface Explorer to the wrong pole).
    this._pendingModeSync = true;
  }

  private _pendingModeSync = false;

  /** Re-derive any active stateful mode's internal state from the current
   *  camera position. Must be called by the renderer AFTER body positions
   *  have been updated for the current frame, so the mode sees consistent
   *  body coordinates. Pairs with applyPendingOriginSwitch. */
  syncPendingModeFromCamera(): void {
    if (!this._pendingModeSync) return;
    this._pendingModeSync = false;
    if (this._modeCtx) {
      this._activeMode.syncFromCamera?.(this._modeCtx);
    }
  }

  /** Whether a fly-to/viewpoint animation is currently playing */
  get animating(): boolean { return this._anim !== null; }

  /** Cancel any in-progress camera animation, a scripted camera move included */
  cancelAnimation(): void {
    this._anim = null;
    this._move = null;
  }

  /**
   * A scripted camera move still playing: what it does, how much of it is
   * left (radians for a swing, scene units for a dolly or crane), its rate per
   * second, and when it last stepped.
   */
  private _move: {
    kind: CameraMoveKind;
    remaining: number;
    /** Per second; `null` for an instant move held until a fly-to lands. */
    rate: number | null;
    lastMs: number;
  } | null = null;

  /**
   * Swing the camera around its orbit target by `radians`, keeping its distance
   * from the target and its aim at it — Cosmographia's `circleCenter*` moves.
   *
   * `'up'` swings about the view's up vector, positive moving the camera to the
   * right; `'right'` swings about the view's right axis, positive moving it up,
   * and carries the up vector with it so the view does not roll.
   *
   * With a `duration` the swing plays at a constant rate over that many seconds.
   * It is a rotation and not a pose interpolation on purpose: a full circle
   * starts and ends at the same pose, so interpolating between the two would
   * not move the camera at all.
   *
   * Returns false, and does nothing, in a mode that owns the camera's
   * orientation (LVLH, chase, surface, instrument): there is no orbit to swing.
   */
  orbitTarget(axis: 'up' | 'right', radians: number, duration = 0): boolean {
    return this._startMove(axis === 'up' ? 'orbit-up' : 'orbit-right', radians, duration);
  }

  /**
   * Move the camera straight away from its orbit target by `distance` scene
   * units — toward it when negative — keeping its aim: Cosmographia's
   * `moveAwayFromCenter`. The mouse wheel's zoom, by an exact amount.
   *
   * It never passes through the target: a dolly in that would reach it stops
   * just short, and the zoom floor (a body's surface) still applies on the next
   * frame. Timing, refusal and cancellation are `orbitTarget`'s.
   */
  dolly(distance: number, duration = 0): boolean {
    return this._startMove('dolly', distance, duration);
  }

  /**
   * Raise the camera and the point it looks at together by `distance` scene
   * units along the view's up — lower them when negative — so the same view
   * slides up the screen: Cosmographia's `craneUp`. The Z / C keys' move, by
   * an exact amount.
   *
   * Free orbit pins the orbit target to a tracked object every frame, which
   * would turn a crane into a tilt; so, as Z / C do, a crane there releases
   * the tracked object — when it starts moving, not when it is asked for. A
   * crane queued behind a fly-to would otherwise see the fly-to's landing
   * track the body again, and every step after be undone. The co-rotating
   * frames keep tracking.
   */
  crane(distance: number, duration = 0): boolean {
    return this._startMove('crane', distance, duration);
  }

  /** Whether a scripted camera move (swing, dolly or crane) is still playing. */
  get moving(): boolean { return this._move !== null; }

  /**
   * Start a scripted move, replacing any still playing. Instant without a
   * duration; otherwise played at a constant rate. Either kind waits for a
   * fly-to in progress — its animation and the origin switch it lands with —
   * since the fly-to overwrites the camera every frame until then. Stopped by
   * `cancelAnimation`.
   */
  private _startMove(kind: CameraMoveKind, amount: number, duration: number): boolean {
    if (!this._activeMode.allowsOrbitControls) return false;
    this._move = null;
    const rate = duration > 0 ? amount / duration : null;
    if (rate === null && !this._flying) {
      this._applyMove(kind, amount);
    } else {
      this._move = { kind, remaining: amount, rate, lastMs: performance.now() };
    }
    return true;
  }

  /** A fly-to is still moving the camera, or has yet to land its origin switch. */
  private get _flying(): boolean {
    return this._anim !== null || this._pendingOriginSwitch !== null;
  }

  /**
   * Advance a scripted move by the wall-clock time since its last step.
   * Not the frame `dt`, which is capped: on a slow frame rate that would
   * stretch a 5-second move past the `wait` a script gave it. The last step
   * lands exactly.
   */
  private _stepMove(now: number): void {
    const move = this._move;
    if (!move) return;
    const elapsed = Math.max(now - move.lastMs, 0) / 1000;
    move.lastMs = now;
    let step = move.rate === null ? move.remaining : move.rate * elapsed;
    if (Math.abs(step) >= Math.abs(move.remaining)) {
      step = move.remaining;
      this._move = null;
    } else {
      move.remaining -= step;
    }
    // A dolly that reached the target has nowhere further to go.
    if (!this._applyMove(move.kind, step)) this._move = null;
  }

  /** Apply one step of a move. False when a dolly ran out of room. */
  private _applyMove(kind: CameraMoveKind, amount: number): boolean {
    switch (kind) {
      case 'orbit-up':
      case 'orbit-right':
        this._rotateAboutTarget(kind === 'orbit-up' ? 'up' : 'right', amount);
        return true;
      case 'dolly':
        return this._dollyBy(amount);
      case 'crane':
        if (this._activeMode.name === CameraModeName.FREE_ORBIT && this._trackTarget) {
          // Pin the target where tracking would have this frame before letting
          // go. Right after a fly-to lands it still holds the body's position
          // in the old origin's coordinates; tracking corrects that each frame,
          // and nothing will once it is released.
          this.controls.target.copy(this._trackTarget.position);
          this._trackTarget = null;
        }
        this._craneBy(amount);
        return true;
      default: {
        const unreachable: never = kind;
        throw new Error(`unknown camera move ${String(unreachable)}`);
      }
    }
  }

  private _rotateAboutTarget(axis: 'up' | 'right', radians: number): void {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const up = this.camera.up.clone().normalize();
    let pivot: THREE.Vector3;
    let angle: number;
    if (axis === 'up') {
      pivot = up;
      angle = radians;
    } else {
      pivot = this._viewRight(offset.clone().negate(), up);
      // Right-handed about the right axis tips the offset *down*; up is positive.
      angle = -radians;
    }
    const q = new THREE.Quaternion().setFromAxisAngle(pivot, angle);
    this.camera.position.copy(target).add(offset.applyQuaternion(q));
    if (axis === 'right') this.camera.up.applyQuaternion(q).normalize();
    this.camera.lookAt(target);
  }

  private _dollyBy(distance: number): boolean {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const current = offset.length();
    if (current < 1e-20) return false;
    // Stop short of the target rather than passing through it and flipping
    // the view round.
    const floor = current * 1e-6;
    const next = Math.max(current + distance, floor);
    this.camera.position.copy(target).addScaledVector(offset, next / current);
    return next > floor;
  }

  private _craneBy(distance: number): void {
    const target = this.controls.target;
    const forward = target.clone().sub(this.camera.position);
    const right = this._viewRight(forward, this.camera.up.clone().normalize());
    // The screen's up: square to the view direction, unlike `camera.up`,
    // which only has to be roughly upward.
    const screenUp = new THREE.Vector3().crossVectors(right, forward).normalize();
    this.camera.position.addScaledVector(screenUp, distance);
    target.addScaledVector(screenUp, distance);
  }

  /**
   * The view's right axis, from where the camera actually looks. Looking
   * straight along `up` leaves that undefined; the camera's own x axis is the
   * right axis of whatever it last rendered.
   */
  private _viewRight(forward: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
    const right = new THREE.Vector3().crossVectors(forward, up);
    if (right.lengthSq() < 1e-20) right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    return right.normalize();
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
    let minAltScene = Infinity;
    let nearestSurfaceR = 0;

    for (const bm of bodyMeshes) {
      const gt = bm.body.geometryType;
      if (gt !== 'Globe' && gt !== 'Ellipsoid') continue;
      const surfaceR = bm.displayRadius * scaleFactor;
      if (surfaceR < 1e-20) continue;
      const dist = this.camera.position.distanceTo(bm.position);
      const altitude = Math.max(dist - surfaceR, 0);
      const ratio = altitude / surfaceR;
      if (ratio < minAltRatio) minAltRatio = ratio;
      if (altitude < minAltScene) {
        minAltScene = altitude;
        nearestSurfaceR = surfaceR;
      }
    }

    // Pass altitude-above-nearest-Globe-surface to KeyboardControls so WASD
    // translation amount scales with altitude rather than dist-to-orbit-target
    // when close to a body. Without this, at 340 m above Mars the camera-to-
    // Mars-center distance (3400 km) drives WASD speed → kilometric per keypress
    // even when you're hovering meters above terrain.
    //
    // Floor at 0.0001 of the nearest body's surface radius so ground-level
    // WASD doesn't stall — at altitude=0, plain `altitude` gives speed=0 and
    // the user can't move at all. 0.0001×R scales naturally: Mars (3396 km)
    // → ~340 m floor; Moon (1737 km) → ~170 m; Earth (6378 km) → ~640 m;
    // asteroid (10 km) → ~1 m. translateSpeed (default 1.0) multiplies this
    // for the final per-second pace, so on Mars surface WASD walks at ~340 m/s
    // (Shift = 1.7 km/s, Alt = 68 m/s).
    if (isFinite(minAltScene)) {
      const surfaceFloor = nearestSurfaceR * 0.0001;
      this.keyboard.altitudeRefSceneUnits = Math.max(minAltScene, surfaceFloor);
    } else {
      this.keyboard.altitudeRefSceneUnits = null;
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
      // A move held behind the fly-to starts its clock when the fly-to lands.
      if (this._move) this._move.lastMs = now;
      return; // Animation takes priority over mode updates
    }

    // A scripted move (swing, dolly, crane), ahead of the mode update: in
    // body-fixed and SC-fixed frames the mode then carries the moved camera
    // with the body.
    // A fly-to's origin switch lands at the start of the renderer's next frame;
    // until it has, the move keeps holding, or the switch would re-track the
    // body and shift the camera under a move already applied.
    if (this._move) {
      if (!this._activeMode.allowsOrbitControls) this._move = null;
      else if (this._pendingOriginSwitch) this._move.lastMs = now;
      else this._stepMove(now);
    }

    // --- Non-FreeOrbit modes: delegate to active mode ---
    if (this._activeMode.name !== CameraModeName.FREE_ORBIT) {
      // Discard right-click drag — modes handle their own orientation via delta rotation.
      // Right-click in these modes would fight with the mode's target/quaternion control.
      this._rightDragDx = 0;
      this._rightDragDy = 0;

      // Orbit controls (before mode update so mode sees user-adjusted position)
      if (this._activeMode.allowsOrbitControls) {
        // The mode's body is what these controls orbit — the origin body
        // `setMode` put it at — not whatever free orbit last tracked.
        this._updateMinDistance(this._originBody ?? this._trackTarget);
        this._applyTouchPan();
        this.controls.update();
      } else {
        // The mode owns the camera; a two-finger drag is its own to interpret.
        this._touchPanDx = 0;
        this._touchPanDy = 0;
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

      // A look-at target overrides orientation here too, as it does in free
      // orbit below — but only in modes the user can orient. Instrument,
      // chase, LVLH and surface modes own the view direction; aiming them
      // elsewhere would break what the mode is for.
      if (this._lookAtTarget && this._activeMode.allowsOrbitControls) {
        this.camera.lookAt(this._lookAtTarget.position);
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

    // Tracking: lock orbit target to the tracked body. The body is normally at
    // (0,0,0) thanks to CRR origin-shifting, but surface-locked bodies may be
    // shifted off-origin by the renderer's terrain clamp — read bm.position
    // directly so the camera always looks at the body's rendered position.
    if (this._trackTarget) {
      this.controls.target.copy(this._trackTarget.position);
    }

    // Surface clamp via TrackballControls is camera-to-*target* distance, which
    // only equals camera-to-body-center when the target sits at the body.
    // - Tracking mode: target is at (0,0,0) = body center, so minDistance =
    //   body radius works perfectly. Use it; the built-in clamp is smoother
    //   than a per-frame position fixup.
    // - Free-look mode: target is offset away from the body. Setting minDistance
    //   to body-radius would lock zoom-in long before the camera reached the
    //   surface. Leave minDistance unconstrained and rely on the body-center
    //   guard at the end of update() to keep the camera from entering the body.
    this._updateMinDistance(this._trackTarget);
    const clampBody = this._trackTarget ?? this._originBody;

    // Mouse left-drag orbit + scroll zoom; one-finger orbit + pinch zoom
    this._applyTouchPan();
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

    // Surface guard: regardless of where the orbit target is, the camera must
    // never end up inside the focused body. Left-click rotation around an
    // offset target (after right-click free-look) can drive the camera through
    // the planet despite controls.minDistance, because that clamp is measured
    // to target, not to body center. Push the camera back along the radial
    // direction if it has crossed the surface.
    //
    // Skipped for bodies with terrain: the renderer's per-frame
    // `clampCameraAboveSurfaces` does a proper terrain sample and handles the
    // "below reference but above actual terrain" case (Jezero, Hellas, etc.)
    // that this static reference-radius guard would otherwise break.
    if (clampBody && !clampBody.hasTerrain) {
      const sf = clampBody.scaleFactor;
      const minR = clampBody.displayRadius * sf * 1.0001;
      const offset = this._tmpV1.subVectors(this.camera.position, clampBody.position);
      const dist = offset.length();
      if (dist > 0 && dist < minR) {
        offset.multiplyScalar(minR / dist);
        this.camera.position.copy(clampBody.position).add(offset);
        // Also nudge the orbit target out so subsequent rotations don't keep
        // pulling the camera back into the body.
        const targetOffset = this._tmpV2.subVectors(this.controls.target, clampBody.position);
        const targetDist = targetOffset.length();
        if (targetDist < minR) {
          if (targetDist > 1e-6) {
            targetOffset.multiplyScalar(minR / targetDist);
            this.controls.target.copy(clampBody.position).add(targetOffset);
          }
        }
      }
    }
  }

  /**
   * Apply an accumulated two-finger pan: move the camera and the orbit target
   * together in the camera's screen plane, scaled by the distance to the target,
   * which is what TrackballControls' own pan does.
   *
   * Panning while a body is tracked is undone the same frame — the tracked body
   * holds the orbit target — which is the point of tracking, not a gap here.
   */
  private _applyTouchPan(): void {
    const dx = this._touchPanDx;
    const dy = this._touchPanDy;
    this._touchPanDx = 0;
    this._touchPanDy = 0;
    if (dx === 0 && dy === 0) return;

    const el = this._domElement;
    if (!el.clientWidth || !el.clientHeight) return;

    const eye = this._tmpV1.subVectors(this.camera.position, this.controls.target);
    const reach = eye.length() * this.controls.panSpeed;
    if (reach === 0) return;

    const pan = this._tmpV2.crossVectors(eye, this.camera.up);
    // Degenerate only when the view direction and up are parallel, which
    // TrackballControls' own gimbal handling already avoids.
    if (pan.lengthSq() > 0) pan.setLength((dx / el.clientWidth) * reach);
    pan.addScaledVector(this.camera.up, (dy / el.clientHeight) * reach);

    this.camera.position.add(pan);
    this.controls.target.add(pan);
  }

  private readonly _tmpV1 = new THREE.Vector3();
  private readonly _tmpV2 = new THREE.Vector3();

  dispose(): void {
    this._anim = null;
    this._viewpoints.clear();
    this.keyboard.dispose();
    this.controls.dispose();

    this._detachPointerInput();
    this._domElement.removeEventListener('wheel', this._onWheel, { capture: true });
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
