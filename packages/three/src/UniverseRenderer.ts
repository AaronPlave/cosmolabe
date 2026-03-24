import * as THREE from 'three';
import { CompositeTrajectory, SpiceTrajectory, type Universe, type Body } from '@spicecraft/core';
import { BodyMesh } from './BodyMesh.js';
import { RingMesh } from './RingMesh.js';
import { TrajectoryLine, type TrajectoryLineOptions } from './TrajectoryLine.js';
import { SensorFrustum } from './SensorFrustum.js';
import { InstrumentView, type InstrumentViewOptions } from './InstrumentView.js';
import { EventMarkers } from './EventMarkers.js';
import { AtmosphereMesh, resolveAtmosphereParams } from './AtmosphereMesh.js';
import { GeometryReadout } from './GeometryReadout.js';
import { StarField, type StarFieldOptions } from './StarField.js';
import { LabelManager, type LabelManagerOptions } from './LabelManager.js';
import { CameraController } from './controls/CameraController.js';
import { TimeController } from './controls/TimeController.js';
import type { TerrainConfig } from './TerrainManager.js';
import type { SurfaceTileConfig } from './SurfaceTileOverlay.js';
import type { RendererPlugin } from './plugins/RendererPlugin.js';

// Reusable temporaries for clampCameraAboveSurfaces (avoid per-frame allocation)
const _clampTmpVec = /* @__PURE__ */ new THREE.Vector3();
const _clampTmpVec2 = /* @__PURE__ */ new THREE.Vector3();
const _clampTmpQuat = /* @__PURE__ */ new THREE.Quaternion();

export interface SurfacePickResult {
  /** Name of the body that was clicked */
  bodyName: string;
  /** Geodetic latitude in degrees (positive north) */
  latDeg: number;
  /** Geodetic longitude in degrees (positive east) */
  lonDeg: number;
  /** Altitude above the reference sphere in km */
  altKm: number;
}

export interface UniverseRendererOptions {
  /** km → scene units. Default 1e-6 (1 km = 0.000001 scene units) for solar system scale */
  scaleFactor?: number;
  /** Show trajectory trails */
  showTrajectories?: boolean;
  /** Default trajectory options */
  trajectoryOptions?: TrajectoryLineOptions;
  /** Show star background */
  showStars?: boolean;
  /** Star field options */
  starFieldOptions?: StarFieldOptions;
  /** Show body labels */
  showLabels?: boolean;
  /** Label options */
  labelOptions?: LabelManagerOptions;
  /** Antialias */
  antialias?: boolean;
  /** Bodies to show trajectories for (if not set, shows for spacecraft/comet/asteroid) */
  trajectoryFilter?: (body: Body) => boolean;
  /** Minimum screen pixels for any body (ensures visibility). Default 4. Set 0 for real scale. */
  minBodyPixels?: number;
  /** Resolve a model source path (from catalog geometry.source) to a loadable URL */
  modelResolver?: (source: string) => string | undefined;
  /** Resolve a texture path (from catalog geometry.baseMap/normalMap) to a loadable URL.
   *  Falls back to modelResolver if not provided. */
  textureResolver?: (source: string) => string | undefined;
}

// Classes that should NOT show trajectories by default
const EXCLUDED_TRAJECTORY_CLASSES = new Set(['star', 'barycenter']);

/** Layer 2: overlay objects excluded from instrument PiP (trajectories, frustums, markers) */
const OVERLAY_LAYER = 2;

export class UniverseRenderer {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly cameraController: CameraController;
  readonly timeController: TimeController;

  private readonly universe: Universe;
  readonly scaleFactor: number;
  private readonly minBodyPixels: number;
  private readonly bodyMeshes = new Map<string, BodyMesh>();
  private readonly trajectoryLines = new Map<string, TrajectoryLine>();
  private readonly sensorFrustums = new Map<string, SensorFrustum>();
  private readonly ringMeshes = new Map<string, { ring: RingMesh; parentName: string }>();
  private readonly eventMarkerGroups = new Map<string, EventMarkers>();
  private readonly atmosphereMeshes = new Map<string, { atm: AtmosphereMesh; parentName: string }>();
  private _coverageWarned = false;
  private readonly plugins: RendererPlugin[] = [];
  private readonly options: UniverseRendererOptions;

  private labelManager: LabelManager | null = null;
  private geometryReadout: GeometryReadout | null = null;
  private starField: StarField | null = null;
  private ambientLight: THREE.AmbientLight | null = null;
  private sunLight: THREE.PointLight | null = null;
  private animFrameId = 0;
  private readonly labelContainer: HTMLDivElement;
  private _dblClickRaycaster: THREE.Raycaster | null = null;
  private instrumentView: InstrumentView | null = null;
  /** Separate scene for camera-relative rendering of surface tile overlays. */
  private readonly tileScene: THREE.Scene;
  /** Separate scene rendered last so the pick marker is never overdrawn by tileScene/models. */
  private readonly _markerScene: THREE.Scene;
  /** Pick marker: a constant-screen-space dot at the last picked surface point. */
  private _pickMarker: THREE.Points | null = null;
  private _pickMarkerInfo: SurfacePickResult | null = null;
  private _renderDebugFrame = 0;
  /** Sun radius in km — used for eclipse penumbra computation */
  private readonly _sunRadiusKm = 695700;
  /** Bodies smaller than this (km) are never eclipse occluders */
  private readonly _shadowMinOccluderKm = 100;
  /** Per-body occluder list, rebuilt each frame by updateShadowOccluders() */
  private readonly _shadowOccluderCache = new Map<string, { pos: THREE.Vector3; radius: number }[]>();
  /** Current lighting mode — eclipse shadows only apply in 'natural' mode */
  private _lightingMode: 'natural' | 'shadow' | 'flood' = 'natural';

  constructor(
    canvas: HTMLCanvasElement,
    universe: Universe,
    options: UniverseRendererOptions = {},
  ) {
    this.universe = universe;
    this.options = options;
    this.scaleFactor = options.scaleFactor ?? 1e-6;
    this.minBodyPixels = options.minBodyPixels ?? 4;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: options.antialias ?? true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);

    // Scene
    this.scene = new THREE.Scene();
    // Very dim ambient — just enough to see body silhouettes on the dark side.
    // In space the unlit hemisphere is essentially black; 0x080808 ≈ 3%.
    this.ambientLight = new THREE.AmbientLight(0x080808);
    this.ambientLight.layers.enableAll();
    this.scene.add(this.ambientLight);

    // Separate scene for surface tile CRR rendering.
    // Full ambient light: surface tiles are photogrammetric with baked lighting.
    this.tileScene = new THREE.Scene();
    this.tileScene.add(new THREE.AmbientLight(0xffffff, 1));

