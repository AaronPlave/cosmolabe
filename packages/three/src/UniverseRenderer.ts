import * as THREE from 'three';
import { CompositeTrajectory, SpiceTrajectory, type Universe, type Body } from '@spicecraft/core';
import { BodyMesh } from './BodyMesh.js';
import { TrajectoryLine, type TrajectoryLineOptions } from './TrajectoryLine.js';
import { SensorFrustum } from './SensorFrustum.js';
import { EventMarkers } from './EventMarkers.js';
import { GeometryReadout } from './GeometryReadout.js';
import { StarField, type StarFieldOptions } from './StarField.js';
import { LabelManager, type LabelManagerOptions } from './LabelManager.js';
import { CameraController } from './controls/CameraController.js';
import { TimeController } from './controls/TimeController.js';
import type { RendererPlugin } from './plugins/RendererPlugin.js';

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
}

// Classes that should NOT show trajectories by default
const EXCLUDED_TRAJECTORY_CLASSES = new Set(['star', 'barycenter']);

export class UniverseRenderer {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly cameraController: CameraController;
  readonly timeController: TimeController;

  private readonly universe: Universe;
  private readonly scaleFactor: number;
  private readonly minBodyPixels: number;
  private readonly bodyMeshes = new Map<string, BodyMesh>();
  private readonly trajectoryLines = new Map<string, TrajectoryLine>();
  private readonly sensorFrustums = new Map<string, SensorFrustum>();
  private readonly eventMarkerGroups = new Map<string, EventMarkers>();
  private readonly plugins: RendererPlugin[] = [];
  private readonly options: UniverseRendererOptions;

  private labelManager: LabelManager | null = null;
  private geometryReadout: GeometryReadout | null = null;
  private starField: StarField | null = null;
  private sunLight: THREE.PointLight | null = null;
  private animFrameId = 0;
  private readonly labelContainer: HTMLDivElement;

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
    const ambient = new THREE.AmbientLight(0x333333);
    ambient.layers.enableAll();
    this.scene.add(ambient);

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
   * Trajectories give positions relative to their center body, so Moon's position
   * is relative to Earth, Earth's is relative to Sun, etc.
   */
  absolutePositionOf = (bodyName: string, et: number): [number, number, number] => {
    try {
      const body = this.universe.getBody(bodyName);
      if (!body) return [0, 0, 0];

      const state = body.stateAt(et);
      let x = state.position[0];
      let y = state.position[1];
      let z = state.position[2];

      // Walk up the parent chain, resolving composite trajectory centers at each step
      let currentParent = body.parentName;
      if (!currentParent && body.trajectory instanceof CompositeTrajectory) {
        currentParent = body.trajectory.arcAt(et).centerName;
      }

      while (currentParent) {
        const parent = this.universe.getBody(currentParent);
        if (!parent) break;
        const ps = parent.stateAt(et);
        x += ps.position[0];
        y += ps.position[1];
        z += ps.position[2];
        // Next parent: check for composite trajectory center if no static parentName
        currentParent = parent.parentName;
        if (!currentParent && parent.trajectory instanceof CompositeTrajectory) {
          currentParent = parent.trajectory.arcAt(et).centerName;
        }
      }

      return [x, y, z];
    } catch {
      return [0, 0, 0];
    }
  };

  /** Render a single frame at current time */
  renderFrame(): void {
    const et = this.timeController.et;
    const canvasHeight = this.renderer.domElement.clientHeight;
    const halfFovTan = Math.tan((this.camera.fov * Math.PI / 180) / 2);

    // Origin body: the tracked body's absolute position becomes scene origin (0,0,0).
    // This keeps the camera near the origin, avoiding Float32 precision loss in the GPU.
    const originBody = this.cameraController.trackedBody?.body.name;
    const originAbsPos: [number, number, number] = originBody
      ? this.absolutePositionOf(originBody, et)
      : [0, 0, 0];

    // Update body positions relative to origin body
    for (const bm of this.bodyMeshes.values()) {
      const absPos = this.absolutePositionOf(bm.body.name, et);
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
        } else {
          // Too small: hide model, show placeholder marker
          bm.setModelVisible(false);
          bm.mesh.visible = true;
        }
      }

