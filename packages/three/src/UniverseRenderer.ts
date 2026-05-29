import * as THREE from 'three';
import { CompositeTrajectory, SpiceTrajectory, WaypointTrajectory, EventBus, type Universe, type Body } from '@cosmolabe/core';
import { BodyMesh } from './BodyMesh.js';
import { RingMesh } from './RingMesh.js';
import { TrajectoryLine, type TrajectoryLineOptions } from './TrajectoryLine.js';
import { TrajectoryCache } from './TrajectoryCache.js';
import type { SpiceCacheWorker, CacheBuildRequest } from './SpiceCacheWorker.js';
import { SensorFrustum } from './SensorFrustum.js';
import { InstrumentView, type InstrumentViewOptions } from './InstrumentView.js';
import { EventMarkers } from './EventMarkers.js';
import { AtmosphereMesh, resolveAtmosphereParams } from './AtmosphereMesh.js';
import { makeAerialPerspectiveUniforms, type AerialPerspectiveUniforms } from './AerialPerspective.js';
import { StarField, type StarFieldOptions } from './StarField.js';
import { LabelManager, type LabelManagerOptions } from './LabelManager.js';
import { CameraController } from './controls/CameraController.js';
import { CameraModeName } from './controls/CameraModes.js';
import type { InstrumentMode } from './controls/modes/InstrumentMode.js';
import { TimeController } from './controls/TimeController.js';
import type { TerrainConfig } from './TerrainManager.js';
import type { SurfaceTileConfig } from './SurfaceTileOverlay.js';
import { BloomEffect, type BloomConfig } from './BloomEffect.js';
import type { RendererPlugin } from './plugins/RendererPlugin.js';
import type { RendererContext } from './plugins/RendererContext.js';
import type { BodyVisualizer } from './plugins/BodyVisualizer.js';
import type { AttachedVisual, AttachOptions } from './plugins/AttachedVisual.js';
import type { RendererEventMap } from './events/RendererEventMap.js';

// Reusable temporaries for clampCameraAboveSurfaces (avoid per-frame allocation)
const _clampTmpVec = /* @__PURE__ */ new THREE.Vector3();
const _clampTmpVec2 = /* @__PURE__ */ new THREE.Vector3();
const _clampTmpQuat = /* @__PURE__ */ new THREE.Quaternion();
const _tmpRingNormal = /* @__PURE__ */ new THREE.Vector3();

export interface SurfacePickResult {
  /** Name of the body that was clicked */
  bodyName: string;
  /** Geodetic latitude in degrees (positive north) */
  latDeg: number;
  /** Geodetic longitude in degrees (positive east) */
  lonDeg: number;
  /** Altitude above the reference sphere in km */
  altKm: number;
  /** Distance from camera to pick point in km */
  cameraDistanceKm: number;
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
  /** Show sensor frustum visualizations (default true) */
  showSensors?: boolean;
  /** Show sensor frustum labels (default true). Has no visible effect when showSensors is false. */
  showSensorLabels?: boolean;
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
  /** Optional Web Worker for async trajectory cache builds.
   *  When provided, spacecraft caches are built off the main thread and
   *  hot-swapped onto trajectory lines when ready. */
  cacheWorker?: SpiceCacheWorker;
  /** Selective bloom / Sun glare. Pass `{ enabled: true }` to opt in;
   *  bodies marked emissive (Sun, stars) are auto-routed to the bloom layer.
   *  Default: disabled. */
  bloom?: BloomConfig;
  /** Custom geometry-type visualizers (Pattern D). Registered BEFORE the
   *  initial buildScene() so bodies with matching geometryType render via the
   *  visualizer instead of the default placeholder sphere. Equivalent to
   *  calling `useVisualizer(...)` for each before any bodies are processed. */
  visualizers?: BodyVisualizer[];
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
  /** One AP uniform set per atmosphere body, shared between body sphere + terrain materials. */
  private readonly aerialPerspectiveUniforms = new Map<string, AerialPerspectiveUniforms>();
  private _coverageWarned = false;
  private _lastOriginAbsPos: [number, number, number] = [0, 0, 0];
  private readonly plugins: RendererPlugin[] = [];
  private readonly options: UniverseRendererOptions;
  private readonly cacheWorker?: SpiceCacheWorker;
  private _ctx!: RendererContext;

  private labelManager: LabelManager | null = null;
  private _dprMediaQuery: MediaQueryList | null = null;
  private starField: StarField | null = null;
  private ambientLight: THREE.AmbientLight | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
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
  /** Selective bloom / Sun glare overlay (null when disabled). */
  private bloomEffect: BloomEffect | null = null;
  /** Current global show-sensors state — applied to every sensor frustum. */
  private _sensorsVisible = true;
  /** Current global sensor-label state — applied to each frustum's label sprite. */
  private _sensorLabelsVisible = true;

  /** Renderer-level event bus. Forwards universe events and adds renderer-specific events. */
  readonly events = new EventBus<RendererEventMap>();

  // Body visualizer registry (Pattern D)
  private readonly _visualizers = new Map<string, BodyVisualizer>();
  private readonly _customVisuals = new Map<string, THREE.Object3D>();

  // Attached visuals (Pattern F)
  private readonly _attachedVisuals: Array<{
    bodyName: string;
    object: THREE.Object3D;
    followRotation: boolean;
    autoHide: boolean;
  }> = [];

  constructor(
    canvas: HTMLCanvasElement,
    universe: Universe,
    options: UniverseRendererOptions = {},
  ) {
    this.universe = universe;
    this.options = options;
    this.scaleFactor = options.scaleFactor ?? 1e-6;
    this.minBodyPixels = options.minBodyPixels ?? 4;
    this.cacheWorker = options.cacheWorker;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: options.antialias ?? true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    // Watch for devicePixelRatio changes — fires when the window is dragged
    // across monitors with different DPI scaling. Without this, the WebGL
    // backing store stays at the original DPR and the browser upscales it
    // (blurry), and label canvas textures stay sized for the original DPR.
    this._watchDevicePixelRatio();
    // Shadow maps for small mesh-on-terrain shadows (helicopter, drones, etc.).
    // Driven by the model-shadow DirectionalLight set up alongside the sun
    // PointLight; planet/moon eclipse shadows go through the analytical
    // EclipseShadow shader, not these.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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

    // Forward universe events on the renderer event bus
    for (const event of ['time:change', 'body:added', 'body:removed', 'body:trajectoryChanged', 'body:rotationChanged', 'catalog:loaded'] as const) {
      universe.events.on(event, (data: any) => this.events.emit(event, data));
    }

    // Create renderer context for plugins
    this._ctx = {
      scene: this.scene,
      camera: this.camera,
      webglRenderer: this.renderer,
      canvas,
      universe: this.universe,
      scaleFactor: this.scaleFactor,
      events: this.events,
      state: this.universe.state,
      getBodyMesh: (name: string) => this.bodyMeshes.get(name),
      getTrajectoryLine: (name: string) => this.trajectoryLines.get(name),
      renderFrame: () => this.renderFrame(),
      attachToBody: (bodyName: string, object: THREE.Object3D, options?: AttachOptions): AttachedVisual => {
        this.scene.add(object);
        const entry = {
          bodyName,
          object,
          followRotation: options?.followRotation ?? false,
          autoHide: options?.autoHide ?? true,
        };
        this._attachedVisuals.push(entry);
        return {
          object,
          bodyName,
          detach: () => {
            this.scene.remove(object);
            const idx = this._attachedVisuals.indexOf(entry);
            if (idx >= 0) this._attachedVisuals.splice(idx, 1);
          },
        };
      },
    };

    // Listen for trajectory changes to invalidate cached trail samples
    universe.events.on('body:trajectoryChanged', ({ body }) => {
      // Invalidate all trajectory lines for this body (including composite arc lines)
      for (const tl of this.trajectoryLines.values()) {
        if (tl.body === body) tl.invalidate();
      }
    });

    // Selective bloom / Sun glare. Constructed before buildScene so emissive
    // bodies can be routed onto BLOOM_LAYER as they're added.
    if (options.bloom?.enabled) {
      this.bloomEffect = new BloomEffect(
        this.renderer, this.scene, this.camera,
        canvas.clientWidth, canvas.clientHeight,
        options.bloom,
      );
    }

    // Register custom-geometry visualizers BEFORE buildScene so matching
    // bodies are routed to the visualizer instead of getting a default mesh.
    if (options.visualizers) {
      for (const vis of options.visualizers) {
        this._visualizers.set(vis.geometryType, vis);
      }
    }

    // Build scene from universe
    this.buildScene();

    // Single + double click: pick body and emit corresponding event. Click
    // emits synchronously so selection feels instant; dblclick fires after the
    // native browser dblclick (which always follows one or two `click` events).
    // Consumer selection handlers should be idempotent.
    this._dblClickRaycaster = new THREE.Raycaster();
    canvas.addEventListener('click', this._onClick);
    canvas.addEventListener('dblclick', this._onDblClick);
  }

  use(plugin: RendererPlugin): void {
    this.plugins.push(plugin);
    this.universe.use(plugin);
    plugin.onSceneSetup?.(this._ctx);
  }

  /** Get all registered plugins (read-only). */
  getPlugins(): readonly RendererPlugin[] {
    return this.plugins;
  }

  /** Get the renderer context (for plugin UI slot execution). */
  getContext(): RendererContext {
    return this._ctx;
  }

