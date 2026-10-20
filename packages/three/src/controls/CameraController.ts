import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { KeyboardControls } from './KeyboardControls.js';
import { attachPointerInput } from './PointerInput.js';
import type { KeyboardControlsConfig } from './KeyboardControls.js';
import type { BodyMesh } from '../BodyMesh.js';
import type { ViewpointDefinition } from '@cosmolabe/core';
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
import { surfaceEntryPose } from './surfaceEntry.js';

/** A camera pose in scene coordinates. */
export interface ViewpointPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
}

/** A saved camera viewpoint (position + target in scene coordinates) */
export interface CameraViewpoint extends ViewpointPose {
  name: string;
  /** If set, camera tracks this body name */
  trackBody?: string;
  /** The body the pose's coordinates are relative to (null: the universe
   *  origin). Defaults to `trackBody`. A view saved after un-tracking keeps
   *  the origin it was taken in. */
  originBody?: string | null;
  /** If set, the camera keeps facing this body while tracking `trackBody`. */
  lookAtBody?: string;
  /** Vertical field of view in degrees, when the viewpoint sets one. */
  fov?: number;
  /**
   * If set, the moment this viewpoint depicts, in ephemeris seconds past J2000
   * (a catalog Viewpoint's `time`, already resolved). Applying the viewpoint
   * seeks the clock to it; a viewpoint that leaves this undefined leaves the
   * clock where it is.
   */
  epoch?: number;
  /** The semantic definition this viewpoint was built from (catalog
   *  viewpoints), for consumers that serialize or inspect it. */
  definition?: ViewpointDefinition;
  /** Re-derive the pose at an epoch. Catalog viewpoints carry one; the stored
   *  pose is then only the pose at the epoch the viewpoint was registered. */
  resolve?: (et: number) => ViewpointPose;
}

/** The scripted camera moves `orbitTarget`, `dolly` and `crane` start. */
type CameraMoveKind = 'orbit-up' | 'orbit-right' | 'dolly' | 'crane';

/**
 * How `flyTo` travels to its destination.
 *
 * - `'direct'` closes on the destination along a straight line.
 * - `'overview'` first pulls back far enough to show where the camera is
 *   looking and the destination side by side, then approaches. Across an
 *   astronomical change of scale a direct move shows nothing but a blur; the
 *   pull-back is what says where the destination is. When the camera is
 *   already that far back there is nothing to establish, and an overview
 *   flight is a direct one.
 */
export type FlightPath = 'direct' | 'overview';

export interface FlyToOptions {
  /**
   * Animation duration in seconds: 1 for a direct flight, 2.5 in all for an
   * overview flight's pull-back and approach together.
   */
  duration?: number;
  /**
   * Land this many display radii from the body's centre, rather than at the
   * distance that fits it in view (`framingDistance`).
   */
  distanceMultiplier?: number;
  /** Scale factor for converting body radius to scene units */
  scaleFactor?: number;
  /** Which way to travel (default: `'direct'`). */
  path?: FlightPath;
  /**
   * Where to land relative to the body's centre, in scene units in the body's
   * mesh frame, so the pose turns with the body during the flight. Overrides
   * `distanceMultiplier`; the camera then looks at the body's centre.
   */
  offset?: THREE.Vector3;
  /** Camera up on landing, in the body's mesh frame. Defaults to the current up. */
  up?: THREE.Vector3;
}

/** A camera flight in progress, as `CameraController.flight` reports it. */
export interface CameraFlight {
  /** The body the flight lands on; null for a flight to a saved viewpoint. */
  readonly destination: BodyMesh | null;
  readonly path: FlightPath;
  /** `'overview'` while an overview flight pulls back, `'approach'` after. */
  readonly phase: 'overview' | 'approach';
}

/** Fraction of an overview flight's duration spent pulling back. */
const OVERVIEW_PULLBACK_SHARE = 0.4;
const DEFAULT_DIRECT_SECONDS = 1.0;
const DEFAULT_OVERVIEW_SECONDS = 2.5;
/**
 * Pointer travel, in CSS pixels, that counts as navigating rather than a click.
 * A click that lands while a flight plays (selecting a body, say) must not stop
 * it; a drag must.
 */