      // Placeholder sphere: clamp to minBodyPixels so it's always a visible dot
      if (bm.mesh.visible && this.minBodyPixels > 0 && screenPixels < this.minBodyPixels) {
        const minSceneRadius = this.minBodyPixels * dist * 2 * halfFovTan / canvasHeight;
        bm.mesh.scale.setScalar(minSceneRadius / realSceneRadius);
      } else if (bm.mesh.visible) {
        bm.mesh.scale.setScalar(this.scaleFactor);
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

    // Update sensor frustums
    for (const sf of this.sensorFrustums.values()) {
      const targetBody = sf.targetName ? this.universe.getBody(sf.targetName) : undefined;
      sf.update(et, this.scaleFactor, targetBody, this.absolutePositionOf);
    }

    // Update event markers
    const trailDuration = this.options.trajectoryOptions?.trailDuration ?? 86400;
    for (const em of this.eventMarkerGroups.values()) {
      em.update(et, this.scaleFactor, { start: et - trailDuration, end: et + (this.options.trajectoryOptions?.leadDuration ?? 0) }, this.absolutePositionOf);
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

    // Camera
    this.cameraController.update();

    // Plugins
    for (const plugin of this.plugins) {
      plugin.onRender?.(et, this.scene, this.camera, this.universe);
    }

    // Dynamic near/far: adjust based on distance to orbit target
    const camDist = this.camera.position.distanceTo(this.cameraController.controls.target);
    this.camera.near = Math.max(1e-12, camDist * 1e-5);
    this.camera.far = Math.max(1e6, camDist * 1e6);
    this.camera.updateProjectionMatrix();

    // --- Multi-pass rendering ---
    this.renderer.autoClear = false;

    // Pass 1: Scene without models (layer 0) — log depth for cosmic scale
    this.camera.layers.set(0);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);

    // Pass 2: Models only (layer 1) — standard depth with tight near/far
    // Models strip the logdepthbuf shader chunks so hardware depth interpolation
    // handles intra-model face sorting with full float32 precision.
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
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    for (const plugin of this.plugins) {
      plugin.onResize?.(width, height);
    }
  }

  getBodyMesh(name: string): BodyMesh | undefined {
    return this.bodyMeshes.get(name);
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

    // Event markers
    const em = this.eventMarkerGroups.get(name);
    if (em) em.visible = visible;

    // Label
    this.labelManager?.setLabelVisible(name, visible);
  }

  dispose(): void {
    this.stop();
    this.timeController.dispose();
    this.cameraController.dispose();
    for (const bm of this.bodyMeshes.values()) bm.dispose();
    for (const tl of this.trajectoryLines.values()) tl.dispose();
    for (const sf of this.sensorFrustums.values()) sf.dispose();
    for (const em of this.eventMarkerGroups.values()) em.dispose();
    this.starField?.dispose();
    this.labelManager?.dispose();
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
      // Create body mesh
      const bm = new BodyMesh(body);
      bm.mesh.scale.setScalar(this.scaleFactor);
      this.bodyMeshes.set(body.name, bm);
      this.scene.add(bm);

      // Load 3D model if geometry type is Mesh
      if (body.geometryType === 'Mesh' && body.geometryData?.source) {
        const source = body.geometryData.source as string;
        const resolver = this.options.modelResolver;
        const url = resolver?.(source);
        if (url) {
          bm.loadModel(url, this.scaleFactor, source, resolver);
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
          this.trajectoryLines.set(body.name, tl);
          this.scene.add(tl);

          // Auto-detect periapsis/apoapsis markers for bodies with trajectories
          if (body.parentName) {
            const parentBody = this.universe.getBody(body.parentName);
            if (parentBody) {
              const em = new EventMarkers(body, parentBody);
              const trailDuration = this.options.trajectoryOptions?.trailDuration ?? 86400;
              em.detectExtrema(this.timeController.et - trailDuration, this.timeController.et + trailDuration);
              this.eventMarkerGroups.set(body.name, em);
              this.scene.add(em);
            }
          }
        }
      }

      // Create sensor frustum for Sensor geometry type
      if (body.geometryType === 'Sensor') {
        const sf = new SensorFrustum(body);
        this.sensorFrustums.set(body.name, sf);
        this.scene.add(sf);
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

      const tl = new TrajectoryLine(body, {
        trailDuration: trailDur,
        leadDuration: 0,
        orbitPeriod: arcPeriod,
        orbitOpacity: 0.25,
        minTime: arc.startTime,
        maxTime: arc.endTime,
        fixedResolver: arcResolver,
        fadeFraction: plotCfg?.fade ?? 1.0,
      });
      // Tag with arc center name so the update loop can position it correctly
      (tl as any)._arcCenterName = arcCenterName;
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

  private renderLoop = (): void => {
    this.animFrameId = requestAnimationFrame(this.renderLoop);
    this.renderFrame();
  };
}