  /** Register a custom geometry type visualizer. */
  useVisualizer(vis: BodyVisualizer): void {
    this._visualizers.set(vis.geometryType, vis);
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
    //
    // If the origin body has no coverage at this time (e.g. SPK gap), use the last
    // valid origin position. This keeps the camera stable — no jump — and lets other
    // bodies (moons, planets) continue rendering. The origin body simply disappears
    // during the gap and reappears when coverage resumes.
    const originBodyName = this.cameraController.originBody?.body.name;
    let originAbsPos: [number, number, number] = originBodyName
      ? this.absolutePositionOf(originBodyName, et)
      : [0, 0, 0];
    if (isNaN(originAbsPos[0])) {
      // Reuse last valid origin position — avoids camera jump on coverage gaps
      originAbsPos = this._lastOriginAbsPos;
      if (!this._coverageWarned) {
        console.warn(`[Cosmolabe] No coverage for ${originBodyName} at ET=${et.toFixed(0)} — holding last origin position`);
        this._coverageWarned = true;
      }
    } else {
      this._lastOriginAbsPos = originAbsPos;
      this._coverageWarned = false;
    }

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
        // Surface-locked bodies (rovers, landers): always show the model at full
        // opacity. They're tiny at planetary scale but there's no reason to hide
        // real geometry behind a placeholder dot — the model renders as a speck
        // until you're close enough to resolve it, same as in reality.
        const isSurfaceLocked = !!bm.body.geometryData?.surfaceLock;
        if (isSurfaceLocked || screenPixels >= MODEL_SHOW_PX) {
          bm.setModelVisible(true);
          bm.mesh.visible = false;
          const opacity = isSurfaceLocked
            ? 1
            : Math.min(1, (screenPixels - MODEL_SHOW_PX) / (MODEL_FADE_PX - MODEL_SHOW_PX));
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

    // Clamp surface-locked bodies (rovers, landers) to the parent's terrain surface.
    // The body's SPICE trajectory gives the surface position, but ellipsoid-vs-sphere
    // and terrain LOD mismatches can make it float or clip. This adjusts the radial
    // distance to match the rendered terrain.
    this.clampSurfaceLockedBodies();

    // Now that body positions are fresh under the new origin, re-derive any
    // stateful camera mode (Surface Explorer) from the current camera position.
    // Pairs with applyPendingOriginSwitch above; if we synced there, body
    // positions were still stale and the mode would compute wrong lat/lon.
    this.cameraController.syncPendingModeFromCamera();

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
        // Push ring frame to the parent body so its fragment shader can
        // project ring opacity onto the body as a shadow stripe.
        _tmpRingNormal.set(0, 1, 0).applyQuaternion(parentBm.mesh.quaternion);
        parentBm.setRingShadowFrame(parentBm.position, _tmpRingNormal);
      }
    }

    // Update atmosphere shells (follow parent body position, pass camera + sun)
    let maxSkyBrightness = 0;
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
          const b = atm.getDaytimeSkyBrightness();
          if (b > maxSkyBrightness) maxSkyBrightness = b;