    // Marker scene renders last so it's never overdrawn by tileScene/model passes.
    this._markerScene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60, canvas.clientWidth / canvas.clientHeight, 1e-6, 1e12,
    );
    this.camera.position.set(0, 0, 500 * this.scaleFactor);

    // Camera controller
    this.cameraController = new CameraController(this.camera, canvas);

    // Time controller
    this.timeController = new TimeController(universe.time);
    this.timeController.onTimeChange((et) => universe.setTime(et));

    // Label overlay container
    this.labelContainer = document.createElement('div');
    this.labelContainer.style.position = 'absolute';
    this.labelContainer.style.top = '0';
    this.labelContainer.style.left = '0';
    this.labelContainer.style.width = '100%';
    this.labelContainer.style.height = '100%';
    this.labelContainer.style.pointerEvents = 'none';
    this.labelContainer.style.overflow = 'hidden';
    canvas.parentElement?.appendChild(this.labelContainer);

    // Build scene from universe
    this.buildScene();

    // Geometry readout (click-to-inspect)
    this.geometryReadout = new GeometryReadout();
    this.geometryReadout.attachTo(canvas, this.bodyMeshes);
    this.use(this.geometryReadout);

    // Double-click fly-to: raycast against body meshes and label sprites
    this._dblClickRaycaster = new THREE.Raycaster();
    canvas.addEventListener('dblclick', this._onDblClick);
  }

  use(plugin: RendererPlugin): void {
    this.plugins.push(plugin);
    this.universe.use(plugin);
    plugin.onSceneSetup?.(this.scene, this.camera, this.universe);
  }

  /** Start the render loop */
  start(): void {
    if (this.animFrameId) return;
    this.timeController.play();
    this.renderLoop();
  }

  /** Stop the render loop */
  stop(): void {
    this.timeController.pause();
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
  }

  /**
   * Compute a body's absolute position in km by walking up the parent chain.
   * Delegates to Universe.absolutePositionOf().
   */
  absolutePositionOf = (bodyName: string, et: number): [number, number, number] => {
    return this.universe.absolutePositionOf(bodyName, et);
  };

  /** Render a single frame at current time */
  renderFrame(): void {
    const et = this.timeController.et;
    const canvasHeight = this.renderer.domElement.clientHeight;
    const halfFovTan = Math.tan((this.camera.fov * Math.PI / 180) / 2);

    // Apply deferred origin switch from fly-to completion BEFORE computing
    // body positions, so camera and body coordinates use the same origin.
    this.cameraController.applyPendingOriginSwitch();

    // Origin body: its absolute position becomes scene origin (0,0,0).
    // This keeps the camera near the origin, avoiding Float32 precision loss in the GPU.
    // Uses originBody (persists after un-tracking) rather than trackedBody to prevent
    // the scene from jumping when the user pans or translates away from a tracked body.
    const originBody = this.cameraController.originBody?.body.name;
    const originAbsPos: [number, number, number] = originBody
      ? this.absolutePositionOf(originBody, et)
      : [0, 0, 0];
    // If origin body has no coverage at this time, skip the entire frame update.
    // Everything stays at its last known position rather than jumping to the Sun.
    if (isNaN(originAbsPos[0])) {
      if (!this._coverageWarned) {
        console.warn(`[SpiceCraft] No ephemeris coverage at ET=${et.toFixed(0)} — scene frozen. Loaded kernels may not cover this time range.`);
        this._coverageWarned = true;
      }
      return;
    }
    this._coverageWarned = false;

    // Update body positions relative to origin body
    for (const bm of this.bodyMeshes.values()) {
      const absPos = this.absolutePositionOf(bm.body.name, et);
      if (isNaN(absPos[0])) continue; // Skip bodies with no coverage at this time
      const relPos: [number, number, number] = [
        absPos[0] - originAbsPos[0],
        absPos[1] - originAbsPos[1],
        absPos[2] - originAbsPos[2],
      ];
      bm.updatePosition(relPos, et, this.scaleFactor);

      // Cosmographia-style visibility: real scale always, fade/hide when too small.
      // Show placeholder marker when model is below threshold, show model when large enough.
      const dist = bm.position.distanceTo(this.camera.position);
      const realSceneRadius = bm.displayRadius * this.scaleFactor;
      const screenPixels = dist > 0 ? (realSceneRadius / dist) * canvasHeight / (2 * halfFovTan) : 1000;

      bm.scale.setScalar(1); // Always real scale

      if (bm.hasModel) {
        const MODEL_SHOW_PX = 2;   // Show model when > 2px
        const MODEL_FADE_PX = 5;   // Fully opaque at 5px
        if (screenPixels >= MODEL_SHOW_PX) {
          // Show model, hide placeholder
          bm.setModelVisible(true);
          bm.mesh.visible = false;
          // Fade in model between 2-5px
          const opacity = Math.min(1, (screenPixels - MODEL_SHOW_PX) / (MODEL_FADE_PX - MODEL_SHOW_PX));
          bm.setModelOpacity(opacity);
        } else if (this.minBodyPixels > 0) {
          // Too small for model: show placeholder as a dot (respects minBodyPixels)
          bm.setModelVisible(false);
          bm.mesh.visible = true;
        } else {
          // No minBodyPixels: hide everything when too small
          bm.setModelVisible(false);
          bm.mesh.visible = false;
        }
      }

      // Placeholder sphere: clamp to minBodyPixels so it's always a visible dot.
      // applyMeshScale(factor) sets rendered radius = displayRadius * factor,
      // so we need factor = minSceneRadius / displayRadius (not / realSceneRadius).
      if (bm.mesh.visible && this.minBodyPixels > 0 && screenPixels < this.minBodyPixels) {
        const minSceneRadius = this.minBodyPixels * dist * 2 * halfFovTan / canvasHeight;
        bm.applyMeshScale(minSceneRadius / bm.displayRadius);
      } else if (bm.mesh.visible) {
        bm.applyMeshScale(this.scaleFactor);
      }
    }

    // Update pick marker world position (tracks body rotation/position each frame)
    this._updatePickMarkerPosition();

    // Update ring positions (follow parent body position and rotation)
    for (const [, { ring, parentName }] of this.ringMeshes) {
      const parentBm = this.bodyMeshes.get(parentName);
      if (parentBm) {
        ring.position.copy(parentBm.position);
        // Ring rotation = parent body's SPICE rotation (the ring mesh is in the
        // XZ plane; the Globe pre-rotation in meshRotationQ maps it to the
        // body-fixed equatorial plane)
        ring.quaternion.copy(parentBm.mesh.quaternion);
        ring.applyScale(this.scaleFactor);
      }
    }

    // Update atmosphere shells (follow parent body position, pass camera + sun)
    if (this.atmosphereMeshes.size > 0) {
      const sunBm = this.bodyMeshes.get('Sun');
      const sunPos = sunBm ? sunBm.position : new THREE.Vector3(0, 0, 0);
      for (const [, { atm, parentName }] of this.atmosphereMeshes) {
        const parentBm = this.bodyMeshes.get(parentName);
        if (parentBm) {
          atm.position.copy(parentBm.position);
          // Match body rotation so the oblateness axis aligns with the actual pole.
          // ellipsoidRatios are in geometry space (geoY = body-fixed Z/pole) which
          // requires the same Globe pre-rotation + SPICE attitude as the body mesh.
          atm.quaternion.copy(parentBm.mesh.quaternion);
          // Unit sphere * shellRadius * scaleFactor = scene-space shell.
          // Match the body's ellipsoid ratios so the atmosphere follows oblateness.
          const s = atm.shellRadius * this.scaleFactor;
          const er = parentBm.ellipsoidRatios;
          atm.scale.set(s * er[0], s * er[1], s * er[2]);
          atm.updateMatrixWorld(true);
          const atmOccluders = this._shadowOccluderCache.get(parentName);
          atm.update(
            this.camera.position, sunPos,
            atmOccluders, parentBm.position,
            this._sunRadiusKm * this.scaleFactor,
            atm.shellRadius * this.scaleFactor,
          );
        }
      }
    }

    // Update trajectory lines.
    // Vertices are offset in Float64 (km) so they're near origin in scene space,
    // eliminating Float32 precision jitter on the GPU.
    for (const tl of this.trajectoryLines.values()) {
      const arcCenter = (tl as any)._arcCenterName as string | undefined;
      const parentName = tl.body.parentName;
      const centerName = arcCenter ?? parentName;

      // Object3D at origin — all offset is baked into vertices via vertexOffset
      tl.position.set(0, 0, 0);

      if (centerName) {
        // vertexOffset = (centerAbs - originAbs) in km, so vertices become origin-relative
        const centerAbsNow = this.absolutePositionOf(centerName, et);
        // Skip if center position is NaN (SPICE kernel out of coverage)
        if (isNaN(centerAbsNow[0])) continue;
        const vertOff: [number, number, number] = [
          centerAbsNow[0] - originAbsPos[0],
          centerAbsNow[1] - originAbsPos[1],
          centerAbsNow[2] - originAbsPos[2],
        ];

        if (!arcCenter && parentName) {
          const relativeResolver: typeof this.absolutePositionOf = (name, t) => {
            const state = this.universe.getBody(name)!.stateAt(t);
            return state.position as [number, number, number];
          };
          tl.update(et, this.scaleFactor, relativeResolver, undefined, undefined, vertOff);
        } else {
          tl.update(et, this.scaleFactor, undefined, undefined, undefined, vertOff);
        }
      } else {
        // Absolute positions — offset by origin
        const vertOff: [number, number, number] = [
          -originAbsPos[0],
          -originAbsPos[1],
          -originAbsPos[2],
        ];
        tl.update(et, this.scaleFactor, this.absolutePositionOf, undefined, undefined, vertOff);
      }
    }

    // Update sensor frustums (origin-relative, same as body meshes)
    const originRelResolver = (name: string, t: number): [number, number, number] => {
      const abs = this.absolutePositionOf(name, t);
      return [abs[0] - originAbsPos[0], abs[1] - originAbsPos[1], abs[2] - originAbsPos[2]];
    };
    const spiceInst = this.universe.spiceInstance;
    for (const sf of this.sensorFrustums.values()) {
      const targetBody = sf.targetName ? this.universe.getBody(sf.targetName) : undefined;
      // Try SPICE-based orientation using cached FOV frame (from enrichSensorFromSpice)
      let spiceRot: number[] | undefined;
      if (sf.spiceFovFrame && spiceInst) {
        try {
          spiceRot = spiceInst.pxform(sf.spiceFovFrame, 'J2000', et) as unknown as number[];
        } catch {
          // CK data may not cover this time — fall back to target-pointing
        }
      }
      sf.update(et, this.scaleFactor, targetBody, originRelResolver, spiceRot);
    }

    // Update event markers (each knows its own trail/lead duration)
    for (const em of this.eventMarkerGroups.values()) {
      em.update(et, this.scaleFactor, originRelResolver);
    }

    // Update labels
    if (this.labelManager) {
      this.labelManager.update(
        Array.from(this.bodyMeshes.values()),
        this.camera,
        { width: this.renderer.domElement.clientWidth, height: this.renderer.domElement.clientHeight },
      );
    }

    // Update sun light position
    if (this.sunLight) {
      const sun = this.bodyMeshes.get('Sun');
      if (sun) this.sunLight.position.copy(sun.position);
    }

    this.updateShadowOccluders();

    // Adapt camera speeds to altitude above nearest body (before controls process input)
    this.cameraController.adaptSpeeds(this.bodyMeshes.values(), this.scaleFactor);

    // Camera
    this.cameraController.update();

    // Prevent camera from going inside any body's surface
    this.clampCameraAboveSurfaces();

    // Plugins
    for (const plugin of this.plugins) {
      plugin.onRender?.(et, this.scene, this.camera, this.universe);
    }

    // Dynamic near/far: adjust based on distance to orbit target
    const camDist = this.camera.position.distanceTo(this.cameraController.controls.target);
    this.camera.near = Math.max(1e-12, camDist * 1e-5);
    this.camera.far = Math.max(1e6, camDist * 1e6);
    this.camera.updateProjectionMatrix();

    // Update streaming terrain tiles AFTER camera controller + clamp + near/far.
    // The tiles renderer's prepareForTraversal() reads camera.matrixWorldInverse,
    // camera.projectionMatrix, and group.matrixWorld. By updating here we ensure
    // all three are current-frame values (camera is not in the scene graph, so
    // we must explicitly update its world matrix).
    this.camera.updateMatrixWorld();
    for (const bm of this.bodyMeshes.values()) {
      if (bm.hasTerrain || bm.hasSurfaceTiles) {
        bm.updateMatrixWorld(true);
        const dist = bm.position.distanceTo(this.camera.position);
        const realSceneRadius = bm.displayRadius * this.scaleFactor;
        const screenPx = dist > 0 ? (realSceneRadius / dist) * canvasHeight / (2 * halfFovTan) : 1000;
        if (bm.hasTerrain) bm.updateTerrain(this.camera, this.renderer, screenPx);
        if (bm.hasSurfaceTiles) bm.updateSurfaceTiles(this.camera, this.renderer, screenPx);
      }
    }

    // --- Multi-pass rendering ---
    this.renderer.autoClear = false;
    this._renderDebugFrame++;

    // Pass 1: Scene without models (layers 0 + 2) — log depth for cosmic scale
    // Layer 0 = bodies/globes/stars/atmosphere, Layer 2 = overlays (trajectories, frustums)
    this.camera.layers.set(0);
    this.camera.layers.enable(OVERLAY_LAYER);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);

    // Pass 1.5: Surface tiles — camera-relative rendering in separate scene.
    // Surface tiles live in tileScene (not the main scene) to avoid layer/z-fighting
    // issues with terrain. Positions are computed in float64, camera is moved to
    // origin, and the small delta is cast to float32 for the GPU. Depth is cleared
    // so tiles composite on top of Pass 1's terrain.
    {
      let hasVisibleTiles = false;
      let minTileDist = Infinity;
      let maxTileDist = 0;

      for (const bm of this.bodyMeshes.values()) {
        if (!bm.hasSurfaceTiles) continue;
        for (const overlay of bm.getSurfaceOverlays()) {
          if (!overlay.group.visible) continue;
          const d = overlay.distanceTo(
            this.camera.position, bm.position,
            bm.mesh.quaternion, this.scaleFactor,
          );
          if (d > 0) {
            hasVisibleTiles = true;
            if (d < minTileDist) minTileDist = d;
            if (d > maxTileDist) maxTileDist = d;
          }
        }
      }

      if (hasVisibleTiles) {
        const savedPos = this.camera.position.clone();
        const savedNear = this.camera.near;
        const savedFar = this.camera.far;

        // Tight near/far for full depth precision on small surface geometry
        this.camera.near = Math.max(1e-10, minTileDist * 0.01);
        this.camera.far = Math.max(maxTileDist * 10, minTileDist * 1000);
        this.camera.position.set(0, 0, 0);
        this.camera.updateMatrixWorld(true);
        this.camera.updateProjectionMatrix();

        // Apply camera-relative transforms: body center offset from saved camera pos
        for (const bm of this.bodyMeshes.values()) {
          if (!bm.hasSurfaceTiles) continue;
          for (const overlay of bm.getSurfaceOverlays()) {
            if (!overlay.group.visible) continue;
            overlay.setCameraRelativeTransform(
              bm.position, bm.mesh.quaternion,
              this.scaleFactor, savedPos,
            );
          }
        }

        // Render only the tile scene (separate from main scene) with cleared depth
        this.renderer.clearDepth();
        this.renderer.render(this.tileScene, this.camera);

        // Restore camera
        this.camera.position.copy(savedPos);
        this.camera.near = savedNear;
        this.camera.far = savedFar;
        this.camera.updateMatrixWorld(true);
        this.camera.updateProjectionMatrix();
      }
    }

    // Pass 2: Models (layer 1) — standard depth with tight near/far
    // Models strip logdepthbuf shader chunks so hardware depth interpolation
    // handles face sorting with full float32 precision.
    let hasVisibleModels = false;
    let minModelDist = Infinity;
    let maxModelDist = 0;
    for (const bm of this.bodyMeshes.values()) {
      if (bm.isModelVisible) {
        const d = bm.position.distanceTo(this.camera.position);
        if (d > 0) {
          hasVisibleModels = true;
          if (d < minModelDist) minModelDist = d;
          if (d > maxModelDist) maxModelDist = d;
        }
      }
    }

    if (hasVisibleModels) {
      const savedNear = this.camera.near;
      const savedFar = this.camera.far;

      // Tight near/far: ratio ~100× gives standard depth enough precision
      this.camera.near = Math.max(1e-15, minModelDist * 0.1);
      this.camera.far = Math.max(maxModelDist * 10, minModelDist * 100);
      this.camera.updateProjectionMatrix();

      this.camera.layers.set(1);
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.camera);

      // Restore camera
      this.camera.near = savedNear;
      this.camera.far = savedFar;
      this.camera.updateProjectionMatrix();
    }

    this.camera.layers.enableAll();

    // Instrument PiP view — wrapped in try/catch to never break the main render
    if (this.instrumentView?.active) {
      try {
        const sf = this.sensorFrustums.get(this.instrumentView.sensorName!);
        if (sf) {
          const targetBody = sf.targetName ? this.universe.getBody(sf.targetName) : undefined;
          let spiceRot: number[] | undefined;
          if (sf.spiceFovFrame && spiceInst) {
            try {
              spiceRot = spiceInst.pxform(sf.spiceFovFrame, 'J2000', et) as unknown as number[];
            } catch { /* no CK coverage */ }
          }
          this.instrumentView.update(et, this.scaleFactor, originRelResolver, targetBody, spiceRot);
          this.instrumentView.render(this.renderer, this.scene);
        }
      } catch (err) {
        console.warn('[SpiceCraft] Instrument PiP render error:', err);
      }
    }

    // Final pass: pick marker — always on top of every other pass.
    if (this._pickMarker) {
      this.renderer.render(this._markerScene, this.camera);
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.instrumentView?.onResize();
    for (const plugin of this.plugins) {
      plugin.onResize?.(width, height);
    }
  }

  getBodyMesh(name: string): BodyMesh | undefined {
    return this.bodyMeshes.get(name);
  }

  /** Get all sensor frustum names (for UI instrument selection). */
  getSensorNames(): string[] {
    return [...this.sensorFrustums.keys()];
  }

  /**
   * Show/hide the instrument picture-in-picture view.
   * Pass a sensor name to activate, or null to deactivate.
   */
  setInstrumentView(sensorName: string | null, options?: InstrumentViewOptions): void {
    if (sensorName == null) {
      if (this.instrumentView) {
        this.instrumentView.setSensor(null);
      }
      return;
    }

    const sf = this.sensorFrustums.get(sensorName);
    if (!sf) {
      console.warn(`[SpiceCraft] No sensor frustum found for "${sensorName}"`);
      return;
    }

    // Create InstrumentView on first use
    if (!this.instrumentView) {
      this.instrumentView = new InstrumentView(
        this.renderer.domElement.parentElement!,
        options,
      );
    }

    this.instrumentView.setSensor(sf);
  }

  /** Get the currently active instrument view sensor name, if any. */
  get activeInstrumentView(): string | undefined {
    return this.instrumentView?.active ? this.instrumentView.sensorName : undefined;
  }

  /** Toggle terrain debug tile bounds for a body (or all terrain bodies) */
  showTerrainDebug(show: boolean, bodyName?: string): void {
    if (bodyName) {
      this.bodyMeshes.get(bodyName)?.setTerrainDebug(show);
    } else {
      for (const bm of this.bodyMeshes.values()) {
        if (bm.hasTerrain) bm.setTerrainDebug(show);
      }
    }
  }

  /** Log terrain tile stats (call from console: renderer.logTerrainStats()) */
  logTerrainStats(bodyName?: string): void {
    if (bodyName) {
      this.bodyMeshes.get(bodyName)?.logTerrainStats();
    } else {
      for (const bm of this.bodyMeshes.values()) {
        if (bm.hasTerrain) {
          console.log(`--- ${bm.body.name} ---`);
          bm.logTerrainStats();
        }
      }
    }
  }

  /** Toggle body-fixed orientation axes for a body (or all bodies if no name given).
   *  Red=X (prime meridian), Green=Y, Blue=Z (pole). */
  showBodyAxes(show: boolean, bodyName?: string): void {
    if (bodyName) {
      this.bodyMeshes.get(bodyName)?.showAxes(show);
    } else {
      for (const bm of this.bodyMeshes.values()) {
        bm.showAxes(show);
      }
    }
  }

  /** Toggle lat/lon grid lines on bodies (excludes spacecraft, instruments, barycenters).
   *  Equator is highlighted in yellow, prime meridian in red.
   *  Works with triaxial ellipsoids. */
  showBodyGrid(show: boolean, bodyName?: string): void {
    const excluded = new Set(['spacecraft', 'instrument', 'barycenter']);
    if (bodyName) {
      const bm = this.bodyMeshes.get(bodyName);
      if (bm && !excluded.has(bm.body.classification ?? '')) bm.showGrid(show);
    } else {
      for (const bm of this.bodyMeshes.values()) {
        if (!excluded.has(bm.body.classification ?? '')) bm.showGrid(show);
      }
    }
  }

  /**
   * Set the scene lighting mode.
   * - `'natural'`: Realistic — very dim ambient, strong sun (default)
   * - `'shadow'`: Enhanced — brighter ambient so dark-side detail is visible, softer sun
   * - `'flood'`: Uniform — full ambient, no directional shadows
   */
  setLightingMode(mode: 'natural' | 'shadow' | 'flood'): void {
    this._lightingMode = mode;
    if (!this.ambientLight) return;
    switch (mode) {
      case 'natural':
        this.ambientLight.color.setHex(0x080808);
        this.ambientLight.intensity = 1;
        if (this.sunLight) this.sunLight.intensity = 2;
        break;
      case 'shadow':
        this.ambientLight.color.setHex(0x555555);
        this.ambientLight.intensity = 1;
        if (this.sunLight) this.sunLight.intensity = 1.5;
        break;
      case 'flood':
        this.ambientLight.color.setHex(0xffffff);
        this.ambientLight.intensity = 1;
        if (this.sunLight) this.sunLight.intensity = 0;
        break;
    }
  }

  /** Toggle visibility of a body's mesh, trajectory line(s), and label */
  setBodyVisible(name: string, visible: boolean): void {
    const bm = this.bodyMeshes.get(name);
    if (bm) bm.visible = visible;

    // Single trajectory
    const tl = this.trajectoryLines.get(name);
    if (tl) tl.setUserVisible(visible);

    // Composite arcs (keyed as "name__arc0", "name__arc1", etc.)
    for (const [key, line] of this.trajectoryLines) {
      if (key.startsWith(`${name}__arc`)) line.setUserVisible(visible);
    }

    // Sensor frustums
    const sf = this.sensorFrustums.get(name);
    if (sf) sf.visible = visible;

    // Ring mesh (direct match or parent body match)
    const rm = this.ringMeshes.get(name);
    if (rm) rm.ring.visible = visible;
    // Also hide rings when parent body is hidden
    for (const [, { ring, parentName }] of this.ringMeshes) {
      if (parentName === name) ring.visible = visible;
    }

    // Atmosphere shell
    const atm = this.atmosphereMeshes.get(name);
    if (atm) atm.atm.visible = visible;

    // Event markers
    const em = this.eventMarkerGroups.get(name);
    if (em) em.visible = visible;

    // Label
    this.labelManager?.setLabelVisible(name, visible);
  }

  /** Show or hide all trajectory lines. */
  setTrajectoriesVisible(visible: boolean): void {
    for (const tl of this.trajectoryLines.values()) {
      tl.setUserVisible(visible);
    }
  }

  /** Show or hide all body labels. */
  setLabelsVisible(visible: boolean): void {
    this.labelManager?.setAllVisible(visible);
  }

  /** Place (or clear) a constant screen-space dot at a picked surface point. */
  setPickMarker(result: SurfacePickResult | null): void {
    // Remove old marker
    if (this._pickMarker) {
      this._markerScene.remove(this._pickMarker);
      (this._pickMarker.material as THREE.Material).dispose();
      this._pickMarker.geometry.dispose();
      this._pickMarker = null;
    }
    this._pickMarkerInfo = result;
    if (!result) return;

    // Build a circular dot texture on a small canvas
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const r = size / 2;
    ctx.beginPath();
    ctx.arc(r, r, r - 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3333';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    const tex = new THREE.CanvasTexture(canvas);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const mat = new THREE.PointsMaterial({
      size: 14,
      sizeAttenuation: false,
      map: tex,
      alphaTest: 0.1,
      transparent: true,
      depthTest: false,       // always render on top
    });
    this._pickMarker = new THREE.Points(geo, mat);
    this._markerScene.add(this._pickMarker);
    // Position immediately so it doesn't flash at origin
    this._updatePickMarkerPosition();
  }

  private _updatePickMarkerPosition(): void {
    if (!this._pickMarker || !this._pickMarkerInfo) return;
    const { bodyName, latDeg, lonDeg, altKm } = this._pickMarkerInfo;
    const bm = this.bodyMeshes.get(bodyName);
    if (!bm) return;

    const latRad = latDeg * (Math.PI / 180);
    const lonRad = lonDeg * (Math.PI / 180);
    const r = bm.displayRadius + altKm;

    // lat/lon/alt → ECEF Z-up km
    const ecefX = r * Math.cos(latRad) * Math.cos(lonRad);
    const ecefY = r * Math.cos(latRad) * Math.sin(lonRad);
    const ecefZ = r * Math.sin(latRad);

    // ECEF Z-up → body-fixed geometry Y-up (inverse of pickSurface conversion)
    // geoX=ecefX, geoY=ecefZ(pole), geoZ=-ecefY
    const geom = new THREE.Vector3(ecefX, ecefZ, -ecefY);

    // Rotate body-fixed → inertial, scale to scene units, translate to world pos
    geom.applyQuaternion(bm.mesh.quaternion)
        .multiplyScalar(this.scaleFactor)
        .add(bm.position);

    this._pickMarker.position.copy(geom);
  }

  /**
   * Raycast from an NDC coordinate against all body surfaces, terrain tiles, and surface tile
   * overlays. Returns geodetic lat/lon/altitude on the closest hit, or null if nothing is hit.
   * @param ndcX - Normalized device X (-1 = left, +1 = right)
   * @param ndcY - Normalized device Y (-1 = bottom, +1 = top)
   */
  pickSurface(ndcX: number, ndcY: number): SurfacePickResult | null {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, this.camera);

    // Main scene: globe sphere meshes + terrain tile groups
    const mainTargets: THREE.Object3D[] = [];
    for (const bm of this.bodyMeshes.values()) {
      if (bm.mesh.visible) mainTargets.push(bm.mesh);
      const tg = bm.terrainTileGroup;
      if (tg && tg.visible) mainTargets.push(tg);
    }
    const mainHits = raycaster.intersectObjects(mainTargets, true);

    // tileScene: surface tile overlays use camera-relative rendering (CRR).
    // In tileScene space the camera is at origin, so shift ray origin to (0,0,0).
    const tileRaycaster = new THREE.Raycaster();
    tileRaycaster.setFromCamera(ndc, this.camera);
    tileRaycaster.ray.origin.set(0, 0, 0);
    const tileTargets: THREE.Object3D[] = [];
    const overlayBodyMap = new Map<THREE.Object3D, BodyMesh>();
    for (const bm of this.bodyMeshes.values()) {
      for (const overlay of bm.getSurfaceOverlays()) {
        if (overlay.group.visible) {
          tileTargets.push(overlay.group);
          overlayBodyMap.set(overlay.group, bm);
        }
      }
    }
    const tileHits = tileRaycaster.intersectObjects(tileTargets, true);

    // Pick the closest hit
    let bestWorldPoint: THREE.Vector3 | null = null;
    let bestBm: BodyMesh | null = null;
    let bestDist = Infinity;

    if (mainHits.length > 0) {
      const hit = mainHits[0];
      if (hit.distance < bestDist) {
        bestDist = hit.distance;
        bestWorldPoint = hit.point.clone();
        for (const bm of this.bodyMeshes.values()) {
          let obj: THREE.Object3D | null = hit.object;
          while (obj) {
            if (obj === bm) { bestBm = bm; break; }
            obj = obj.parent;
          }
          if (bestBm) break;
        }
      }
    }

    if (tileHits.length > 0) {
      const hit = tileHits[0];
      if (hit.distance < bestDist) {
        // CRR hit point is relative to camera; add camera position to get world space
        bestWorldPoint = hit.point.clone().add(this.camera.position);
        bestBm = null;
        let obj: THREE.Object3D | null = hit.object;
        while (obj) {
          const bm = overlayBodyMap.get(obj);
          if (bm) { bestBm = bm; break; }
          obj = obj.parent;
        }
      }
    }

    if (!bestWorldPoint || !bestBm) return null;

    const bm = bestBm;
    const bodyCenter = new THREE.Vector3();
    bm.getWorldPosition(bodyCenter);

    // Vector from body center to hit, converted to km in the inertial Y-up frame
    const km = bestWorldPoint.clone().sub(bodyCenter).divideScalar(this.scaleFactor);

    // Rotate inertial → body-fixed geometry space (Y-up).
    // bm.mesh.quaternion = spiceQ * meshRotationQ (globe pre-rotation).
    km.applyQuaternion(bm.mesh.quaternion.clone().invert());

    // Body-fixed geometry Y-up → body-fixed ECEF Z-up:
    //   geoX = bodyX, geoY = bodyZ (pole), geoZ = -bodyY
    const ecefX = km.x;
    const ecefY = -km.z;
    const ecefZ = km.y;

    const r = Math.sqrt(ecefX * ecefX + ecefY * ecefY + ecefZ * ecefZ);
    if (r < 1e-10) return null;

    const latDeg = Math.asin(Math.max(-1, Math.min(1, ecefZ / r))) * (180 / Math.PI);
    const lonDeg = Math.atan2(ecefY, ecefX) * (180 / Math.PI);
    const altKm = r - bm.displayRadius;

    return { bodyName: bm.body.name, latDeg, lonDeg, altKm };
  }

  /** Cached terrain elevation per body for clamp (avoids sampling every frame). */
  private _terrainClampCache = new Map<string, { elevationKm: number; frame: number }>();

  /** Recompute eclipse shadow occluder lists for all bodies and push to shader uniforms. */
  private updateShadowOccluders(): void {
    // Eclipse shadows only apply in natural lighting; flood/shadow modes illuminate uniformly.
    if (this._lightingMode !== 'natural') {
      for (const bm of this.bodyMeshes.values()) {
        if (bm.hasShadowReceiving) bm.setShadowOccluders([], new THREE.Vector3(), 0);
      }
      return;
    }
    const sunBm = this.bodyMeshes.get('Sun');
    if (!sunBm) return;
    const sunPos = sunBm.position;
    const sunRadius = this._sunRadiusKm * this.scaleFactor;

    // Candidate occluders: non-star, non-emissive, large enough to cast a meaningful shadow
    const candidates = [...this.bodyMeshes.values()].filter(bm =>
      bm.body.classification !== 'star' &&
      bm.body.geometryData?.emissive !== true &&
      bm.displayRadius >= this._shadowMinOccluderKm,
    );

    this._shadowOccluderCache.clear();
    for (const receiver of this.bodyMeshes.values()) {
      if (receiver.body.classification === 'star') continue;
      if (receiver.body.geometryData?.emissive === true) continue;

      // Pick up to 4 occluders with the largest angular size as seen from this receiver.
      // Largest angular size = most likely to cast a visible shadow.
      const occluders = candidates
        .filter(c => c !== receiver)
        .map(c => {
          const dist = Math.max(c.position.distanceTo(receiver.position), 1e-20);
          return { pos: c.position, radius: c.displayRadius * this.scaleFactor, angularSize: (c.displayRadius * this.scaleFactor) / dist };
        })
        .sort((a, b) => b.angularSize - a.angularSize)
        .slice(0, 4)
        .map(({ pos, radius }) => ({ pos, radius }));

      this._shadowOccluderCache.set(receiver.body.name, occluders);
      if (receiver.hasShadowReceiving) {
        receiver.setShadowOccluders(occluders, sunPos, sunRadius);
      }
    }
  }

  /**
   * Push camera out if it's inside any body's surface.
   * For bodies with terrain, queries actual terrain elevation at the camera's
   * lat/lon so the camera can descend into craters but never go below the
   * visible terrain surface.
   */
  private clampCameraAboveSurfaces(): void {
    const cam = this.camera.position;
    const MARGIN_KM = 0.005; // 5m above terrain surface

    for (const bm of this.bodyMeshes.values()) {
      if (bm.body.geometryType !== 'Globe' && bm.body.geometryType !== 'Ellipsoid') continue;

      const toBody = _clampTmpVec.copy(cam).sub(bm.position);
      const dist = toBody.length();
      if (dist < 1e-20) continue;

      // Base clamp: reference sphere
      let clampRadiusKm = bm.displayRadius;

      // Terrain-aware clamp: query actual elevation at camera position
      if (bm.hasTerrain) {
        // Convert camera direction to body-fixed coordinates for lat/lon
        const sf = this.scaleFactor;
        const invQ = _clampTmpQuat.copy(bm.mesh.quaternion).invert();
        const kmVec = _clampTmpVec2.copy(toBody).divideScalar(sf).applyQuaternion(invQ);

        // Y-up geometry → ECEF Z-up
        const ecefX = kmVec.x;
        const ecefY = -kmVec.z;
        const ecefZ = kmVec.y;
        const r = Math.sqrt(ecefX * ecefX + ecefY * ecefY + ecefZ * ecefZ);

        if (r > 1e-10) {
          const latDeg = Math.asin(Math.max(-1, Math.min(1, ecefZ / r))) * (180 / Math.PI);
          const lonDeg = Math.atan2(ecefY, ecefX) * (180 / Math.PI);

          // Sample terrain every 5 frames, use cached value between samples.
          // Only raise the clamp for POSITIVE elevation (mountains/ridges) where
          // terrain extends above the reference sphere. For negative elevation
          // (craters/basins), coarse terrain data can't resolve deep features and
          // would block descent — fall back to reference sphere clamp instead.
          const bodyName = bm.body.name;
          const cached = this._terrainClampCache.get(bodyName);
          const frame = this._renderDebugFrame;
          if (!cached || frame - cached.frame >= 5) {
            const sample = bm.sampleTerrainElevation(latDeg, lonDeg);
            if (sample && sample.angularDistDeg < 1.0) {
              const elev = sample.elevationKm;
              this._terrainClampCache.set(bodyName, { elevationKm: elev, frame });
              if (elev > 0) clampRadiusKm = bm.displayRadius + elev;
            }
          } else if (cached.elevationKm > 0) {
            clampRadiusKm = bm.displayRadius + cached.elevationKm;
          }
        }
      }

      const surfaceR = (clampRadiusKm + MARGIN_KM) * this.scaleFactor;
      if (dist < surfaceR) {
        // Push camera out to just above surface along the same direction
        toBody.normalize().multiplyScalar(surfaceR);
        cam.copy(bm.position).add(toBody);
      }
    }
  }

  dispose(): void {
    this.stop();
    this.renderer.domElement.removeEventListener('dblclick', this._onDblClick);
    this.timeController.dispose();
    this.cameraController.dispose();
    for (const bm of this.bodyMeshes.values()) bm.dispose();
    for (const [, { ring }] of this.ringMeshes) ring.dispose();
    for (const [, { atm }] of this.atmosphereMeshes) atm.dispose();
    for (const tl of this.trajectoryLines.values()) tl.dispose();
    for (const sf of this.sensorFrustums.values()) sf.dispose();
    for (const em of this.eventMarkerGroups.values()) em.dispose();
    this.starField?.dispose();
    this.labelManager?.dispose();
    this.instrumentView?.dispose();
    this.labelContainer.remove();
    this.renderer.dispose();
    for (const plugin of this.plugins) plugin.dispose?.();
  }

  private buildScene(): void {
    const bodies = this.universe.getAllBodies();

    // Probe SpiceTrajectory bodies to detect which ones have valid kernel data.
    // This sets the `failed` flag so shouldShowTrajectory can filter them out.
    const et = this.timeController.et;
    for (const body of bodies) {
      if (body.trajectory instanceof SpiceTrajectory) {
        body.trajectory.stateAt(et);
      }
    }

    for (const body of bodies) {
      // Sensor bodies get a frustum in addition to a body mesh + trajectory
      if (body.geometryType === 'Sensor') {
        // If spiceId is present and SPICE is available, derive FOV params from the IK kernel
        const fovFrame = this.enrichSensorFromSpice(body);
        const sf = new SensorFrustum(body);
        if (fovFrame) sf.spiceFovFrame = fovFrame;
        sf.layers.set(OVERLAY_LAYER);
        sf.traverse(c => c.layers.set(OVERLAY_LAYER));
        this.sensorFrustums.set(body.name, sf);
        this.scene.add(sf);
      }

      // Rings get an annulus mesh attached to the parent body
      if (body.geometryType === 'Rings' && body.geometryData && body.parentName) {
        const inner = body.geometryData.innerRadius as number;
        const outer = body.geometryData.outerRadius as number;
        if (inner > 0 && outer > inner) {
          const ring = new RingMesh(inner, outer);
          ring.applyScale(this.scaleFactor);
          this.ringMeshes.set(body.name, { ring, parentName: body.parentName });
          this.scene.add(ring);

          // Load ring texture
          const texPath = body.geometryData.texture as string | undefined;
          if (texPath) {
            const resolver = this.options.textureResolver ?? this.options.modelResolver;
            const url = resolver?.(texPath);
            if (url) ring.loadTexture(url);
          }
        }
        continue;
      }

      // Create body mesh (needed for click/track even for sensor bodies)
      const bm = new BodyMesh(body);
      bm.mesh.scale.setScalar(this.scaleFactor);
      // Hide placeholder sphere for instrument-class sensors (e.g. ISS NAC on Cassini)
      // but keep it for spacecraft-class sensors (e.g. WeatherSat in sensor demo)
      if (body.geometryType === 'Sensor' && body.classification === 'instrument') bm.mesh.visible = false;
      this.bodyMeshes.set(body.name, bm);
      this.scene.add(bm);
      bm.enableShadowReceiving();

      // Load 3D model if geometry type is Mesh
      if (body.geometryType === 'Mesh' && body.geometryData?.source) {
        const source = body.geometryData.source as string;
        const resolver = this.options.modelResolver;
        const url = resolver?.(source);
        if (url) {
          bm.loadModel(url, this.scaleFactor, source, resolver);
        }
      }

      // Load textures for Globe geometry (baseMap, normalMap, displacementMap)
      if (body.geometryType === 'Globe' && body.geometryData) {
        const resolver = this.options.textureResolver ?? this.options.modelResolver;
        const geo = body.geometryData;
        if (resolver) {
          const normalMapUrl = typeof geo.normalMap === 'string' ? resolver(geo.normalMap as string) : undefined;
          const dispMapUrl = typeof geo.displacementMap === 'string' ? resolver(geo.displacementMap as string) : undefined;
          const dispScale = typeof geo.displacementScale === 'number' ? geo.displacementScale as number : undefined;
          const dispBias = typeof geo.displacementBias === 'number' ? geo.displacementBias as number : undefined;
          const bumpMapUrl = typeof geo.bumpMap === 'string' ? resolver(geo.bumpMap as string) : undefined;
          const bumpScaleVal = typeof geo.bumpScale === 'number' ? geo.bumpScale as number : undefined;

          if (typeof geo.baseMap === 'string') {
            // Simple string path
            const baseMapUrl = resolver(geo.baseMap as string);
            if (baseMapUrl || normalMapUrl || dispMapUrl || bumpMapUrl) {
              bm.loadGlobeTextures(baseMapUrl, normalMapUrl, dispMapUrl, dispScale, dispBias, bumpMapUrl, bumpScaleVal);
            }
          } else if (geo.baseMap && typeof geo.baseMap === 'object') {
            // Tiled texture (NameTemplate or MultiWMS) — load level-0 tiles
            const tileUrls = this.resolveTileUrls(geo.baseMap as Record<string, unknown>, resolver);
            if (tileUrls) {
              bm.loadTiledBaseMap(tileUrls, this.renderer);
            }
            // Also load normalMap / displacementMap / bumpMap if present
            if (normalMapUrl || dispMapUrl || bumpMapUrl) {
              bm.loadGlobeTextures(undefined, normalMapUrl, dispMapUrl, dispScale, dispBias, bumpMapUrl, bumpScaleVal);
            }
          } else if (normalMapUrl || dispMapUrl || bumpMapUrl) {
            bm.loadGlobeTextures(undefined, normalMapUrl, dispMapUrl, dispScale, dispBias, bumpMapUrl, bumpScaleVal);
          }
        }
      }

      // Initialize streaming terrain for Globe bodies with terrain config
      if (body.geometryType === 'Globe' && body.geometryData?.terrain) {
        const terrainCfg = body.geometryData.terrain as TerrainConfig;
        if (terrainCfg.type && (terrainCfg.url || terrainCfg.cesiumIonAssetId || (terrainCfg.type === 'imagery' && terrainCfg.imagery))) {
          // Use the displacement map as a normal map source for terrain tiles.
          // Terrain tiles only have vertex normals from the mesh geometry — per-pixel
          // normals from the heightmap smooth shadow boundaries at the terminator.
          if (!terrainCfg.normalMapUrl && body.geometryData.displacementMap) {
            const resolver = this.options.textureResolver ?? this.options.modelResolver;
            const resolved = resolver?.(body.geometryData.displacementMap as string);
            if (resolved) terrainCfg.normalMapUrl = resolved;
          }
          bm.initTerrain(terrainCfg, this.renderer);
          console.log(`[SpiceCraft] Initialized terrain for ${body.name}: ${terrainCfg.type} ${terrainCfg.url ?? `ion:${terrainCfg.cesiumIonAssetId}`}`);
        }
      }

      // Initialize surface tile overlays for Globe bodies (e.g. Dingo Gap local-frame tiles).
      // Overlay groups are added to a separate tileScene for camera-relative rendering.
      if (body.geometryType === 'Globe' && body.geometryData?.surfaceTiles) {
        const tiles = body.geometryData.surfaceTiles as SurfaceTileConfig[];
        for (const tileCfg of tiles) {
          const overlay = bm.addSurfaceTiles(tileCfg, this.renderer);
          this.tileScene.add(overlay.group);

          console.log(`[SpiceCraft] Initialized surface tiles "${tileCfg.name}" on ${body.name}`);
        }
      }

      // Create atmosphere shell for Globe bodies with atmosphere data
      if (body.geometryType === 'Globe' && body.geometryData) {
        const atmValue = body.geometryData.atmosphere;
        const atmParams = resolveAtmosphereParams(atmValue, body.name);
        if (atmParams) {
          const radius = bm.displayRadius;
          const atm = new AtmosphereMesh(radius, atmParams);
          this.atmosphereMeshes.set(body.name, { atm, parentName: body.name });
          this.scene.add(atm);
        }
      }

      // Create trajectory line if applicable
      if (this.shouldShowTrajectory(body)) {
        if (body.trajectory instanceof CompositeTrajectory) {
          // Multi-arc: create one TrajectoryLine per arc so they render independently
          this.buildCompositeTrajectoryLines(body, body.trajectory);
        } else {
          // Standard single trajectory
          let trajOpts = { ...this.options.trajectoryOptions };
          const plotCfg = body.trajectoryPlot;

          // If catalog specifies explicit duration, use it. Otherwise derive from orbit period.
          if (plotCfg?.duration && plotCfg.duration > 0) {
            trajOpts.trailDuration = plotCfg.duration;
          } else {
            const exactPeriod = body.trajectory.period;
            let orbitPeriod = exactPeriod ?? 0;
            if (!orbitPeriod) {
              const state = body.stateAt(this.timeController.et);
              const r = Math.sqrt(state.position[0] ** 2 + state.position[1] ** 2 + state.position[2] ** 2);
              const v = Math.sqrt(state.velocity[0] ** 2 + state.velocity[1] ** 2 + state.velocity[2] ** 2);
              orbitPeriod = (r > 0 && v > 0) ? 2 * Math.PI * r / v : 0;
            }

            // Default = 0.99 × period (matching Cosmographia).
            // Cap at 10 years to keep sampling density reasonable.
            const MAX_TRAIL = 86400 * 365.25 * 10;
            if (orbitPeriod > 0) {
              trajOpts.trailDuration = Math.min(orbitPeriod * 0.99, MAX_TRAIL);
            }
          }

          // Apply catalog lead duration
          if (plotCfg?.lead != null) trajOpts.leadDuration = plotCfg.lead;
          else if (trajOpts.leadDuration == null) trajOpts.leadDuration = 0;

          // Apply catalog sample count
          if (plotCfg?.sampleCount) trajOpts.maxPoints = plotCfg.sampleCount;

          // Apply catalog opacity
          if (plotCfg?.opacity != null) trajOpts.opacity = plotCfg.opacity;

          // Apply catalog fade fraction
          if (plotCfg?.fade != null) trajOpts.fadeFraction = plotCfg.fade;

          const tl = new TrajectoryLine(body, trajOpts);
          tl.layers.set(OVERLAY_LAYER);
          tl.traverse(c => c.layers.set(OVERLAY_LAYER));
          this.trajectoryLines.set(body.name, tl);
          this.scene.add(tl);

          // Event markers (periapsis/apoapsis) disabled for now — revisit when
          // we have subsystem zoom and per-body marker configuration.
        }
      }

    }

    // Sun light
    const sun = this.bodyMeshes.get('Sun');
    if (sun) {
      this.sunLight = new THREE.PointLight(0xffffff, 2, 0, 0);
      this.sunLight.layers.enableAll();
      this.sunLight.position.copy(sun.position);
      this.scene.add(this.sunLight);
    }

    // Star field
    if (this.options.showStars !== false) {
      this.starField = new StarField(this.options.starFieldOptions);
      this.scene.add(this.starField);
    }

    // Labels
    if (this.options.showLabels !== false) {
      this.labelManager = new LabelManager(this.labelContainer, this.options.labelOptions);
      for (const bm of this.bodyMeshes.values()) {
        this.labelManager.addLabel(bm);
      }
    }
  }

  /**
   * If a Sensor body has a spiceId and SPICE is available, enrich its geometryData
   * with FOV parameters (shape, horizontalFov, verticalFov) derived from the IK kernel.
   * Catalog-specified values take precedence — SPICE only fills in what's missing.
   * Returns the SPICE instrument frame name if available (for caching on SensorFrustum).
   */
  private enrichSensorFromSpice(body: Body): string | undefined {
    const geo = body.geometryData as Record<string, unknown> | undefined;
    if (!geo) return;
    const spiceId = geo.spiceId as number | undefined;
    if (spiceId == null) return;
    const spice = this.universe.spiceInstance;
    if (!spice) return;

    try {
      const fov = spice.getfov(spiceId);

      // Cache the frame name for per-frame pxform calls (avoids calling getfov every frame)
      const fovFrame = fov.frame;

      // Derive shape if not specified in catalog
      if (!geo.shape) {
        geo.shape = fov.shape === 'RECTANGLE' ? 'rectangular' : 'elliptical';
      }

      // Derive FOV angles from boundary vectors if not specified in catalog
      if (geo.horizontalFov == null || geo.verticalFov == null) {
        const bs = fov.boresight;
        if (fov.shape === 'RECTANGLE' && fov.bounds.length >= 1) {
          // Decompose first corner boundary vector relative to boresight
          // Bounds are in the instrument frame; boresight is typically +Z
          const b = fov.bounds[0];
          const along = b[0] * bs[0] + b[1] * bs[1] + b[2] * bs[2];
          // Build perpendicular axes: use the cross product to find "right" and "up"
          // For boresight near +Z, right ≈ X, up ≈ Y
          const bsLen = Math.sqrt(bs[0] ** 2 + bs[1] ** 2 + bs[2] ** 2);
          const refUp = Math.abs(bs[1] / bsLen) < 0.9 ? [0, 1, 0] : [1, 0, 0];
          const right = [
            bs[1] * refUp[2] - bs[2] * refUp[1],
            bs[2] * refUp[0] - bs[0] * refUp[2],
            bs[0] * refUp[1] - bs[1] * refUp[0],
          ];
          const rLen = Math.sqrt(right[0] ** 2 + right[1] ** 2 + right[2] ** 2);
          right[0] /= rLen; right[1] /= rLen; right[2] /= rLen;
          const up = [
            bs[1] * right[2] - bs[2] * right[1],
            bs[2] * right[0] - bs[0] * right[2],
            bs[0] * right[1] - bs[1] * right[0],
          ];
          const hComp = Math.abs(b[0] * right[0] + b[1] * right[1] + b[2] * right[2]);
          const vComp = Math.abs(b[0] * up[0] + b[1] * up[1] + b[2] * up[2]);
          if (geo.horizontalFov == null) geo.horizontalFov = Math.atan2(hComp, along) * 2 * 180 / Math.PI;
          if (geo.verticalFov == null) geo.verticalFov = Math.atan2(vComp, along) * 2 * 180 / Math.PI;
        } else if (fov.bounds.length >= 1) {
          // CIRCLE, ELLIPSE, POLYGON: use angular separation from boresight
          const dot = bs[0] * fov.bounds[0][0] + bs[1] * fov.bounds[0][1] + bs[2] * fov.bounds[0][2];
          const halfAngle = Math.acos(Math.min(1, Math.abs(dot)));
          const fovDeg = halfAngle * 2 * 180 / Math.PI;
          if (geo.horizontalFov == null) geo.horizontalFov = fovDeg;
          if (geo.verticalFov == null) {
            if (fov.shape === 'ELLIPSE' && fov.bounds.length >= 2) {
              const dot2 = bs[0] * fov.bounds[1][0] + bs[1] * fov.bounds[1][1] + bs[2] * fov.bounds[1][2];
              geo.verticalFov = Math.acos(Math.min(1, Math.abs(dot2))) * 2 * 180 / Math.PI;
            } else {
              geo.verticalFov = fovDeg;
            }
          }
        }
      }
      return fovFrame;
    } catch {
      // IK kernel not loaded or instrument ID not found — use catalog values
      return undefined;
    }
  }

  private buildCompositeTrajectoryLines(body: Body, composite: CompositeTrajectory): void {
    for (let i = 0; i < composite.arcs.length; i++) {
      const arc = composite.arcs[i];

      // Skip degenerate arcs (failed xyzv load → FixedPoint(0,0,0))
      try {
        const mid = (arc.startTime + arc.endTime) / 2;
        const s = arc.trajectory.stateAt(mid);
        const mag = Math.abs(s.position[0]) + Math.abs(s.position[1]) + Math.abs(s.position[2]);
        if (mag === 0) continue;
      } catch { continue; }

      const arcPeriod = arc.trajectory.period ?? 0;
      const arcDuration = arc.endTime - arc.startTime;
      const arcCenterName = arc.centerName;

      // Resolver returns positions relative to the arc's center body.
      // The trajectory line's Object3D position is set to the center body's absolute
      // position each frame (in the update loop), so we only emit relative coords here.
      // This avoids Float32 precision loss for arcs around distant planets.
      const arcResolver = (_name: string, t: number): [number, number, number] => {
        const state = arc.trajectory.stateAt(t);
        return [state.position[0], state.position[1], state.position[2]];
      };

      const plotCfg = body.trajectoryPlot;

      // Determine trail duration: use catalog value if specified, otherwise estimate from
      // orbit period or cap at 1 year. Showing the entire multi-year arc wastes vertex budget
      // on distant segments and produces coarse close-up detail.
      let trailDur: number;
      if (plotCfg?.duration && plotCfg.duration > 0) {
        trailDur = plotCfg.duration;
      } else if (arcPeriod > 0) {
        trailDur = arcPeriod * 0.99;
      } else {
        // Estimate period from state at midpoint
        const mid = (arc.startTime + arc.endTime) / 2;
        const s = arc.trajectory.stateAt(mid);
        const r = Math.sqrt(s.position[0] ** 2 + s.position[1] ** 2 + s.position[2] ** 2);
        const v = Math.sqrt(s.velocity[0] ** 2 + s.velocity[1] ** 2 + s.velocity[2] ** 2);
        const estPeriod = (r > 0 && v > 0) ? 2 * Math.PI * r / v : 0;
        trailDur = estPeriod > 0
          ? Math.min(estPeriod * 0.99, 365.25 * 86400)  // cap at 1 year
          : Math.min(arcDuration, 365.25 * 86400);
      }

      // Last arc can extrapolate freely (body position does too);
      // intermediate arcs cap at endTime to avoid overlap with the next arc.
      const isLastArc = i === composite.arcs.length - 1;

      const tl = new TrajectoryLine(body, {
        trailDuration: trailDur,
        leadDuration: 0,
        minTime: arc.startTime,
        maxTime: isLastArc ? undefined : arc.endTime,
        fixedResolver: arcResolver,
        fadeFraction: plotCfg?.fade ?? 1.0,
      });
      // Tag with arc center name so the update loop can position it correctly
      (tl as any)._arcCenterName = arcCenterName;
      tl.layers.set(OVERLAY_LAYER);
      tl.traverse(c => c.layers.set(OVERLAY_LAYER));
      this.trajectoryLines.set(`${body.name}__arc${i}`, tl);
      this.scene.add(tl);
    }
  }

  private shouldShowTrajectory(body: Body): boolean {
    if (this.options.showTrajectories === false) return false;

    // Respect catalog's trajectoryPlot.visible setting
    if (body.trajectoryPlot?.visible === false) return false;

    // Skip degenerate trajectories: sample position at two times and reject if always at origin.
    // This catches FixedPoint(0,0,0), CompositeTrajectory with all-broken arcs,
    // InterpolatedStates without data, failed SPICE, etc.
    try {
      const et = this.timeController.et;
      const s1 = body.stateAt(et);
      const s2 = body.stateAt(et + 86400);
      const mag1 = Math.abs(s1.position[0]) + Math.abs(s1.position[1]) + Math.abs(s1.position[2]);
      const mag2 = Math.abs(s2.position[0]) + Math.abs(s2.position[1]) + Math.abs(s2.position[2]);
      if (mag1 === 0 && mag2 === 0) return false;
    } catch {
      return false;
    }

    if (this.options.trajectoryFilter) return this.options.trajectoryFilter(body);
    // Default: show trajectories for all bodies except stars and barycenters
    return !EXCLUDED_TRAJECTORY_CLASSES.has(body.classification ?? '');
  }

  /**
   * Resolve level-0 tile URLs from a NameTemplate or MultiWMS baseMap spec.
   * Level 0 = 2 columns × 1 row (two equirectangular half-globe tiles).
   */
  private resolveTileUrls(
    spec: Record<string, unknown>,
    resolver: (source: string) => string | undefined,
  ): [string, string] | undefined {
    let template: string | undefined;

    if (spec.type === 'NameTemplate' && typeof spec.template === 'string') {
      // Pattern: "textures/mars/mars_%level_%column_%row.dds"
      template = spec.template as string;
      // Generate level-0 tile paths (2 columns, 1 row)
      const tile0 = template.replace('%level', '0').replace('%column', '0').replace('%row', '0');
      const tile1 = template.replace('%level', '0').replace('%column', '1').replace('%row', '0');
      const url0 = resolver(tile0);
      const url1 = resolver(tile1);
      if (url0 && url1) return [url0, url1];
    }

    if (spec.type === 'MultiWMS' && typeof spec.topLayer === 'string') {
      // Pattern: "textures/earth/bmng-feb-nb_%1_%2_%3.jpg" (%1=level, %2=column, %3=row)
      template = spec.topLayer as string;
      const tile0 = template.replace('%1', '0').replace('%2', '0').replace('%3', '0');
      const tile1 = template.replace('%1', '0').replace('%2', '1').replace('%3', '0');
      const url0 = resolver(tile0);
      const url1 = resolver(tile1);
      if (url0 && url1) return [url0, url1];
    }

    return undefined;
  }

  /** Double-click handler: fly to the clicked body or label */
  private _onDblClick = (event: MouseEvent): void => {
    if (!this._dblClickRaycaster) return;

    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );

    this._dblClickRaycaster.setFromCamera(mouse, this.camera);

    // Collect raycast targets: body meshes + label sprites
    const targets: THREE.Object3D[] = [...this.bodyMeshes.values()];
    if (this.labelManager) {
      targets.push(...this.labelManager.getSprites());
    }

    const hits = this._dblClickRaycaster.intersectObjects(targets, true);
    if (hits.length === 0) return;

    // Resolve hit to a body name
    let bodyName: string | undefined;

    // Check if it's a label sprite
    if (this.labelManager) {
      bodyName = this.labelManager.resolveSprite(hits[0].object);
    }

    // If not a label, walk up the parent chain to find the BodyMesh
    if (!bodyName) {
      let obj = hits[0].object;
      while (obj.parent && !this.bodyMeshes.has(obj.name)) {
        obj = obj.parent;
      }
      if (this.bodyMeshes.has(obj.name)) bodyName = obj.name;
    }

    if (bodyName) {
      const bm = this.bodyMeshes.get(bodyName);
      if (bm) {
        this.cameraController.flyTo(bm, { scaleFactor: this.scaleFactor });
      }
    }
  };

  private renderLoop = (): void => {
    this.animFrameId = requestAnimationFrame(this.renderLoop);
    this.renderFrame();
  };
}