const MANUAL_DRAG_THRESHOLD_PX = 3;

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
    return this._anim?.destination ?? this._anim?.followBody ?? this._pendingOriginSwitch ?? this._trackTarget;
  }

  /**
   * The flight playing, or null when the camera is not being flown: a fly-to,
   * or an animated move to a saved viewpoint. A scripted swing, dolly or crane
   * is not a flight.
   */
  get flight(): CameraFlight | null {
    const anim = this._anim;
    if (!anim) return null;
    return { destination: anim.destination ?? null, path: anim.path ?? 'direct', phase: anim.phase ?? 'approach' };
  }

  /**
   * The body used as the coordinate-system origin for rendering.
   * Set when tracking starts. Persists after un-tracking so the scene
   * doesn't jump. Only changes when a new body is tracked.
   */
  private _originBody: BodyMesh | null = null;
  get originBody(): BodyMesh | null { return this._originBody; }

  /** Restore an explicit coordinate origin, without changing navigation. */
  setOriginBody(body: BodyMesh | null): void {
    this.cancelAnimation();
    this._pendingOriginSwitch = null;
    this._originBody = body;
  }

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
    /** The body this flight lands on, through every phase of it. */
    destination?: BodyMesh;
    path?: FlightPath;
    phase?: 'overview' | 'approach';
    /** Landing pose in the followed body's mesh frame (`FlyToOptions.offset`/`up`). */
    followOffset?: THREE.Vector3;
    followUp?: THREE.Vector3;
  } | null = null;
  private _lastAnimMs = 0;

  /**
   * Navigation input from the person since the last `update()`: a drag past
   * the click threshold, a wheel zoom, a pinch. Keyboard navigation is read off
   * `keyboard` directly.
   */
  private _manualInput = false;
  /** Pointer travel since the current press began, toward the drag threshold. */
  private _pressTravelPx = 0;

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
  /** The body the active mode was set on (`CameraModeParams.bodyName`). */
  private _modeBodyName: string | undefined;
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
        this._pressTravelPx = 0;
        if (e.button !== 2) return;
        e.stopPropagation();
        this._rightDragging = true;
      },
      onButtonDrag: (dx, dy) => {
        this._notePressTravel(dx, dy);
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
        this._manualInput = true;
        this._touchPanDx += dx;
        this._touchPanDy += dy;
      },
      onDrag: (dx, dy) => this._notePressTravel(dx, dy),
      onCountChange: () => { this._pressTravelPx = 0; },
    });

    // Shift + wheel adjusts FOV instead of zooming. Capture phase to intercept
    // before TrackballControls's wheel handler so it doesn't also dolly the camera.
    this._onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) {
        // A plain wheel zooms — navigation. Shift+wheel changes the field of
        // view, which no flight touches, so it does not interrupt one.
        this._manualInput = true;
        return;
      }
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

  // ── Navigation: focus, frame, fly ──
  //
  // The camera-side half of the viewer's navigation vocabulary (docs/navigation.md).
  // Each takes a body whose `position` is current in the camera's coordinates —
  // relative to `originBody` at the present time — which is what a renderer's
  // last frame gives, and what `UniverseRenderer.refreshBodyPose` restores
  // between frames.

  /**
   * The distance from `bodyMesh`'s centre at which it comfortably fills the
   * view: its bounding sphere, padded, inside the narrower of the two fields of
   * view. At a 60° vertical field of view in a landscape viewport that is three
   * radii, the distance every fly-to used before it was fitted to the view; a
   * portrait viewport stands further back, so the body still fits across.
   */
  framingDistance(bodyMesh: BodyMesh, scaleFactor = 1e-6): number {
    const radius = bodyMesh.displayRadius * scaleFactor;
    const halfV = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfH = Math.atan(Math.tan(halfV) * (this.camera.aspect || 1));
    return (radius * CameraController.FRAME_PADDING) / Math.sin(Math.min(halfV, halfH));
  }

  /** Bounding-sphere padding `framingDistance` fits. */
  static readonly FRAME_PADDING = 1.5;

  /**
   * Focus: make `bodyMesh` the camera's anchor — the body it orbits, and the
   * origin the scene is drawn around — without relocating the camera. The
   * camera stays where it is and turns to face the body.
   *
   * Ends any flight or scripted move, and any look-at. A body-fixed or
   * SC-fixed frame moves onto the body, as switching frames would. A frame
   * that places the camera itself (LVLH, chase, surface, instrument) is left
   * as it is, pose and all, when it is set on this very body, or on none;
   * otherwise the camera returns to free orbit where it is.
   */
  focus(bodyMesh: BodyMesh): void {
    this._beginNavigation();
    if (this._frameOwnsCamera) {
      // A frame that places the camera itself, set on this very body (or on
      // none, as instrument), keeps it and the pose it has made: only the
      // anchor changes. Reactivating would reset its state, and aiming the
      // camera at the body's centre would undo its view. Set on anything
      // else — another body, or the planet this spacecraft orbits — it would
      // move the camera, which focusing does not do.
      const mode = this._activeMode.name;
      if (mode === CameraModeName.INSTRUMENT || bodyMesh.body.name === this._modeBodyName) {
        this._trackTarget = bodyMesh;
        return;
      }
      this.setMode(CameraModeName.FREE_ORBIT);
    }
    const center = this._rebaseOnto(bodyMesh);
    this._anchorOn(bodyMesh, center);
  }

  /**
   * Frame: cut to a view that fits `bodyMesh`, and focus it. The camera keeps
   * the side it sees the body from and moves along that line to
   * `framingDistance` (or `distanceMultiplier` display radii) — the pose a
   * direct `flyTo` lands on, without the flight. A frame that places the
   * camera itself is left for free orbit; a body-fixed or SC-fixed one moves
   * onto the body.
   */
  frame(bodyMesh: BodyMesh, opts: { scaleFactor?: number; distanceMultiplier?: number } = {}): void {
    this._beginNavigation();
    // A frame that places the camera itself would take it straight back.
    if (this._frameOwnsCamera) this.setMode(CameraModeName.FREE_ORBIT);
    const dir = this._approachDirection(bodyMesh);
    const dist = this._arrivalDistance(bodyMesh, opts);
    const center = this._rebaseOnto(bodyMesh);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this._anchorOn(bodyMesh, center);
  }

  /** @deprecated Use `frame`, which this is. */
  zoomTo(bodyMesh: BodyMesh, scaleFactor: number): void {
    this.frame(bodyMesh, { scaleFactor });
  }

  /**
   * Fly: animate the camera to the pose `frame` would cut to, then focus the
   * body. The endpoints follow the body while it moves, and the origin switches
   * to it once the camera lands.
   *
   * With `path: 'overview'` the flight first pulls back to show the point the
   * camera is looking at and the destination together, then approaches the
   * destination from there; see `FlightPath`.
   *
   * A frame that places the camera itself is left for free orbit as the
   * flight starts; a body-fixed or SC-fixed one moves onto the body when it
   * lands, or is stopped.
   *
   * The flight owns the camera until it lands. Navigation input from the
   * person — a drag, a wheel zoom, a pinch, a movement key — stops it where it
   * is, as `stopFlight` does, and the input then applies. Nothing else is
   * waiting for the two to agree.
   */
  flyTo(bodyMesh: BodyMesh, opts?: FlyToOptions): void {
    const path = opts?.path ?? 'direct';
    const dist = this._arrivalDistance(bodyMesh, opts ?? {});

    // Disable tracking during animation so the orbit target can animate
    // freely (tracking resets it to origin each frame). A landing still to be
    // applied belongs to a flight this one replaces; applied later, it would
    // move the camera's coordinates out from under this one.
    this._trackTarget = null;
    this._pendingOriginSwitch = null;
    // A look-at would override the view the flight lands on.
    this.clearLookAt();
    // A frame that places the camera itself would take it back from where the
    // flight lands; the flight starts in free orbit instead. It keeps its roll
    // and turns to free orbit's up on the way.
    const up = this.camera.up.clone();
    if (this._frameOwnsCamera) {
      const startUp = up.clone();
      this.setMode(CameraModeName.FREE_ORBIT);
      up.copy(this.camera.up);
      this.camera.up.copy(startUp);
    }

    if (path === 'overview') {
      const overview = this._overviewPose(bodyMesh);
      if (overview) {
        const total = opts?.duration ?? DEFAULT_OVERVIEW_SECONDS;
        const pullback = this._startAnimation(
          overview.position, overview.target, up, total * OVERVIEW_PULLBACK_SHARE,
          () => this._startApproach(bodyMesh, dist, up, total * (1 - OVERVIEW_PULLBACK_SHARE), 'overview', opts),
        );
        pullback.destination = bodyMesh;
        pullback.path = 'overview';
        pullback.phase = 'overview';
        return;
      }
    }
    this._startApproach(bodyMesh, dist, up, opts?.duration ?? DEFAULT_DIRECT_SECONDS, path, opts);
  }

  /**
   * Stop the flight playing where it is. The camera keeps its position, and a
   * flight toward a body leaves that body focused, as though it had been
   * focused from here — so the camera turns to face it: the flight's intent
   * was that body, so the camera anchors on it rather than on nothing. Also drops any scripted move queued
   * behind the flight. False when nothing was flying.
   */
  stopFlight(): boolean {
    const anim = this._anim;
    if (!anim) return false;
    this.cancelAnimation();
    if (anim.destination) this._pendingOriginSwitch = anim.destination;
    return true;
  }

  private _startApproach(
    bodyMesh: BodyMesh, dist: number, up: THREE.Vector3, duration: number, path: FlightPath,
    landing?: Pick<FlyToOptions, 'offset' | 'up'>,
  ): void {
    // Approach from the camera's current side of the body.
    const dir = this._approachDirection(bodyMesh);
    const bodyPos = bodyMesh.position;
    const anim = this._startAnimation(
      bodyPos.clone().addScaledVector(dir, dist), bodyPos.clone(), up.clone(), duration,
      () => {
        // Defer origin switch to next frame — if we switch now, body positions
        // (already computed this frame with the old origin) won't match the
        // camera's new coordinates, causing a one-frame flash.
        this._pendingOriginSwitch = bodyMesh;
      },
    );
    // Track the body each frame so endpoints follow its motion
    anim.followBody = bodyMesh;
    anim.followDist = dist;
    anim.followDir = dir;
    anim.destination = bodyMesh;
    anim.path = path;
    anim.phase = 'approach';
    if (landing?.offset) {
      anim.followOffset = landing.offset.clone();
      anim.followUp = landing.up?.clone();
    }
  }

  /**
   * Where an overview flight pulls back to: far enough out that the point the
   * camera looks at and the destination both sit inside the narrower field of
   * view, looking at the midpoint between them from the side, so neither hides
   * behind the other. Null when the camera is already at least that far out —
   * then there is nothing for a pull-back to establish.
   */
  private _overviewPose(bodyMesh: BodyMesh): { position: THREE.Vector3; target: THREE.Vector3 } | null {
    const source = this.controls.target;
    const dest = bodyMesh.position;
    const axis = new THREE.Vector3().subVectors(dest, source);
    const span = axis.length();
    if (!(span > 0)) return null;
    axis.divideScalar(span);

    const halfV = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfH = Math.atan(Math.tan(halfV) * (this.camera.aspect || 1));
    const reach = ((span / 2) * CameraController.FRAME_PADDING) / Math.sin(Math.min(halfV, halfH));
    const mid = new THREE.Vector3().addVectors(source, dest).multiplyScalar(0.5);
    if (this.camera.position.distanceTo(mid) >= reach) return null;

    // Keep the side the camera is on, minus any component along the line
    // between the two; with nothing left, any direction square to it will do.
    const back = new THREE.Vector3().subVectors(this.camera.position, source);
    back.addScaledVector(axis, -back.dot(axis));
    if (back.lengthSq() < 1e-12 * span * span) {
      back.crossVectors(axis, this.camera.up);
      if (back.lengthSq() < 1e-12) back.crossVectors(axis, new THREE.Vector3(1, 0, 0));
      if (back.lengthSq() < 1e-12) back.crossVectors(axis, new THREE.Vector3(0, 1, 0));
    }
    back.normalize();
    return { position: mid.clone().addScaledVector(back, reach), target: mid };
  }

  /** Unit vector from `bodyMesh` toward the camera: the side the camera sees it from. */
  private _approachDirection(bodyMesh: BodyMesh): THREE.Vector3 {
    const dir = this.camera.position.clone().sub(bodyMesh.position);
    if (dir.lengthSq() < 1e-20) dir.set(0, 0.3, 1);
    return dir.normalize();
  }

  private _arrivalDistance(bodyMesh: BodyMesh, opts: { scaleFactor?: number; distanceMultiplier?: number }): number {
    const sf = opts.scaleFactor ?? 1e-6;
    return opts.distanceMultiplier !== undefined
      ? bodyMesh.displayRadius * sf * opts.distanceMultiplier
      : this.framingDistance(bodyMesh, sf);
  }

  /** A cut navigation takes the camera over: nothing still in flight, no look-at. */
  private _beginNavigation(): void {
    this.cancelAnimation();
    this._pendingOriginSwitch = null;
    this.clearLookAt();
  }

  /**
   * Move the scene origin to `bodyMesh`, carrying the camera and its target into
   * the new coordinates so neither moves in space. Returns where the body sits
   * under the new origin: the origin itself, unless it already was the origin —
   * a surface-locked body is drawn off it — in which case nothing shifts.
   */
  private _rebaseOnto(bodyMesh: BodyMesh): THREE.Vector3 {
    if (this._originBody === bodyMesh) return bodyMesh.position.clone();
    const offset = bodyMesh.position.clone();
    this.camera.position.sub(offset);
    this.controls.target.sub(offset);
    this._originBody = bodyMesh;
    return new THREE.Vector3();
  }

  /** Orbit-lock to `bodyMesh` at `center`, carrying an orbit frame over to it. */
  private _anchorOn(bodyMesh: BodyMesh, center: THREE.Vector3): void {
    this._trackTarget = bodyMesh;
    this.controls.target.copy(center);
    this._prevTargetPos.copy(center);
    this.camera.lookAt(center);
    this._carryOrbitFrameTo(bodyMesh);
  }

  /**
   * Whether the active frame places the camera itself — LVLH, chase, surface,
   * surface explorer, instrument — rather than leaving the pose to the person,
   * as free orbit, body-fixed and SC-fixed do.
   */
  private get _frameOwnsCamera(): boolean {
    return !this._activeMode.allowsOrbitControls;
  }

  /**
   * The body `setModeForBody(mode, bodyMesh)` sets `mode` on: the spacecraft
   * for the spacecraft frames, the body it orbits for the planet frames, and
   * none for free orbit and instrument.
   */
  private _modeSubjectFor(mode: CameraModeName, bodyMesh: BodyMesh): string | undefined {
    const body = bodyMesh.body;
    switch (mode) {
      case CameraModeName.SC_FIXED:
      case CameraModeName.LVLH:
      case CameraModeName.CHASE:
        return body.name;
      case CameraModeName.BODY_FIXED:
      case CameraModeName.SURFACE:
      case CameraModeName.SURFACE_EXPLORER:
        return body.classification === 'spacecraft' ? (body.parentName ?? '') : body.name;
      default:
        return undefined;
    }
  }

  /**
   * Move a body-fixed or SC-fixed frame onto `bodyMesh`, the body navigation
   * has just anchored on, as switching frames would — unless it is on that
   * body already, when reactivating would only re-baseline it. The camera
   * stays where it is in space.
   */
  private _carryOrbitFrameTo(bodyMesh: BodyMesh): void {
    const mode = this._activeMode.name;
    if (mode === CameraModeName.FREE_ORBIT || this._frameOwnsCamera) return;
    if (this._modeSubjectFor(mode, bodyMesh) === this._modeBodyName) return;
    // Mode.activate() only reads body rotation (not position), so it is safe
    // before the renderer's next frame recomputes positions under this origin.
    // setMode puts the origin on the frame's body — the planet, for a
    // body-fixed frame on a spacecraft — and carries the camera with it.
    this.setModeForBody(mode, bodyMesh);
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

  /** Animate camera to a saved viewpoint by name, at its stored pose */
  goToViewpoint(name: string, duration = 1.0): boolean {
    const vp = this._viewpoints.get(name);
    if (!vp) return false;
    this.flyToViewpoint(vp, duration);
    return true;
  }

  /** Animate camera to a viewpoint's pose */
  flyToViewpoint(vp: ViewpointPose, duration = 1.0): void {
    this._startAnimation(
      vp.position.clone(), vp.target.clone(), vp.up.clone(), duration,
    );
  }

  /** Apply a viewpoint immediately (no animation) */
  applyViewpoint(vp: ViewpointPose): void {
    this.cancelAnimation();
    this.camera.position.copy(vp.position);
    this.controls.target.copy(vp.target);
    this.camera.up.copy(vp.up);
  }

  /**
   * Establish a viewpoint: the whole view, not a pose laid over whatever
   * navigation left behind. Ends any flight, scripted move or look-at, returns
   * to free orbit, puts the scene origin on `origin` (null: the universe
   * origin) — the coordinates the pose is in — and applies the pose. Then
   * orbit-locks `track` and faces `lookAt` when given.
   *
   * Free orbit because the other frames would not keep the pose: LVLH, chase,
   * surface and instrument place the camera themselves on their next update,
   * and body-fixed or SC-fixed would carry a pose stated in scene axes round
   * with their body as time runs.
   *
   * With `duration`, the camera flies to the pose instead of cutting, but only
   * when the origin stays where it is and nothing is tracked: a flight between
   * two origins' coordinates would pass through neither.
   */
  establishView(
    pose: ViewpointPose,
    opts: { origin: BodyMesh | null; track?: BodyMesh | null; lookAt?: BodyMesh | null; duration?: number },
  ): void {
    this._beginNavigation();
    if (this._activeMode.name !== CameraModeName.FREE_ORBIT) this.setMode(CameraModeName.FREE_ORBIT);
    const sameOrigin = this._originBody === opts.origin;
    this._originBody = opts.origin;
    this._trackTarget = opts.track ?? null;
    this._lookAtTarget = opts.lookAt ?? null;
    if (opts.duration && sameOrigin && !opts.track && !opts.lookAt) {
      this._startAnimation(pose.position.clone(), pose.target.clone(), pose.up.clone(), opts.duration);
      return;
    }
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    this.camera.up.copy(pose.up);
    this._prevTargetPos.copy(pose.target);
    this.camera.lookAt(pose.target);
  }

  /** Save current camera state as a named viewpoint */
  saveViewpoint(name: string): CameraViewpoint {
    const vp: CameraViewpoint = {
      name,
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      up: this.camera.up.clone(),
      trackBody: this._trackTarget?.body.name,
      // The pose is in the origin body's coordinates, which outlive tracking.
      originBody: this._originBody?.body.name ?? null,
      // Without these a restored look-at view would orbit-lock back onto the
      // tracked body, and a zoomed view would come back at whatever FOV is set.
      lookAtBody: this._lookAtTarget?.body.name,
      fov: this.camera.fov,
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
   *
   * The camera stays where it is in space unless the new mode places it
   * itself. When the mode moves the scene origin onto its body, the camera
   * and orbit target are carried into those coordinates. Leaving a mode that
   * placed the camera (surface, chase, LVLH, instrument) for one the person
   * orbits in keeps the view as it was: the orbit target is put on the line
   * of sight and `up` is the screen's up, so the next `controls.update()`
   * does not turn the camera, and free orbit lets go of a tracked body the
   * view is no longer centred on rather than swinging round to face it.
   *
   * SURFACE and SURFACE_EXPLORER given a body but no `latDeg`/`lonDeg` enter
   * at the pose `surfaceEntryPose` infers from the current view — the region
   * looked at, at a practical height, heading where the view was heading —
   * never at 0°, 0° by default. A given coordinate, 0°, 0° included, is used
   * as it is.
   */
  setMode(modeName: CameraModeName, params: CameraModeParams = {}): boolean {
    const newMode = this._modes.get(modeName);
    if (!newMode) return false;
    const leaving = this._activeMode;
    const ctx = this._modeCtx;

    // Infer a surface entry before anything moves: it reads the view as it is.
    if ((modeName === CameraModeName.SURFACE || modeName === CameraModeName.SURFACE_EXPLORER)
      && params.bodyName && ctx && (params.latDeg === undefined || params.lonDeg === undefined)) {
      const bm = ctx.bodyMeshes.get(params.bodyName);
      const pick = ctx.pickSurface;
      const entry = bm && surfaceEntryPose(
        bm, this.camera, ctx.scaleFactor,
        modeName === CameraModeName.SURFACE ? 'flight' : 'explorer',
        pick ? () => pick(0, 0) : undefined,
      );
      if (entry) {
        params = {
          ...params,
          latDeg: entry.latDeg,
          lonDeg: entry.lonDeg,
          altKm: params.altKm ?? entry.altKm,
          headingDeg: params.headingDeg ?? entry.headingDeg,
          pitchDeg: params.pitchDeg ?? entry.pitchDeg,
        };
      }
    }

    // Deactivate current mode
    if (ctx) leaving.deactivate(ctx);

    // Restore TrackballControls damping when leaving a non-FreeOrbit mode
    if (leaving.name !== CameraModeName.FREE_ORBIT) {
      this.controls.staticMoving = false;
      this.controls.dynamicDampingFactor = 0.15;
    }

    if (newMode.allowsOrbitControls && newMode !== leaving) {
      if (!leaving.allowsOrbitControls) this._targetLineOfSight(this._modeBodyName);
      // Modes may leave camera.up anywhere (a surface normal, a co-rotated
      // up). The screen's up is the same view with an up square to the line
      // of sight, which TrackballControls handles without a roll or snap.
      this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
      if (modeName === CameraModeName.FREE_ORBIT && this._trackTarget) {
        const reach = Math.max(this.camera.position.distanceTo(this.controls.target), 1e-20);
        if (this.controls.target.distanceTo(this._trackTarget.position) > 1e-6 * reach) this._trackTarget = null;
      }
    }

    this._activeMode = newMode;
    this._modeBodyName = params.bodyName;

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
    const prevOrigin = this._originBody;
    if (params.bodyName && ctx) {
      const targetBm = ctx.bodyMeshes.get(params.bodyName);
      if (targetBm) {
        this._originBody = targetBm;
      }
    }

    // Activate new mode with context. Body positions are still the last
    // frame's, under the previous origin, and so is the camera: a mode that
    // places the camera places it in those coordinates.
    if (ctx) {
      newMode.activate(ctx, params);
    }

    // Then carry the camera into the new origin's coordinates. Every body
    // position is still in one frame, so the difference between the two
    // origins is the shift; the renderer's next frame puts the bodies there.
    const origin = this._originBody;
    if (origin && origin !== prevOrigin) {
      const shift = origin.position.clone();
      if (prevOrigin) shift.sub(prevOrigin.position);
      this.camera.position.sub(shift);
      this.controls.target.sub(shift);
      this._prevTargetPos.sub(shift);
    }

    return true;
  }

  /**
   * Put the orbit target on the camera's line of sight, so orbiting resumes
   * around what is in the middle of the view without turning the camera: where
   * the line of sight meets `bodyName`'s surface, or as far ahead as the body's
   * centre when it misses.
   */
  private _targetLineOfSight(bodyName: string | undefined): void {
    const bm = bodyName ? this._modeCtx?.bodyMeshes.get(bodyName) : undefined;
    const forward = this.camera.getWorldDirection(this._tmpV1);
    let reach = this.camera.position.distanceTo(this.controls.target);
    if (bm) {
      const toCenter = this._tmpV2.subVectors(bm.position, this.camera.position);
      const along = toCenter.dot(forward);
      const radius = bm.displayRadius * bm.scaleFactor;
      const miss2 = toCenter.lengthSq() - along * along;
      const hit = along - Math.sqrt(Math.max(radius * radius - miss2, 0));
      reach = along > 0 && miss2 <= radius * radius && hit > 0 ? hit : toCenter.length();
    }
    if (!(reach > 0)) reach = 1;
    this.controls.target.copy(this.camera.position).addScaledVector(forward, reach);
    this._prevTargetPos.copy(this.controls.target);
  }

  /**
   * Set camera mode with automatic body-name resolution.
   * For spacecraft targets, resolves the appropriate body for each mode:
   * - SC_FIXED/LVLH/CHASE: uses the spacecraft itself
   * - BODY_FIXED/SURFACE: uses the parent celestial body (planet/moon)
   * - INSTRUMENT: activates the specified sensor
   *
   * Surface modes enter where the current view is looking (see `setMode`).
   * A mode that needs a body returns false, changing nothing, when there is
   * none; `modeSubject` is the body a mode change normally applies to.
   *
   * @param modeName The camera mode to switch to
   * @param bodyMesh The body to target (usually `modeSubject`)
   * @param opts Extra options (sensorName for instrument mode)
   */
  setModeForBody(
    modeName: CameraModeName,
    bodyMesh: BodyMesh | null,
    opts?: { sensorName?: string },
  ): boolean {
    if (modeName === CameraModeName.FREE_ORBIT) return this.setMode(CameraModeName.FREE_ORBIT);
    if (modeName === CameraModeName.INSTRUMENT) {
      return this.setMode(CameraModeName.INSTRUMENT, { sensorName: opts?.sensorName ?? '' });
    }
    if (!bodyMesh) return false;

    const body = bodyMesh.body;
    const isSC = body.classification === 'spacecraft';
    const parentName = body.parentName ?? '';
    const celestialBody = isSC ? parentName : body.name;

    switch (modeName) {
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
        if (!celestialBody) return false;
        return this.setMode(CameraModeName.SURFACE, {
          bodyName: celestialBody,
          lookTarget: isSC ? body.name : undefined,
        });
      case CameraModeName.SURFACE_EXPLORER:
        if (!celestialBody) return false;
        return this.setMode(CameraModeName.SURFACE_EXPLORER, { bodyName: celestialBody });
      default:
        return this.setMode(modeName);
    }
  }

  /**
   * Track a body and frame it, keeping the current camera mode.
   * @deprecated Use `frame`, which this is; `focus` tracks without moving.
   */
  trackBody(bodyMesh: BodyMesh, scaleFactor: number): void {
    this.frame(bodyMesh, { scaleFactor });
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
    this.setModeForBody(nextMode, this.modeSubject);
    return nextMode;
  }

  /**
   * The body a mode change applies to: the tracked body, or — when the
   * camera has let go of it (a free look, a WASD move, leaving a surface
   * view) — the origin body, the body the camera was last anchored on and is
   * still drawn around. Focusing another body moves both. Every mode-change
   * entry point (the `M` cycle, a mode menu) should use this, so they agree.
   */
  get modeSubject(): BodyMesh | null {
    return this._trackTarget ?? this._originBody;
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
    // The target moves into the new coordinates with the camera. `bodyPos` is
    // still the body's position in the OLD origin's coordinates (the renderer
    // recomputes positions after this), so copying it would leave the target
    // there: free-orbit tracking repairs that later in the frame, but a
    // scripted move queued behind the fly-to steps before it does, and the
    // co-rotating modes never repair it at all. Under the new origin the body
    // sits at the origin, which is where `trackBody` puts the target too.
    if (wasAlreadyOrigin) {
      this.controls.target.copy(bodyPos);
    } else {
      this.camera.position.sub(bodyPos);
      this.controls.target.set(0, 0, 0);
    }
    // A body-fixed or SC-fixed frame lands on the body too, as focusing it
    // would put it there; left on the body the flight left, it would carry
    // the camera around that one.
    this._carryOrbitFrameTo(body);

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

  /** Pointer travel toward the drag threshold; past it, the press is navigation. */
  private _notePressTravel(dx: number, dy: number): void {
    this._pressTravelPx += Math.abs(dx) + Math.abs(dy);
    if (this._pressTravelPx > MANUAL_DRAG_THRESHOLD_PX) this._manualInput = true;
  }

  /**
   * Hand the camera back to the person: stop a flight as `stopFlight` does,
   * and any scripted move. Unlike `cancelAnimation` it keeps the input the
   * controls have gathered, which is the drag or zoom that asked for this.
   */
  private _yieldToManualInput(): void {
    const destination = this._anim?.destination;
    this._anim = null;
    this._move = null;
    // Inertia from before the flight is not the person's input now.
    (this.controls as unknown as { _lastAngle: number })._lastAngle = 0;
    if (destination) this._pendingOriginSwitch = destination;
  }

  /** Whether a fly-to/viewpoint animation is currently playing */
  get animating(): boolean { return this._anim !== null; }

  /** Cancel any in-progress camera animation, a scripted camera move included */
  cancelAnimation(): void {
    this._anim = null;
    this._move = null;
    // A cut/restored pose must not inherit the previous gesture's inertia.
    // TrackballControls exposes no public method to clear damping independently
    // of resetting the camera, so use the same internals as animation completion.
    const controls = this.controls as unknown as {
      _lastAngle: number;
      _movePrev: THREE.Vector2; _moveCurr: THREE.Vector2;
      _zoomStart: THREE.Vector2; _zoomEnd: THREE.Vector2;
      _panStart: THREE.Vector2; _panEnd: THREE.Vector2;
    };
    controls._lastAngle = 0;
    controls._movePrev.copy(controls._moveCurr);
    controls._zoomStart.copy(controls._zoomEnd);
    controls._panStart.copy(controls._panEnd);
    this._rightDragDx = this._rightDragDy = 0;
    this._touchPanDx = this._touchPanDy = 0;
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

    // Manual navigation outranks automatic motion: a flight or a scripted move
    // stops where it is and the person's input applies, this frame. Two
    // controllers taking turns with the camera is the alternative.
    const manual = this._manualInput || this.keyboard.navigating;
    this._manualInput = false;
    if (manual && (this._anim || this._move)) this._yieldToManualInput();

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
        if (this._anim.followOffset) {
          const q = this._anim.followBody.mesh.quaternion;
          this._anim.endPos.copy(this._anim.followOffset).applyQuaternion(q).add(bodyPos);
          if (this._anim.followUp) this._anim.endUp.copy(this._anim.followUp).applyQuaternion(q);
        }
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
      // Orbit controls (before mode update so mode sees user-adjusted position)
      if (this._activeMode.allowsOrbitControls) {
        // Right-drag free look in body-fixed and SC-fixed: turn the view in
        // place, as free orbit does, but keep the frame and its body. The mode
        // then co-rotates the new target, orientation and up with the frame,
        // so the look holds as time runs.
        this._applyFreeLook();
        // The mode's body is what these controls orbit — the origin body
        // `setMode` put it at — not whatever free orbit last tracked. Its
        // surface is a floor on the distance to the target only while the
        // target is its centre; after a free look, or coming back from a
        // surface view, the target is elsewhere and the renderer's surface
        // clamp is the floor, as in free orbit.
        const pivot = this._originBody ?? this._trackTarget;
        const reach = Math.max(this.camera.position.distanceTo(this.controls.target), 1e-20);
        this._updateMinDistance(pivot && this.controls.target.distanceTo(pivot.position) <= 1e-6 * reach ? pivot : null);
        this._applyTouchPan();
        this.controls.update();
      } else {
        // The mode owns the camera, orientation included; a right-drag or a
        // two-finger drag is its own to interpret.
        this._rightDragDx = 0;
        this._rightDragDy = 0;
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

    // Right-click free look: the view leaves the tracked body
    if (this._applyFreeLook()) this._trackTarget = null;

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
   * Apply the right-drag accumulated since the last frame as a free look: turn
   * the view about the camera's own position, moving the orbit target along
   * with the line of sight at the same distance, so the camera stays put and
   * the next `controls.update()` keeps the new direction.
   *
   * A free look is the person aiming the camera, so it ends a look-at — which
   * would otherwise turn the camera straight back — but nothing else: the
   * caller decides whether tracking survives. True when it turned the view.
   */
  private _applyFreeLook(): boolean {
    const dx = this._rightDragDx;
    const dy = this._rightDragDy;
    this._rightDragDx = 0;
    this._rightDragDy = 0;
    if (dx === 0 && dy === 0) return false;
    this.clearLookAt();

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();

    const q = new THREE.Quaternion();
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(this.camera.up, -dx * this.freeLookSensitivity));
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * this.freeLookSensitivity));

    const dist = this.camera.position.distanceTo(this.controls.target);
    const newDir = forward.applyQuaternion(q).normalize();
    this.controls.target.copy(this.camera.position).addScaledVector(newDir, dist);
    this.camera.up.applyQuaternion(q).normalize();
    return true;
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