          // Aerial perspective uniforms — refresh per frame so terrain compositing
          // tracks the sun and camera. Coefficients are scaled to 1/scene-unit.
          const apu = this.aerialPerspectiveUniforms.get(parentName);
          if (apu) {
            const sf = this.scaleFactor;
            apu.uAPCameraWorldPos.value.copy(this.camera.position);
            apu.uAPSunWorldPos.value.copy(sunPos);
            apu.uAPPlanetWorldPos.value.copy(parentBm.position);
            apu.uAPPlanetRadius.value = atm.planetRadius * sf;
            apu.uAPShellRadius.value = atm.shellRadius * sf;
            const p = atm.params;
            apu.uAPRayleighCoeff.value.set(
              p.rayleighCoeff[0] / sf,
              p.rayleighCoeff[1] / sf,
              p.rayleighCoeff[2] / sf,
            );
            const mieRGB: [number, number, number] = typeof p.mieCoeff === 'number'
              ? [p.mieCoeff, p.mieCoeff, p.mieCoeff]
              : p.mieCoeff;
            apu.uAPMieCoeff.value.set(mieRGB[0] / sf, mieRGB[1] / sf, mieRGB[2] / sf);
            apu.uAPExtinctionCoeff.value.set(
              (p.rayleighCoeff[0] + p.absorptionCoeff[0] + mieRGB[0]) / sf,
              (p.rayleighCoeff[1] + p.absorptionCoeff[1] + mieRGB[1]) / sf,
              (p.rayleighCoeff[2] + p.absorptionCoeff[2] + mieRGB[2]) / sf,
            );
            // Schlick g→k (matches AtmosphereMesh).
            const g = p.miePhaseAsymmetry;
            apu.uAPMieK.value = 1.55 * g - 0.55 * g * g * g;
            apu.uAPInvScaleH.value = 1 / (p.mieScaleHeight * sf);
            // Strength fades out fast with altitude. AP and AtmosphereMesh both
            // scatter along view rays — past the surface boundary layer (single
            // scale-height worth of altitude) AP would only double-count what
            // the shell shader already does and at long horizon-grazing paths
            // would over-fog distant terrain. Earth: ~0 above ~10km AGL.
            const camToPlanet = this.camera.position.distanceTo(parentBm.position);
            const altScene = camToPlanet - atm.planetRadius * sf;
            const scaleHeightScene = p.mieScaleHeight * sf;
            const tt = altScene / Math.max(1e-6, scaleHeightScene);
            apu.uAPStrength.value = Math.max(0, Math.min(1, 1 - tt));
          }
        }
      }
    }
    // Fade the additive star field under a sunlit atmosphere so daytime stars
    // don't bleed through. 0 outside any atmosphere — orbital views unchanged.
    this.starField?.setSkyBrightness(maxSkyBrightness);

    // Update trajectory lines.
    // Vertices are offset in Float64 (km) so they're near origin in scene space,
    // eliminating Float32 precision jitter on the GPU.
    for (const tl of this.trajectoryLines.values()) {
      try {
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
      } catch (err) {
        console.error(`[Cosmolabe] Trail update error for ${tl.body.name}:`, err);
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
      // Try SPICE-based orientation using cached FOV frame (from enrichSensorFromSpice).
      // Use the sensor's inertial frame (J2000 or ECLIPJ2000) to match scene positions.
      let spiceRot: number[] | undefined;
      if (sf.spiceFovFrame && spiceInst) {
        try {
          spiceRot = spiceInst.pxform(sf.spiceFovFrame, sf.spiceInertialFrame, et) as unknown as number[];
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
    const bodyMeshArr = Array.from(this.bodyMeshes.values());
    if (this.labelManager) {
      this.labelManager.update(
        bodyMeshArr,
        this.camera,
        { width: this.renderer.domElement.clientWidth, height: this.renderer.domElement.clientHeight },
      );

      // Apply occlusion fade to sensor frustum labels
      const camPos = this.camera.position;
      for (const sf of this.sensorFrustums.values()) {
        const dist = sf.position.distanceTo(camPos);
        this.labelManager.applyOcclusionFade(
          sf.labelSprite, sf.position, dist, bodyMeshArr, camPos,
        );
      }
    }

    // Update sun light position + shadow camera frustum. The light shines from
    // the sun toward the (first) body flagged with castShadow; the shadow
    // camera is a tight ortho frustum around that body so the helicopter /
    // drone casts a real silhouette on the parent body's terrain.
    if (this.sunLight) {
      const sun = this.bodyMeshes.get('Sun');
      if (sun) this.updateSunLightAndShadow(sun);
    }

    this.updateShadowOccluders();

    // Adapt camera speeds to altitude above nearest body (before controls process input)
    this.cameraController.adaptSpeeds(this.bodyMeshes.values(), this.scaleFactor);

    // Provide SPICE + universe context for camera modes
    this.cameraController.setModeContext(
      spiceInst ?? null, et, this.scaleFactor, this.bodyMeshes,
      (ndcX: number, ndcY: number) => this.pickSurface(ndcX, ndcY),
      this._markerScene,
    );

    // Camera
    this.cameraController.update();

    // Prevent camera from going inside any body's surface
    this.clampCameraAboveSurfaces();

    // Plugins — before render
    for (const plugin of this.plugins) {
      plugin.onBeforeRender?.(et, this._ctx);
    }

    // Update attached visuals — position them relative to their parent body
    this.updateAttachedVisuals(et);

    // Update custom body visuals (from BodyVisualizer registry)
    this.updateCustomVisuals(et);

    // Dynamic near/far. The log depth buffer handles depth precision across cosmic
    // scales, so the near plane only affects geometry clipping. Use a small multiplier
    // (1e-8) so terrain within meters of the camera isn't clipped at ground level
    // (the old 1e-5 multiplier produced a 34m near plane at Mars surface).
    const camDist = this.camera.position.distanceTo(this.cameraController.controls.target);
    this.camera.near = Math.max(1e-12, camDist * 1e-8);
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
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
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

    // Instrument view — PiP or full-screen depending on camera mode
    const isInstrumentMode = this.cameraController.mode === CameraModeName.INSTRUMENT;
    if (isInstrumentMode && this.instrumentView) {
      // In instrument camera mode: if no sensor is active yet, try to activate from the mode params
      if (!this.instrumentView.active) {
        const instrMode = this.cameraController.getModeInstance<InstrumentMode>(CameraModeName.INSTRUMENT);
        if (instrMode?.sensorName) {
          this.setInstrumentView(instrMode.sensorName);
        }
      }
      this.instrumentView.fullScreen = true;
    } else if (this.instrumentView) {
      this.instrumentView.fullScreen = false;
    }

    if (this.instrumentView?.active) {
      try {
        const sf = this.sensorFrustums.get(this.instrumentView.sensorName!);
        if (sf) {
          const targetBody = sf.targetName ? this.universe.getBody(sf.targetName) : undefined;
          let spiceRot: number[] | undefined;
          if (sf.spiceFovFrame && spiceInst) {
            try {
              spiceRot = spiceInst.pxform(sf.spiceFovFrame, sf.spiceInertialFrame, et) as unknown as number[];
            } catch { /* no CK coverage */ }
          }
          this.instrumentView.update(et, this.scaleFactor, originRelResolver, targetBody, spiceRot);
          this.instrumentView.render(this.renderer, this.scene);
        }
      } catch (err) {
        console.warn('[Cosmolabe] Instrument PiP render error:', err);
      }
    }

    // Final pass: markers (pick marker, orbit pivot dot, etc.) — always on top.
    if (this._markerScene.children.length > 0) {
      this.renderer.render(this._markerScene, this.camera);
    }

    // Bloom / Sun glare overlay — additive composite of BLOOM_LAYER objects.
    // Skip when an instrument PiP fully covers the canvas.
    if (this.bloomEffect && !(this.instrumentView?.active && this.instrumentView.fullScreen)) {
      this.bloomEffect.render();
    }

    // Plugins — after render
    for (const plugin of this.plugins) {
      plugin.onAfterRender?.(et, this._ctx);
    }

    // Plugins — overlay update
    for (const plugin of this.plugins) {
      plugin.onOverlayUpdate?.(et, this.labelContainer, this._ctx);
    }

  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.instrumentView?.onResize();
    this.bloomEffect?.setSize(width, height);
    this.events.emit('renderer:resize', { width, height });
    for (const plugin of this.plugins) {
      plugin.onResize?.(width, height);
    }
  }

  private _watchDevicePixelRatio(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    this._dprMediaQuery?.removeEventListener('change', this._onDprChange);
    this._dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this._dprMediaQuery.addEventListener('change', this._onDprChange);
  }

  private _onDprChange = (): void => {
    const dpr = window.devicePixelRatio;
    this.renderer.setPixelRatio(dpr);
    this.bloomEffect?.setSize(this.renderer.domElement.clientWidth, this.renderer.domElement.clientHeight);
    this.labelManager?.refreshTextures();
    // Rebind the media query against the new DPR so the next monitor change fires.
    this._watchDevicePixelRatio();
  };

  /** Get the bloom effect (null when disabled). */
  getBloomEffect(): BloomEffect | null {
    return this.bloomEffect;
  }

  /**
   * Toggle or update the bloom / Sun glare effect at runtime.
   * Pass `{ enabled: true }` to lazily construct it on first call.
   */
  setBloom(config: BloomConfig): void {
    if (config.enabled && !this.bloomEffect) {
      const canvas = this.renderer.domElement;
      this.bloomEffect = new BloomEffect(
        this.renderer, this.scene, this.camera,
        canvas.clientWidth, canvas.clientHeight,
        config,
      );
      return;
    }
    this.bloomEffect?.setConfig(config);
  }

  getBodyMesh(name: string): BodyMesh | undefined {
    return this.bodyMeshes.get(name);
  }

  getTrajectoryLine(name: string): TrajectoryLine | undefined {
    return this.trajectoryLines.get(name);
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
      console.warn(`[Cosmolabe] No sensor frustum found for "${sensorName}"`);
      return;
    }

    // Create InstrumentView on first use
    if (!this.instrumentView) {
      this.instrumentView = new InstrumentView(
        this.renderer.domElement.parentElement!,
        options,
      );
    }

    // Try to get FOV boundary from SPICE for drawing the actual sensor footprint
    let fovBoundary: import('./InstrumentView.js').FovBoundary | undefined;
    const geo = sf.body.geometryData as Record<string, unknown> | undefined;
    const spiceId = geo?.spiceId as number | undefined;
    const spice = this.universe.spiceInstance;
    if (spiceId != null && spice) {
      try {
        const fov = spice.getfov(spiceId);
        fovBoundary = {
          shape: fov.shape,
          boresight: fov.boresight,
          bounds: fov.bounds,
        };
      } catch { /* IK not loaded */ }
    }

    this.instrumentView.setSensor(sf, fovBoundary);
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

  // Note: previous calibration helpers (dumpAbsoluteAlts, dumpGeoidCalibration,
  // dumpAirfieldsCalibration) were removed when the Ingenuity preprocessor
  // switched from "calibrate trajectory to currently-rendered terrain" to
  // "bake trajectory against the IAU Mars ellipsoid + MMGIS Elev_Geoid
  // analytically." The trajectory is now data-correct against MOLA regardless
  // of any specific terrain renderer's mesh registration. If a renderer's
  // mesh disagrees with MOLA, address it by swapping the terrain source.


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

  /**
   * Pin or unpin a body's label. Pinned labels survive the screen-space
   * collision pass and skip the NASA-Eyes self-size fade — they always
   * render unless geometrically occluded. Typical use: pin the currently
   * selected and camera-tracked bodies so the user's focus reads even when
   * a higher-priority planet would otherwise win collision arbitration, and
   * even when the body has grown large enough on screen that the self-size
   * fade would normally drop the label. Pass the body's display name.
   */
  setLabelPinned(name: string, pinned: boolean): void {
    this.labelManager?.setLabelPinned(name, pinned);
  }

  /** Unpin all labels (e.g. on selection clear). */
  clearPinnedLabels(): void {
    this.labelManager?.clearPinnedLabels();
  }

  /**
   * Set a multiplicative opacity factor on a single body's label. Composes
   * on top of the automated occlusion / self-size / collision fades, so
   * host apps can dim non-selected labels alongside their non-selected
   * markers / trajectories without fighting cosmolabe's internal logic.
   * Default 1 (no effect).
   */
  setLabelOpacityMultiplier(name: string, multiplier: number): void {
    this.labelManager?.setLabelOpacityMultiplier(name, multiplier);
  }

  /** Show or hide all sensor frustums (and their labels). */
  setSensorsVisible(visible: boolean): void {
    this._sensorsVisible = visible;
    for (const sf of this.sensorFrustums.values()) {
      sf.visible = visible;
    }
  }

  /** Show or hide all sensor frustum labels. No visible effect while sensors are hidden. */
  setSensorLabelsVisible(visible: boolean): void {
    this._sensorLabelsVisible = visible;
    for (const sf of this.sensorFrustums.values()) {
      sf.labelSprite.visible = visible;
    }
  }

  /** Current global sensors-visible state. */
  get sensorsVisible(): boolean { return this._sensorsVisible; }
  /** Current global sensor-labels-visible state. */
  get sensorLabelsVisible(): boolean { return this._sensorLabelsVisible; }

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
    // Apply CRR transforms (camera at origin) before raycasting, then restore.
    const tileRaycaster = new THREE.Raycaster();
    tileRaycaster.setFromCamera(ndc, this.camera);
    tileRaycaster.ray.origin.set(0, 0, 0);
    const tileTargets: THREE.Object3D[] = [];
    const overlayBodyMap = new Map<THREE.Object3D, BodyMesh>();
    const savedGroupState: { overlay: any; pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 }[] = [];
    for (const bm of this.bodyMeshes.values()) {
      for (const overlay of bm.getSurfaceOverlays()) {
        if (overlay.group.visible) {
          // Save current LOD transform
          savedGroupState.push({
            overlay,
            pos: overlay.group.position.clone(),
            quat: overlay.group.quaternion.clone(),
            scale: overlay.group.scale.clone(),
          });
          // Apply CRR transform for raycasting
          overlay.setCameraRelativeTransform(
            bm.position, bm.mesh.quaternion, this.scaleFactor, this.camera.position,
          );
          tileTargets.push(overlay.group);
          overlayBodyMap.set(overlay.group, bm);
        }
      }
    }
    const tileHits = tileRaycaster.intersectObjects(tileTargets, true);
    // Restore LOD transforms
    for (const { overlay, pos, quat, scale } of savedGroupState) {
      overlay.group.position.copy(pos);
      overlay.group.quaternion.copy(quat);
      overlay.group.scale.copy(scale);
      overlay.group.updateMatrixWorld(true);
    }

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
      // CRR tile hits ALWAYS take priority over globe/terrain hits.
      // Surface tiles render on top (depth cleared), so they're what the user sees.
      const hit = tileHits[0];
      bestWorldPoint = hit.point.clone().add(this.camera.position);
      bestBm = null;
      bestDist = hit.distance;
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        const bm = overlayBodyMap.get(obj);
        if (bm) { bestBm = bm; break; }
        obj = obj.parent;
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
    const cameraDistanceKm = bestWorldPoint.distanceTo(this.camera.position) / this.scaleFactor;

    return { bodyName: bm.body.name, latDeg, lonDeg, altKm, cameraDistanceKm };
  }

  /** Cached terrain elevation per body for camera clamp (samples every 5 frames). */
  private _terrainClampCache = new Map<string, { elevationKm: number; frame: number }>();
  /** Cached terrain elevation per surface-locked body (samples every 10 frames). */
  private _surfaceLockElevCache = new Map<string, { elevationKm: number; angularDistDeg: number; frame: number }>();
  /** Per-waypoint terrain elevations cached for WaypointTrajectory bodies in
   *  aboveTerrain mode. Built up as tiles load; once we have ≥1 sample we use
   *  these (interpolated along time) as the ground reference instead of
   *  sampling the body's current local terrain — that keeps the body flying
   *  at constant altitude relative to the takeoff/landing terrain rather than
   *  bobbing with every terrain feature it crosses. Outer key = body name. */
  private _waypointTerrainCache = new Map<string, Map<number, number>>();

  /**
   * Reposition the sun DirectionalLight and its shadow camera frustum.
   * The light's position is the sun. Its target is the first body flagged
   * `castShadow: true` (small spacecraft on a body's surface), so the shadow
   * camera ortho frustum can sit tightly around the caster. With no caster,
   * shadow casting is disabled.
   */
  private updateSunLightAndShadow(sun: BodyMesh): void {
    const light = this.sunLight!;
    light.position.copy(sun.position);

    let caster: BodyMesh | null = null;
    for (const bm of this.bodyMeshes.values()) {
      if (bm.body.geometryData?.castShadow === true) { caster = bm; break; }
    }

    if (!caster) {
      light.castShadow = false;
      light.target.position.set(0, 0, 0);
      light.target.updateMatrixWorld();
      return;
    }

    light.castShadow = true;
    light.target.position.copy(caster.position);
    light.target.updateMatrixWorld();

    // Tight ortho frustum centered on the caster. Sized for small surface
    // assets (helicopter / drone, ~1–2 m mesh, casting a few-m shadow on the
    // adjacent terrain). `scaleFactor` is 1e-6 — 1 m = 1e-9 scene units, so a
    // ±50 m frustum is ±5e-8 (NOT ±5e-5; previous version was 1000× too big,
    // making the 1.2 m helicopter sub-pixel in a 1024² shadow map → invisible).
    const cam = light.shadow.camera;
    const dist = sun.position.distanceTo(caster.position);
    const halfSize = 5e-8;   // ±50 m perpendicular to sun direction
    const halfDepth = 1e-7;  // ±100 m along sun direction
    cam.near = Math.max(1e-9, dist - halfDepth);
    cam.far = dist + halfDepth;
    cam.left = -halfSize;
    cam.right = halfSize;
    cam.top = halfSize;
    cam.bottom = -halfSize;
    cam.updateProjectionMatrix();
  }

  /** Recompute eclipse shadow occluder lists for all bodies and push to shader uniforms. */
  private updateShadowOccluders(): void {
    // Eclipse shadows only apply in natural lighting; flood/shadow modes illuminate uniformly.
    const sunBmAny = this.bodyMeshes.get('Sun');
    if (this._lightingMode !== 'natural') {
      for (const bm of this.bodyMeshes.values()) {
        if (bm.hasShadowReceiving) bm.setShadowOccluders([], new THREE.Vector3(), 0);
      }
      // Rings keep sun-direction shading but drop the eclipse occluders so the
      // look stays consistent with the bodies in flood/shadow modes.
      const sunPosFb = sunBmAny ? sunBmAny.position : new THREE.Vector3();
      const sunRadiusFb = this._sunRadiusKm * this.scaleFactor;
      for (const [, { ring }] of this.ringMeshes) {
        ring.setShadowOccluders([], sunPosFb, sunRadiusFb);
      }
      return;
    }
    const sunBm = sunBmAny;
    if (!sunBm) return;
    const sunPos = sunBm.position;
    const sunRadius = this._sunRadiusKm * this.scaleFactor;

    // Candidate occluders: non-star, non-emissive, large enough to cast a meaningful shadow.
    // Small bodies (spacecraft, drones) use Three.js shadow maps via the dedicated
    // model-shadow DirectionalLight — eclipse-shader occlusion handles only planet/moon scale.
    const candidates = [...this.bodyMeshes.values()].filter(bm =>
      bm.body.classification !== 'star' &&
      bm.body.geometryData?.emissive !== true &&
      bm.displayRadius >= this._shadowMinOccluderKm &&
      // Bodies rendered by a custom visualizer don't have a real sphere — their
      // displayRadius is just a hint for label/flyTo framing, not the actual
      // visual size. Excluding them prevents spurious shadow disks under
      // surface-locked bodies (ground stations, rovers).
      !this._visualizers.has(bm.body.geometryType ?? '') &&
      // Surface-locked bodies sit on (or just above) the parent's surface — handled
      // by the per-mesh shadow map instead of the analytical eclipse shader.
      !bm.body.geometryData?.surfaceLock,
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

    // Rings: top 4 occluders from the ring's perspective. Unlike bodies, the
    // parent planet is NOT filtered out — it sits at the ring's center and is
    // the dominant shadow caster (the dark arc on the night-side rings).
    for (const [, { ring }] of this.ringMeshes) {
      const ringPos = ring.position;
      const ringOccluders = candidates
        .map(c => {
          const dist = Math.max(c.position.distanceTo(ringPos), 1e-20);
          return {
            pos: c.position,
            radius: c.displayRadius * this.scaleFactor,
            angularSize: (c.displayRadius * this.scaleFactor) / dist,
          };
        })
        .sort((a, b) => b.angularSize - a.angularSize)
        .slice(0, 4)
        .map(({ pos, radius }) => ({ pos, radius }));
      ring.setShadowOccluders(ringOccluders, sunPos, sunRadius);
    }
  }

  /**
   * Clamp surface-locked bodies (rovers, landers) to the parent's terrain surface.
   * Adjusts the body's radial distance from its parent so it sits on the rendered terrain.
   */
  private clampSurfaceLockedBodies(): void {
    for (const bm of this.bodyMeshes.values()) {
      if (!bm.body.geometryData?.surfaceLock) continue;
      // surfaceLock = terrain-clamp + always-show-model behavior. Only
      // WaypointTrajectory wants the terrain clamp (its `alt` is authored as
      // height-above-terrain or above-reference, and the renderer pins the
      // body to the sampled terrain). Other trajectory types — InterpolatedStates,
      // SpiceTrajectory, Composite arcs — have absolute Cartesian positions and
      // must NOT be clamped; for them surfaceLock only governs visibility.
      const traj = bm.body.trajectory;
      if (!(traj instanceof WaypointTrajectory)) continue;
      if (traj.useAbsoluteAlt) continue;
      const lockSpec = bm.body.geometryData.surfaceLock;
      // "aboveTerrain" mode: trajectory altitude is height above local terrain.
      // Renderer samples terrain at the body's lat/lon and offsets the body
      // (or its parent, if the body is the origin) so the body sits exactly
      // `trajectory_alt` above the live terrain — works across varying terrain.
      const aboveTerrain = lockSpec === 'aboveTerrain'
        || (typeof lockSpec === 'object' && lockSpec !== null && (lockSpec as { mode?: string }).mode === 'aboveTerrain');
      const isOrigin = bm.body.name === this.cameraController.originBody?.body.name;
      // Snap mode on the origin body would move it off (0,0,0) and break CRR.
      // aboveTerrain on the origin body is handled below by shifting the parent
      // body instead, keeping the origin body at (0,0,0).
      if (isOrigin && !aboveTerrain) continue;
      const parentName = bm.body.parentName;
      if (!parentName) continue;
      const parentBm = this.bodyMeshes.get(parentName);
      if (!parentBm || !parentBm.hasTerrain) continue;

      // Get body direction from parent center
      const toBody = _clampTmpVec.copy(bm.position).sub(parentBm.position);
      const dist = toBody.length();
      if (dist < 1e-20) continue;

      // Convert to body-fixed lat/lon for terrain sampling
      const sf = this.scaleFactor;
      const invQ = _clampTmpQuat.copy(parentBm.mesh.quaternion).invert();
      const kmVec = _clampTmpVec2.copy(toBody).divideScalar(sf).applyQuaternion(invQ);
      const ecefX = kmVec.x;
      const ecefY = -kmVec.z;
      const ecefZ = kmVec.y;
      const r = Math.sqrt(ecefX * ecefX + ecefY * ecefY + ecefZ * ecefZ);
      if (r < 1e-10) continue;

      const latDeg = Math.asin(Math.max(-1, Math.min(1, ecefZ / r))) * (180 / Math.PI);
      const lonDeg = Math.atan2(ecefY, ecefX) * (180 / Math.PI);

      // Sample terrain elevation at most every 10 frames — surface-locked bodies move slowly
      // and sampleElevationKm traverses all loaded tile vertices, so calling it every frame
      // is expensive at high tile counts. Use the cached elevation on intermediate frames.
      const bodyKey = bm.body.name;
      const frame = this._renderDebugFrame;
      const cached = this._surfaceLockElevCache.get(bodyKey);
      let sample: { elevationKm: number; angularDistDeg: number } | null = null;
      if (!cached || frame - cached.frame >= 10) {
        sample = parentBm.sampleTerrainElevation(latDeg, lonDeg);
        if (sample) this._surfaceLockElevCache.set(bodyKey, { ...sample, frame });
      } else {
        sample = cached;
      }

      // For WaypointTrajectory bodies in aboveTerrain mode, sample terrain at
      // each waypoint's lat/lon (whenever the tile arrives) and cache. Once we
      // have ≥1 sample, use the cached samples interpolated along time as the
      // ground reference instead of the body's CURRENT local terrain — keeps
      // the body at constant absolute altitude rather than bumping with every
      // hill it crosses.
      let waypointGroundKm: number | null = null;
      if (aboveTerrain && bm.body.trajectory instanceof WaypointTrajectory) {
        const wps = bm.body.trajectory.waypoints;
        let perBodyCache = this._waypointTerrainCache.get(bodyKey);
        if (!perBodyCache) {
          perBodyCache = new Map();
          this._waypointTerrainCache.set(bodyKey, perBodyCache);
        }
        if (perBodyCache.size < wps.length && frame % 10 === 0) {
          for (let wi = 0; wi < wps.length; wi++) {
            if (perBodyCache.has(wi)) continue;
            const w = wps[wi];
            const s = parentBm.sampleTerrainElevation(w.latDeg, w.lonDeg);
            if (s && s.angularDistDeg < 0.5) perBodyCache.set(wi, s.elevationKm);
          }
        }
        if (perBodyCache.size > 0) {
          // Build the (et, terrainElev) curve from whatever waypoints we've
          // sampled so far; linearly interpolate at the body's current time.
          const known: Array<{ et: number; elev: number }> = [];
          for (let wi = 0; wi < wps.length; wi++) {
            const elev = perBodyCache.get(wi);
            if (elev != null) known.push({ et: wps[wi].et, elev });
          }
          if (known.length > 0) {
            const et = this.universe.time;
            if (et <= known[0].et || known.length === 1) {
              waypointGroundKm = known[0].elev;
            } else if (et >= known[known.length - 1].et) {
              waypointGroundKm = known[known.length - 1].elev;
            } else {
              let i = 0;
              while (i < known.length - 1 && et > known[i + 1].et) i++;
              const a = known[i], b = known[i + 1];
              const u = (et - a.et) / (b.et - a.et);
              waypointGroundKm = a.elev + u * (b.elev - a.elev);
            }
          }
        }
      }

      const spiceElevKm = dist / sf - parentBm.displayRadius;
      if (sample && sample.angularDistDeg < 0.5) {
        let targetR: number | null = null;
        if (aboveTerrain) {
          // trajectory's "altitude" is height above terrain. Prefer the
          // pre-sampled waypoint reference (smooth) when available; fall back
          // to the body's current local terrain sample otherwise.
          const groundKm = waypointGroundKm ?? sample.elevationKm;
          targetR = (parentBm.displayRadius + groundKm + spiceElevKm + 0.00001) * sf;
        } else if (Math.abs(sample.elevationKm - spiceElevKm) < 1.0) {
          // snap mode: pin to terrain when trajectory and terrain agree within 1 km.
          targetR = (parentBm.displayRadius + sample.elevationKm + 0.00001) * sf;
        }
        if (targetR !== null && Math.abs(dist - targetR) > 1e-15) {
          if (isOrigin) {
            // Body is at (0,0,0) and we must keep it there for CRR. Instead,
            // scale the parent's position so that |body - parent| = targetR.
            // This shifts the parent (and visually, the planet's surface) so
            // the body still appears at the right altitude above terrain.
            const scale = targetR / dist;
            parentBm.position.multiplyScalar(scale);
          } else {
            toBody.normalize().multiplyScalar(targetR);
            bm.position.copy(parentBm.position).add(toBody);
          }
        }
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
    const MARGIN_KM = 0.002; // 2m above terrain surface (eye-height for ground-level viewing)

    // When the camera is tracking OR flying to a surface-locked body
    // (rover/lander), skip the clamp on its parent body. The clamp prevents
    // going through terrain, but inspecting a surface-locked body requires the
    // camera to share the body's altitude — at the rover's location, the
    // terrain IS the rover's altitude, so the clamp would push the camera away
    // at exactly the distance that's "max zoom in" to the rover. Using
    // focusBody (vs trackedBody) makes the skip engage during the flyTo
    // animation too, so the zoom doesn't visibly bounce off the clamp surface.
    const focus = this.cameraController.focusBody;
    const skipParentName = focus?.body.geometryData?.surfaceLock
      ? focus.body.parentName
      : null;

    // DEBUG: enable with window.__clampDebug = true
    if (typeof window !== 'undefined' && (window as any).__clampDebug) {
      console.log(`[clamp] focus=${focus?.body.name ?? 'null'} surfaceLock=${focus?.body.geometryData?.surfaceLock ?? false} skip=${skipParentName ?? 'none'}`);
    }

    for (const bm of this.bodyMeshes.values()) {
      if (bm.body.geometryType !== 'Globe' && bm.body.geometryType !== 'Ellipsoid') continue;
      if (skipParentName && bm.body.name === skipParentName) continue;

      const toBody = _clampTmpVec.copy(cam).sub(bm.position);
      const dist = toBody.length();
      if (dist < 1e-20) continue;

      // Base clamp: reference sphere
      let clampRadiusKm = bm.displayRadius;
      let hasTerrainSample = false;

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
          // Use terrain elevation for both positive (mountains) and negative (basins/craters)
          // elevations so the camera can descend into regions below the reference sphere
          // (e.g., Dingo Gap on Mars at ~-4.5 km below the reference sphere).
          const bodyName = bm.body.name;
          const cached = this._terrainClampCache.get(bodyName);
          const frame = this._renderDebugFrame;
          if (!cached || frame - cached.frame >= 5) {
            const sample = bm.sampleTerrainElevation(latDeg, lonDeg);
            if (sample && sample.angularDistDeg < 1.0) {
              const elev = sample.elevationKm;
              this._terrainClampCache.set(bodyName, { elevationKm: elev, frame });
              clampRadiusKm = bm.displayRadius + elev;
              hasTerrainSample = true;
            }
          } else {
            clampRadiusKm = bm.displayRadius + cached.elevationKm;
            hasTerrainSample = true;
          }
        }
      }

      const surfaceR = (clampRadiusKm + MARGIN_KM) * this.scaleFactor;
      // When no terrain data is available, only clamp if the camera is above (or at) the
      // reference sphere. If it's already below the sphere (as at Dingo Gap where terrain
      // is ~4.5 km below the Mars reference sphere), don't push it back up — the surface
      // explorer's altKm controls have already positioned it correctly.
      const sphereR = bm.displayRadius * this.scaleFactor;
      if (dist < surfaceR && (hasTerrainSample || dist >= sphereR)) {
        if (typeof window !== 'undefined' && (window as any).__clampDebug) {
          console.log(`[clamp] PUSH on ${bm.body.name}: dist=${dist.toExponential(3)} surfaceR=${surfaceR.toExponential(3)} hasTerrain=${hasTerrainSample}`);
        }
        // Push camera out to just above surface along the same direction
        toBody.normalize().multiplyScalar(surfaceR);
        cam.copy(bm.position).add(toBody);
      }
    }
  }

  /** Position attached visuals relative to their parent body each frame. */
  private updateAttachedVisuals(et: number): void {
    for (const av of this._attachedVisuals) {
      const body = this.universe.getBody(av.bodyName);
      if (!body) continue;
      const bm = this.bodyMeshes.get(av.bodyName);
      if (av.autoHide && bm) {
        av.object.visible = bm.visible;
      }
      if (!av.object.visible) continue;
      // Position at the body's scene-space location
      if (bm) {
        av.object.position.copy(bm.position);
      } else {
        const state = body.stateAt(et);
        av.object.position.set(
          state.position[0] * this.scaleFactor,
          state.position[1] * this.scaleFactor,
          state.position[2] * this.scaleFactor,
        );
      }
      if (av.followRotation && bm) {
        av.object.quaternion.copy(bm.quaternion);
      }
    }
  }

  /** Update custom body visuals from the BodyVisualizer registry. */
  private updateCustomVisuals(et: number): void {
    for (const [bodyName, obj] of this._customVisuals) {
      const body = this.universe.getBody(bodyName);
      if (!body) continue;
      const vis = this._visualizers.get(body.geometryType ?? '');
      if (!vis) continue;
      const bm = this.bodyMeshes.get(bodyName);
      const pos: [number, number, number] = bm
        ? [bm.position.x, bm.position.y, bm.position.z]
        : [
            body.stateAt(et).position[0] * this.scaleFactor,
            body.stateAt(et).position[1] * this.scaleFactor,
            body.stateAt(et).position[2] * this.scaleFactor,
          ];
      vis.updateVisual(obj, body, et, pos, this._ctx);
    }
  }

  dispose(): void {
    this.stop();
    this.renderer.domElement.removeEventListener('click', this._onClick);
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
    this._dprMediaQuery?.removeEventListener('change', this._onDprChange);
    this._dprMediaQuery = null;
    // Clean up custom visuals
    for (const [bodyName, obj] of this._customVisuals) {
      const body = this.universe.getBody(bodyName);
      const vis = body ? this._visualizers.get(body.geometryType ?? '') : undefined;
      vis?.dispose?.(obj);
    }
    this._customVisuals.clear();
    // Clean up attached visuals
    for (const av of this._attachedVisuals) {
      this.scene.remove(av.object);
    }
    this._attachedVisuals.length = 0;
    this.bloomEffect?.dispose();
    this.bloomEffect = null;
    this.renderer.dispose();
    this.events.dispose();
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
        // Match the inertial frame to the parent body's trajectory frame so sensor
        // orientation aligns with scene positions (J2000 for Cassini, ECLIPJ2000 for LRO, etc.)
        const parentBody = body.parentName ? this.universe.getBody(body.parentName) : undefined;
        if (parentBody?.trajectoryFrame === 'equatorial') {
          sf.spiceInertialFrame = 'J2000';
        }
        sf.layers.set(OVERLAY_LAYER);
        sf.traverse(c => c.layers.set(OVERLAY_LAYER));
        this.sensorFrustums.set(body.name, sf);
        this.scene.add(sf);
      }

      // Rings get an annulus mesh attached to the parent body
      if (body.geometryType === 'Rings' && body.geometryData && body.parentName) {
        const inner = body.geometryData.innerRadius as number;
        const outer = body.geometryData.outerRadius as number;
        const parentName = body.parentName;
        if (inner > 0 && outer > inner) {
          const ring = new RingMesh(inner, outer);
          ring.applyScale(this.scaleFactor);
          this.ringMeshes.set(body.name, { ring, parentName });
          this.scene.add(ring);

          // Load ring texture; once it lands, also wire ring-shadow-on-body
          // onto the parent so the rings cast a stripe across the planet.
          const texPath = body.geometryData.texture as string | undefined;
          if (texPath) {
            const resolver = this.options.textureResolver ?? this.options.modelResolver;
            const url = resolver?.(texPath);
            if (url) {
              ring.loadTexture(url).then(tex => {
                if (!tex) return;
                const parentBm = this.bodyMeshes.get(parentName);
                if (parentBm) {
                  parentBm.enableRingShadowReceiving(
                    tex,
                    inner * this.scaleFactor,
                    outer * this.scaleFactor,
                  );
                }
              });
            }
          }
        }
        continue;
      }

      // Check BodyVisualizer registry for custom geometry types
      const customVis = this._visualizers.get(body.geometryType ?? '');
      if (customVis) {
        const obj = customVis.createVisual(body, this._ctx);
        this._customVisuals.set(body.name, obj);
        this.scene.add(obj);
        // Still create a BodyMesh for picking/tracking but hide the sphere
      }

      // Create body mesh (needed for click/track even for sensor bodies)
      const bm = new BodyMesh(body);
      bm.mesh.scale.setScalar(this.scaleFactor);
      // Hide placeholder sphere for instrument-class sensors (e.g. ISS NAC on Cassini)
      // but keep it for spacecraft-class sensors (e.g. WeatherSat in sensor demo)
      if (body.geometryType === 'Sensor' && body.classification === 'instrument') bm.mesh.visible = false;
      // Hide placeholder sphere for bodies with a custom visualizer — the
      // visualizer fully owns the body's appearance, and the placeholder
      // would otherwise render alongside it (z-fighting / engulf-on-flyTo).
      if (customVis) bm.mesh.visible = false;
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
              bm.loadGlobeTextures(baseMapUrl, normalMapUrl, dispMapUrl, dispScale, dispBias, bumpMapUrl, bumpScaleVal, this.renderer);
            }
          } else if (geo.baseMap && typeof geo.baseMap === 'object') {
            // Tiled texture (NameTemplate or MultiWMS) — load level-0 tiles
            const tileUrls = this.resolveTileUrls(geo.baseMap as Record<string, unknown>, resolver);
            if (tileUrls) {
              bm.loadTiledBaseMap(tileUrls, this.renderer);
            }
            // Also load normalMap / displacementMap / bumpMap if present
            if (normalMapUrl || dispMapUrl || bumpMapUrl) {
              bm.loadGlobeTextures(undefined, normalMapUrl, dispMapUrl, dispScale, dispBias, bumpMapUrl, bumpScaleVal, this.renderer);
            }
          } else if (normalMapUrl || dispMapUrl || bumpMapUrl) {
            bm.loadGlobeTextures(undefined, normalMapUrl, dispMapUrl, dispScale, dispBias, bumpMapUrl, bumpScaleVal, this.renderer);
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
          console.log(`[Cosmolabe] Initialized terrain for ${body.name}: ${terrainCfg.type} ${terrainCfg.url ?? `ion:${terrainCfg.cesiumIonAssetId}`}`);
        }
      }

      // Initialize surface tile overlays for Globe bodies (e.g. Dingo Gap local-frame tiles).
      // Overlay groups are added to a separate tileScene for camera-relative rendering.
      if (body.geometryType === 'Globe' && body.geometryData?.surfaceTiles) {
        const tiles = body.geometryData.surfaceTiles as SurfaceTileConfig[];
        for (const tileCfg of tiles) {
          const overlay = bm.addSurfaceTiles(tileCfg, this.renderer);
          this.tileScene.add(overlay.group);

          console.log(`[Cosmolabe] Initialized surface tiles "${tileCfg.name}" on ${body.name}`);
        }
      }

      // Create atmosphere shell for Globe bodies with atmosphere data
      if (body.geometryType === 'Globe' && body.geometryData) {
        const atmValue = body.geometryData.atmosphere;
        const atmParams = resolveAtmosphereParams(atmValue, body.name);
        if (atmParams) {
          const radius = bm.displayRadius;
          // Pass renderer so AtmosphereMesh can build its multi-scattering LUT
          // (one-time render-to-texture; ~150 KB GPU memory per atmosphere).
          const atm = new AtmosphereMesh(radius, atmParams, this.renderer);
          this.atmosphereMeshes.set(body.name, { atm, parentName: body.name });
          this.scene.add(atm);
          // Aerial perspective: enable on the body sphere + any terrain so distant
          // terrain fades toward sky color. Static uniforms (coefficients, radii)
          // are set once here; camera/sun positions are refreshed per-frame.
          // Share the parent atmosphere's LUT so MS lookups stay consistent.
          const apu = makeAerialPerspectiveUniforms();
          apu.uAPMultiScatterLUT.value = atm.multiScatterLUT;
          this.aerialPerspectiveUniforms.set(body.name, apu);
          bm.enableAerialPerspective(apu);
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

          // Apply catalog color (accepts "#rrggbb", "rrggbb", or [r, g, b] floats 0-1)
          if (plotCfg?.color != null) {
            const c = plotCfg.color;
            if (typeof c === 'string') {
              const hex = c.startsWith('#') ? c.slice(1) : c;
              const n = parseInt(hex, 16);
              if (!Number.isNaN(n)) trajOpts.color = n;
            } else if (Array.isArray(c) && c.length >= 3) {
              const r = Math.round(Math.max(0, Math.min(1, c[0])) * 255);
              const g = Math.round(Math.max(0, Math.min(1, c[1])) * 255);
              const b = Math.round(Math.max(0, Math.min(1, c[2])) * 255);
              trajOpts.color = (r << 16) | (g << 8) | b;
            }
          }

          // Apply catalog opacity
          if (plotCfg?.opacity != null) trajOpts.opacity = plotCfg.opacity;

          // Apply catalog fade fraction
          if (plotCfg?.fade != null) trajOpts.fadeFraction = plotCfg.fade;

          // Clamp trail to trajectory time bounds (prevents extrapolation artifacts)
          if (body.trajectory.startTime != null && trajOpts.minTime == null) {
            trajOpts.minTime = body.trajectory.startTime;
          }
          if (body.trajectory.endTime != null && trajOpts.maxTime == null) {
            trajOpts.maxTime = body.trajectory.endTime;
          }

          // Periodic orbits whose trail covers roughly one period are spatially
          // static — sample once at scene load, never resample. Critical for the
          // 300-asteroid demo: without this, fast time playback would resample
          // 300 × 500 SPICE calls per frame.
          if (UniverseRenderer.STATIC_ORBIT_CLASSES.has(body.classification ?? '')) {
            trajOpts.staticOrbit = true;
          }

          const tl = new TrajectoryLine(body, trajOpts);
          tl.layers.set(OVERLAY_LAYER);
          tl.traverse(c => c.layers.set(OVERLAY_LAYER));
          this.trajectoryLines.set(body.name, tl);
          this.scene.add(tl);

          // Build trajectory cache for long-duration spacecraft trails.
          // Skip for natural bodies — their smooth orbits work fine with legacy sampling.
          if (this.shouldBuildCache(body, trajOpts)) {
            if (this.cacheWorker && body.trajectory instanceof SpiceTrajectory) {
              // Async: hide trail until cache is ready, build in worker
              tl.setUserVisible(false);
              this.dispatchAsyncCacheBuild(body, tl, trajOpts);
            } else {
              // Sync fallback: build on main thread (blocks but still works)
              this.buildCacheSync(body, tl, trajOpts);
            }
          }

          // Event markers (periapsis/apoapsis) disabled for now — revisit when
          // we have subsystem zoom and per-body marker configuration.
        }
      }

    }

    // Sun light. Directional rather than point because (a) the sun is far
    // enough at any reasonable focus body that parallel light is physically
    // correct, and (b) Three.js shadow maps need a DirectionalLight (or Spot)
    // with a manageable ortho/perspective frustum — used here for the
    // helicopter-style mesh-on-terrain shadows.
    const sun = this.bodyMeshes.get('Sun');
    if (sun) {
      const light = new THREE.DirectionalLight(0xffffff, 2);
      light.layers.enableAll();
      light.position.copy(sun.position);
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      // `bias` is in NDC depth over the shadow camera's near→far range. With
      // our shadow camera spanning ~200 m of depth (1e-7 scene units), a bias
      // of 1e-4 NDC ≈ 2 cm of real-world depth offset — enough to suppress
      // self-shadow acne without obvious peter-panning.
      light.shadow.bias = 1e-4;
      // `normalBias` is in WORLD (scene) units. 1m = 1e-9 scene units, so
      // 1e-9 nudges the shadow query 1 m along the surface normal.
      light.shadow.normalBias = 1e-9;
      this.sunLight = light;
      this.scene.add(light);
      this.scene.add(light.target);
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
        if (bm.body.labelVisible) this.labelManager.addLabel(bm);
      }
    }

    // Sensor visibility (apply after frustums are built)
    if (this.options.showSensorLabels === false) this.setSensorLabelsVisible(false);
    if (this.options.showSensors === false) this.setSensorsVisible(false);
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

      // Derive FOV angles from boundary vectors if not specified in catalog.
      // SPICE boundary vectors are NOT necessarily unit vectors — they're direction
      // vectors like (5e-6, -0.025, 1.0). We must normalize before computing angles.
      if (geo.horizontalFov == null || geo.verticalFov == null) {
        const bs = fov.boresight;
        const bsLen = Math.sqrt(bs[0] ** 2 + bs[1] ** 2 + bs[2] ** 2);
        const bsN = [bs[0] / bsLen, bs[1] / bsLen, bs[2] / bsLen];

        if (fov.shape === 'CIRCLE' && fov.bounds.length >= 1) {
          // Single half-angle from boresight to (normalized) boundary vector
          const b = fov.bounds[0];
          const bLen = Math.sqrt(b[0] ** 2 + b[1] ** 2 + b[2] ** 2);
          const dot = (bsN[0] * b[0] + bsN[1] * b[1] + bsN[2] * b[2]) / bLen;
          const fovDeg = Math.acos(Math.min(1, Math.abs(dot))) * 2 * 180 / Math.PI;
          if (geo.horizontalFov == null) geo.horizontalFov = fovDeg;
          if (geo.verticalFov == null) geo.verticalFov = fovDeg;
        } else if (fov.shape === 'ELLIPSE' && fov.bounds.length >= 2) {
          for (let bi = 0; bi < 2; bi++) {
            const b = fov.bounds[bi];
            const bLen = Math.sqrt(b[0] ** 2 + b[1] ** 2 + b[2] ** 2);
            const dot = (bsN[0] * b[0] + bsN[1] * b[1] + bsN[2] * b[2]) / bLen;
            const fovDeg = Math.acos(Math.min(1, Math.abs(dot))) * 2 * 180 / Math.PI;
            if (bi === 0 && geo.horizontalFov == null) geo.horizontalFov = fovDeg;
            if (bi === 1 && geo.verticalFov == null) geo.verticalFov = fovDeg;
          }
        } else if (fov.bounds.length >= 1) {
          // RECTANGLE or POLYGON: build orthonormal frame around boresight,
          // project all boundary corners to find max H and V half-angles.
          const refUp = Math.abs(bsN[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
          const right = [
            bsN[1] * refUp[2] - bsN[2] * refUp[1],
            bsN[2] * refUp[0] - bsN[0] * refUp[2],
            bsN[0] * refUp[1] - bsN[1] * refUp[0],
          ];
          const rLen = Math.sqrt(right[0] ** 2 + right[1] ** 2 + right[2] ** 2);
          right[0] /= rLen; right[1] /= rLen; right[2] /= rLen;
          const up = [
            bsN[1] * right[2] - bsN[2] * right[1],
            bsN[2] * right[0] - bsN[0] * right[2],
            bsN[0] * right[1] - bsN[1] * right[0],
          ];
          let maxH = 0, maxV = 0;
          for (const b of fov.bounds) {
            const along = b[0] * bsN[0] + b[1] * bsN[1] + b[2] * bsN[2];
            const hComp = Math.abs(b[0] * right[0] + b[1] * right[1] + b[2] * right[2]);
            const vComp = Math.abs(b[0] * up[0] + b[1] * up[1] + b[2] * up[2]);
            maxH = Math.max(maxH, Math.atan2(hComp, along));
            maxV = Math.max(maxV, Math.atan2(vComp, along));
          }
          if (geo.horizontalFov == null) geo.horizontalFov = maxH * 2 * 180 / Math.PI;
          if (geo.verticalFov == null) geo.verticalFov = maxV * 2 * 180 / Math.PI;
          // Use rectangular shape for FOVs with distinct H/V extents
          if (!geo.shape && maxH > 0 && maxV > 0 && Math.abs(maxH - maxV) / Math.max(maxH, maxV) > 0.1) {
            geo.shape = 'rectangular';
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

      // Per-arc opt-out (e.g., a landed/surface arc where the inertial-frame
      // samples trace a body-rotation circle that visually contradicts the
      // "spacecraft is parked" story). Body positioning still uses the arc's
      // samples — only the trajectory line is suppressed.
      if (arc.showLine === false) continue;

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
        // Per-arc sample-count override lets long cruise arcs request a
        // higher vertex budget than the default cap (~500) so the orbit
        // line doesn't appear as a faceted polygon at high eccentricity.
        numKeySamples: arc.numKeySamples,
      });
      // Tag with arc center name so the update loop can position it correctly
      (tl as any)._arcCenterName = arcCenterName;
      tl.layers.set(OVERLAY_LAYER);
      tl.traverse(c => c.layers.set(OVERLAY_LAYER));
      this.trajectoryLines.set(`${body.name}__arc${i}`, tl);
      this.scene.add(tl);

      // Build a per-arc TrajectoryCache. The single-trajectory path runs
      // `buildCacheSync` for long-duration spacecraft trails (above) —
      // composite-arc trails benefit equally, and skipping the cache
      // forces the live-sampling path to spread a fixed budget uniformly
      // in time. Uniform time = sparse vertex density at high-curvature
      // regions (e.g. tight lunar-orbit phases at the end of a cruise),
      // where Visvalingam-Whyatt's curvature-aware concentration is
      // exactly what we want. `TrajectoryCache.build` uses the arc's
      // own bounds (not the routing-extended endTime) so we don't waste
      // vertices on a clamped-to-last-sample post-arc gap.
      try {
        const trajStart = arc.trajectory.startTime;
        const trajEnd = arc.trajectory.endTime;
        if (trajStart != null && trajEnd != null && trajEnd > trajStart) {
          const cacheResolver = (t: number): [number, number, number] => {
            try {
              const s = arc.trajectory.stateAt(t);
              return [s.position[0], s.position[1], s.position[2]];
            } catch {
              return [NaN, NaN, NaN];
            }
          };
          const t0 = performance.now();
          const cache = TrajectoryCache.build(cacheResolver, trajStart, trajEnd, {
            maxPoints: 100_000,
            coverageWindows: [{ start: trajStart, end: trajEnd }],
          });
          if (cache.count > 0) {
            tl.setCache(cache);
            console.log(
              `[Cosmolabe] Arc cache built for ${body.name} arc${i}: ` +
                `${cache.count} pts in ${(performance.now() - t0).toFixed(0)}ms`,
            );
          }
        }
      } catch (err) {
        // Fall back to live sampling — the line works either way, just
        // with the lower coarse cap.
        console.warn(
          `[Cosmolabe] Arc cache failed for ${body.name} arc${i}, ` +
            `using live sampling:`,
          err,
        );
      }
    }
  }

  /** Bodies whose probe-state threw inside shouldShowTrajectory — one warn per body. */
  private readonly _trajectoryProbeWarned = new Set<string>();

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
    } catch (err) {
      // Most common cause: stateAt() called outside the trajectory's valid range
      // (e.g., TLE epoch 2026 but ET still at J2000=0 because Universe.setTime()
      // wasn't called before UniverseRenderer was constructed). Without this warn
      // the trajectory just silently never appears, which is brutal to debug.
      // One warn per body so the console stays readable.
      if (!this._trajectoryProbeWarned.has(body.name)) {
        this._trajectoryProbeWarned.add(body.name);
        console.warn(
          `[UniverseRenderer] Trajectory probe threw for body "${body.name}" at et=${this.timeController.et}; ` +
          `hiding trajectory. Check that Universe.setTime() was called before renderer construction ` +
          `(or that the body's trajectory covers the current ET).`,
          err,
        );
      }
      return false;
    }

    if (this.options.trajectoryFilter) return this.options.trajectoryFilter(body);
    // Default: show trajectories for all bodies except stars and barycenters
    return !EXCLUDED_TRAJECTORY_CLASSES.has(body.classification ?? '');
  }

  // ─── Trajectory cache helpers ────────────────────────────────────────

  private static readonly CACHE_EXCLUDED = new Set(['planet', 'moon', 'star', 'barycenter', 'asteroid', 'dwarfPlanet', 'comet']);
  /** Classifications whose orbit ellipse is fixed in space — sample once, skip resamples.
   * Scoped to asteroids because the swarm-of-300 demo would otherwise issue
   * 300 × 500 live SPICE calls per frame at fast playback. Planets/moons use
   * cheap analytical evaluators (Keplerian, MarsSat, L1, TASS17, Gust86) so
   * per-frame resampling is fine, and they need a real fading trail rather
   * than a static full-orbit ring. */
  private static readonly STATIC_ORBIT_CLASSES = new Set(['asteroid']);

  private shouldBuildCache(body: Body, trajOpts: TrajectoryLineOptions): boolean {
    const trailDur = trajOpts.trailDuration ?? 86400;
    if (trailDur <= 86400 * 7) return false;
    if (UniverseRenderer.CACHE_EXCLUDED.has(body.classification ?? '')) return false;
    // Skip cache for periodic orbits. The trail covers ~one period (capped at 10y),
    // and at typical scales that's many orbital cycles' worth of cache range
    // (search ±4× trail). Visvalingam simplification on a multi-cycle closed loop
    // distributes points unevenly — windows can land in low-density regions and
    // render nearly empty trails. Live sampling stays uniform and Keplerian /
    // analytical eval is cheap, so the cache buys nothing here.
    if (body.trajectory.period && body.trajectory.period > 0) return false;
    return true;
  }

  /** Dispatch an async cache build to the Web Worker. Trail stays hidden until ready. */
  private dispatchAsyncCacheBuild(body: Body, tl: TrajectoryLine, trajOpts: TrajectoryLineOptions): void {
    const spiceTraj = body.trajectory as SpiceTrajectory;
    const trailDur = trajOpts.trailDuration ?? 86400;
    const currentEt = this.timeController.et;

    const request: CacheBuildRequest = {
      bodyName: body.name,
      target: spiceTraj.spiceTarget,
      center: spiceTraj.spiceCenter,
      frame: spiceTraj.spiceFrame,
      naifId: body.naifId,
      searchStart: currentEt - trailDur * 4,
      searchEnd: currentEt + trailDur * 4,
      config: { maxPoints: 100_000 },
    };

    const t0 = performance.now();
    this.cacheWorker!.buildCache(request).then((cache) => {
      // Guard: scene may have been disposed while we waited
      if (!this.trajectoryLines.has(body.name)) return;
      if (cache.count > 0) {
        tl.setCache(cache);
        tl.setUserVisible(true);
        console.log(`[Cosmolabe] Async cache ready for ${body.name}: ${cache.count} points in ${(performance.now() - t0).toFixed(0)}ms`);
        this.events.emit('trajectory:cacheReady' as any, { bodyName: body.name });
      } else {
        // Empty cache — worker's SPICE may lack kernels. Fall back to sync.
        console.warn(`[Cosmolabe] Worker returned empty cache for ${body.name}, falling back to sync`);
        this.buildCacheSync(body, tl, trajOpts);
        tl.setUserVisible(true);
      }
    }).catch((err) => {
      console.warn(`[Cosmolabe] Worker cache failed for ${body.name}, falling back to sync:`, err);
      this.buildCacheSync(body, tl, trajOpts);
      tl.setUserVisible(true);
    });
  }

  /** Synchronous cache build on the main thread (fallback when no worker). */
  private buildCacheSync(body: Body, tl: TrajectoryLine, trajOpts: TrajectoryLineOptions): void {
    const trailDur = trajOpts.trailDuration ?? 86400;
    const currentEt = this.timeController.et;
    let searchStart = currentEt - trailDur * 4;
    let searchEnd = currentEt + trailDur * 4;

    const resolver = (t: number): [number, number, number] => {
      try {
        const state = body.trajectory.stateAt(t);
        return [state.position[0], state.position[1], state.position[2]];
      } catch {
        return [NaN, NaN, NaN];
      }
    };

    const spice = this.universe.spiceInstance;
    let coverageWindows: Array<{ start: number; end: number }> | undefined;
    if (spice && body.naifId != null) {
      try {
        coverageWindows = spice.spkcov(body.naifId);
        if (coverageWindows && coverageWindows.length > 0) {
          const MAX_CACHE_RANGE = 86400 * 365.25 * 30;
          const covStart = coverageWindows[0].start;
          const covEnd = coverageWindows[coverageWindows.length - 1].end;
          if (covEnd - covStart <= MAX_CACHE_RANGE) {
            searchStart = covStart;
            searchEnd = covEnd;
          }
        }
      } catch { /* spkcov not available */ }
    }

    // For non-SPICE trajectories that expose their own time bounds (e.g.
    // `InterpolatedStates`, `Waypoints`), use those as authoritative coverage
    // instead of letting the cache builder probe at 1-day intervals. The
    // probe path assumes out-of-range returns NaN; trajectories that *clamp*
    // to their first/last sample (the natural choice for state-vector
    // ephemerides — there's no "no data" failure mode) fool the probe into
    // reporting wildly over-broad coverage, which spreads simplification
    // points across irrelevant time and produces sparse cache windows.
    if (!coverageWindows
        && body.trajectory.startTime != null
        && body.trajectory.endTime != null) {
      coverageWindows = [{
        start: body.trajectory.startTime,
        end: body.trajectory.endTime,
      }];
      searchStart = body.trajectory.startTime;
      searchEnd = body.trajectory.endTime;
    }

    // Cap the cache range to ±1 period for periodic trajectories. Without this,
    // Visvalingam-Whyatt simplification of a multi-cycle closed loop distributes
    // points unevenly across cycles — some windows land in low-density regions
    // and render nearly-empty trails. One period of data is plenty: trail length
    // is at most ~1 period anyway. shouldBuildCache already skips most of these
    // up front; this is a safety net for any periodic trajectory that slips past
    // (e.g. a SPICE-backed body without a planet/moon classification).
    const periodSec = body.trajectory.period;
    if (periodSec && periodSec > 0) {
      searchStart = Math.max(searchStart, currentEt - periodSec);
      searchEnd = Math.min(searchEnd, currentEt + periodSec);
    }

    const t0 = performance.now();
    const cache = TrajectoryCache.build(resolver, searchStart, searchEnd, {
      maxPoints: 100_000,
      coverageWindows,
    });
    if (cache.count > 0) {
      tl.setCache(cache);
      const method = coverageWindows ? 'spkcov' : 'probe';
      console.log(`[Cosmolabe] Built sync cache for ${body.name} (${method}): ${cache.count} points in ${(performance.now() - t0).toFixed(0)}ms`);
    }
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

  /**
   * Pick the nearest body at a screen position — checks labels first (screen-space),
   * then raycasts against body meshes. Returns the body name or null.
   */
  pickBody(screenX: number, screenY: number): string | null {
    if (!this._dblClickRaycaster) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    let bodyName: string | undefined;

    // 1. Screen-space label picking (priority — labels are always in front)
    if (this.labelManager) {
      bodyName = this.labelManager.pickNearest(
        screenX, screenY, this.camera, rect.width, rect.height,
      );
    }

    // 2. Raycast against body meshes (placeholder sphere) AND terrain meshes.
    // When the camera is near a planet's surface the placeholder sphere is hidden
    // (see BodyMesh frame logic) and only the terrain mesh is visible — so we
    // must raycast the terrain group too, otherwise the planet becomes unpickable.
    if (!bodyName) {
      const mouse = new THREE.Vector2(
        (screenX / rect.width) * 2 - 1,
        -(screenY / rect.height) * 2 + 1,
      );
      this._dblClickRaycaster!.setFromCamera(mouse, this.camera);
      const meshTargets: THREE.Object3D[] = [];
      const terrainOwner = new Map<THREE.Object3D, BodyMesh>();
      for (const bm of this.bodyMeshes.values()) {
        if (bm.mesh.visible) {
          meshTargets.push(bm.mesh);
        } else {
          // Sphere hidden (camera near surface) — fall back to terrain mesh so the
          // body remains pickable. Skipped when sphere is visible to avoid
          // raycasting hundreds of tile meshes the sphere already covers.
          const terrain = bm.terrainTileGroup;
          if (terrain && terrain.visible) {
            meshTargets.push(terrain);
            terrainOwner.set(terrain, bm);
          }
        }
      }
      const hits = this._dblClickRaycaster!.intersectObjects(meshTargets, true);
      if (hits.length > 0) {
        // Walk up from hit to find owning BodyMesh: either via terrainOwner map
        // (terrain hits) or via the placeholder sphere ancestry chain.
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj) {
          if (this.bodyMeshes.has(obj.name)) { bodyName = obj.name; break; }
          const owner = terrainOwner.get(obj);
          if (owner) { bodyName = owner.body.name; break; }
          obj = obj.parent;
        }
      }
    }

    return bodyName ?? null;
  }

  /**
   * Single-click handler: picks the body and emits 'body:click' synchronously
   * so selection feels instant. A subsequent native dblclick will still
   * trigger `_onDblClick`, so consumers should design selection handlers to be
   * idempotent (re-selecting the same body should be a no-op).
   */
  private _onClick = (event: MouseEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const bodyName = this.pickBody(screenX, screenY);
    if (!bodyName) return;

    const et = this.universe.time;
    this.events.emit('body:click', { bodyName, et, screenX, screenY });
  };

  /**
   * Double-click handler: picks the body and emits 'body:dblclick'.
   * The consumer (viewer app) decides what to do — flyTo, show info, etc.
   */
  private _onDblClick = (event: MouseEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const bodyName = this.pickBody(screenX, screenY);
    if (!bodyName) return;

    const bm = this.bodyMeshes.get(bodyName);
    if (!bm) return;

    const et = this.universe.time;
    this.universe.state.set('selectedBody', bodyName);

    // Emit the new event — consumer handles flyTo, info panels, etc.
    this.events.emit('body:dblclick', { bodyName, et, screenX, screenY });

    // Backward compat: still emit body:picked and call plugin onPick hooks
    this.events.emit('body:picked', { bodyName, et });
    for (const plugin of this.plugins) {
      plugin.onPick?.(bm.body, et, this._ctx);
    }
  };

  private renderLoop = (): void => {
    this.animFrameId = requestAnimationFrame(this.renderLoop);
    this.renderFrame();
  };
}
