import type { SpiceInstance } from './spice-injection.js';
import { Body } from './Body.js';
import { CatalogLoader } from './catalog/CatalogLoader.js';
import type { CatalogJson, CatalogLoaderOptions, ViewpointDefinition, TrajectoryFactory, RotationFactory } from './catalog/CatalogLoader.js';
import type { CosmolabePlugin } from './plugins/Plugin.js';
import { CompositeTrajectory } from './trajectories/CompositeTrajectory.js';
import type { Vec3 } from './kinematics.js';
import type { RotationModel } from './rotations/RotationModel.js';
import {
  BODY_FIXED,
  FrameRegistry,
  WORLD_FRAME,
  bodyFixedFrameName,
  normalizeFrameKey,
} from './frames/FrameRegistry.js';
import { EventBus } from './events/EventBus.js';
import type { UniverseEventMap } from './events/EventTypes.js';
import { StateStore } from './state/StateStore.js';
import type { UniverseState } from './state/StateTypes.js';
import { DEFAULT_UNIVERSE_STATE } from './state/StateTypes.js';

export interface UniverseOptions {
  /** Resolve trajectory data files (e.g. .xyzv). Return file text content or undefined. */
  resolveFile?: (source: string) => string | undefined;
  /** Resolve binary data files (e.g. .cheb). Return raw bytes or undefined. */
  resolveFileBinary?: (source: string) => ArrayBuffer | undefined;
  /** Custom trajectory factories keyed by type string. */
  trajectoryFactories?: Record<string, TrajectoryFactory>;
  /** Custom rotation factories keyed by type string. */
  rotationFactories?: Record<string, RotationFactory>;
}

export class Universe {
  private bodies = new Map<string, Body>();
  private _viewpoints: ViewpointDefinition[] = [];
  private _defaultViewpoint?: string;
  private currentEt = 0;
  private plugins: CosmolabePlugin[] = [];
  private readonly spice?: SpiceInstance;
  private readonly resolveFile?: (source: string) => string | undefined;
  private readonly resolveFileBinary?: (source: string) => ArrayBuffer | undefined;
  private readonly trajectoryFactories?: Record<string, TrajectoryFactory>;
  private readonly rotationFactories?: Record<string, RotationFactory>;

  readonly events = new EventBus<UniverseEventMap>();
  readonly state: StateStore<UniverseState>;
  /** Named frames and the rotations between them, wired to this universe's
   *  SPICE instance and to its bodies' rotation models (`IAU_<BODY>`).
   *  Register app-defined frames here. */
  readonly frames: FrameRegistry;
  /** Normalized body name → body, for `IAU_<BODY>` lookups; rebuilt lazily. */
  private frameKeyIndex?: Map<string, Body>;

  constructor(spice?: SpiceInstance, options?: UniverseOptions) {
    this.spice = spice;
    this.resolveFile = options?.resolveFile;
    this.resolveFileBinary = options?.resolveFileBinary;
    this.trajectoryFactories = options?.trajectoryFactories;
    this.rotationFactories = options?.rotationFactories;
    this.state = new StateStore<UniverseState>({ ...DEFAULT_UNIVERSE_STATE });
    this.frames = new FrameRegistry({
      spice,
      bodyRotation: (key) => this.bodyRotationByFrameKey(key),
    });
  }

  private bodyRotationByFrameKey(key: string): RotationModel | undefined {
    if (!this.frameKeyIndex) {
      this.frameKeyIndex = new Map();
      for (const b of this.bodies.values()) {
        const k = normalizeFrameKey(b.name);
        if (!this.frameKeyIndex.has(k)) this.frameKeyIndex.set(k, b);
      }
    }
    return this.frameKeyIndex.get(key)?.rotation;
  }

  loadCatalog(json: CatalogJson): void {
    const loaderOpts: CatalogLoaderOptions = {
      spice: this.spice,
      resolveFile: this.resolveFile,
      resolveFileBinary: this.resolveFileBinary,
      trajectoryFactories: this.trajectoryFactories,
      rotationFactories: this.rotationFactories,
      frames: this.frames,
    };
    const loader = new CatalogLoader(loaderOpts);
    const result = loader.load(json);

    for (const body of result.bodies) {
      // If a body with this name already exists (e.g. brought in by a `require`d
      // catalog and now being overridden), splice it out of its previous parent's
      // children before installing the replacement — otherwise the old reference
      // lingers and consumers see two bodies with the same name in the tree.
      const existing = this.bodies.get(body.name);
      if (existing && existing.parentName) {
        const oldParent = this.bodies.get(existing.parentName);
        if (oldParent) {
          const idx = oldParent.children.indexOf(existing);
          if (idx >= 0) oldParent.children.splice(idx, 1);
        }
      }

      this.bodies.set(body.name, body);
      this.wireBodyChangeCallback(body);
      if (body.parentName) {
        const parent = this.bodies.get(body.parentName);
        if (parent) parent.children.push(body);
      }
    }
    this.frameKeyIndex = undefined;

    for (const vp of result.viewpoints) {
      this._viewpoints.push(vp);
    }

    if (result.defaultViewpoint) {
      this._defaultViewpoint = result.defaultViewpoint;
    }

    this.events.emit('catalog:loaded', { name: json.name });

    for (const plugin of this.plugins) {
      plugin.onUniverseLoaded?.(this);
    }
  }

  addBody(body: Body): void {
    this.bodies.set(body.name, body);
    this.frameKeyIndex = undefined;
    this.wireBodyChangeCallback(body);
    if (body.parentName) {
      const parent = this.bodies.get(body.parentName);
      if (parent) parent.children.push(body);
    }
    this.events.emit('body:added', { body });
  }

  private wireBodyChangeCallback(body: Body): void {
    body.onChange = (b, field) => {
      if (field === 'trajectory') {
        this.events.emit('body:trajectoryChanged', { body: b });
      } else if (field === 'rotation') {
        this.events.emit('body:rotationChanged', { body: b });
      }
    };
  }

  removeBody(name: string): boolean {
    const body = this.bodies.get(name);
    if (!body) return false;
    this.bodies.delete(name);
    this.frameKeyIndex = undefined;
    this.events.emit('body:removed', { bodyName: name });
    return true;
  }

  getBody(name: string): Body | undefined {
    return this.bodies.get(name);
  }

  getAllBodies(): Body[] {
    return Array.from(this.bodies.values());
  }

  getRootBodies(): Body[] {
    return this.getAllBodies().filter(b => !b.parentName || !this.bodies.has(b.parentName));
  }

  get viewpoints(): readonly ViewpointDefinition[] { return this._viewpoints; }
  /** Name of the viewpoint to apply as the initial camera view (from catalog `defaultViewpoint`) */
  get defaultViewpoint(): string | undefined { return this._defaultViewpoint; }

  get time(): number { return this.currentEt; }
  get spiceInstance(): SpiceInstance | undefined { return this.spice; }

  setTime(et: number): void {
    this.currentEt = et;
    this.events.emit('time:change', { et });
    for (const plugin of this.plugins) {
      plugin.onTimeChange?.(et, this);
    }
  }

  use(plugin: CosmolabePlugin): void {
    this.plugins.push(plugin);
    if (this.bodies.size > 0) {
      plugin.onUniverseLoaded?.(this);
    }
  }

  /** Compute the time range covered by all loaded body trajectories.
   *  Returns [minEt, maxEt] or undefined if no bodies have finite time bounds.
   *  Prefers narrow mission-specific ranges over broad planetary ephemeris coverage. */
  getTimeRange(): [number, number] | undefined {
    // Collect per-body time spans
    const spans: [number, number][] = [];
    for (const body of this.bodies.values()) {
      const s = body.trajectory.startTime;
      const e = body.trajectory.endTime;
      if (s !== undefined && e !== undefined) {
        spans.push([s, e]);
      }
    }
    if (spans.length === 0) return undefined;

    // Separate narrow (mission-specific) from wide (planetary ephemeris) spans.
    // Planetary kernels like de440s.bsp cover centuries via spkcov; mission SPKs
    // and catalog-declared time bounds cover the actual window of interest.
    const WIDE_THRESHOLD = 100 * 365.25 * 86400; // 100 years in seconds
    const narrow = spans.filter(([s, e]) => (e - s) < WIDE_THRESHOLD);
    const active = narrow.length > 0 ? narrow : spans;

    let min = Infinity;
    let max = -Infinity;
    for (const [s, e] of active) {
      if (s < min) min = s;
      if (e > max) max = e;
    }
    return [min, max];
  }

  /** The frame a body's `stateAt(et)` position is in, resolved for `et`:
   *  `BODY_FIXED` becomes the active parent's `IAU_<PARENT>` frame. */
  frameOf(body: Body | string, et: number): string {
    const b = typeof body === 'string' ? this.getBody(body) : body;
    if (!b) return WORLD_FRAME;
    return this.resolveFrame(b.frameAt(et), b.activeParentAt(et));
  }

  /** Resolve a frame name relative to a center: `BODY_FIXED` means the
   *  center's body-fixed frame; every other name is returned canonicalized. */
  resolveFrame(frame: string, centerName: string | undefined): string {
    const canonical = this.frames.canonicalName(frame);
    if (canonical !== BODY_FIXED) return canonical;
    return centerName ? bodyFixedFrameName(centerName) : BODY_FIXED;
  }

  /** Re-express a center-relative position given in `frame` in the scene frame
   *  (ECLIPJ2000). This is the per-leg step of `absolutePositionOf` with the
   *  sum left out — what a trail sampler needs to draw a body's offset from
   *  its center in the same frame the marker is placed in. */
  toWorldFrame(position: Vec3, frame: string, centerName: string | undefined, et: number): Vec3 {
    return this.frames.transform(position, this.resolveFrame(frame, centerName), WORLD_FRAME, et);
  }

  /** A body's position relative to its active parent, in the scene frame. */
  relativePositionInWorld(bodyName: string, et: number): Vec3 {
    const body = this.getBody(bodyName);
    if (!body) return [NaN, NaN, NaN];
    const p = body.stateAt(et).position;
    return this.frames.transform([p[0], p[1], p[2]], this.frameOf(body, et), WORLD_FRAME, et);
  }

  /**
   * Compute a body's absolute position in km by walking up the parent chain.
   * Trajectories give positions relative to their center body, so Moon's position
   * is relative to Earth, Earth's is relative to Sun, etc. The result is in the
   * scene frame, ECLIPJ2000.
   *
   * Every leg is one frame-registry transform: the accumulated offset is
   * re-expressed from the child's frame into the parent's before the parent's
   * own offset is added. That covers the inertial cases (EME2000 ↔ ECLIPJ2000
   * obliquity, TEME precession-nutation, …) and the body-fixed one: a
   * `BODY_FIXED` child's frame resolves to its parent's `IAU_<PARENT>`, whose
   * rotation to ICRF comes from the parent's rotation model, so a ground
   * station turns with its planet with no special case.
   */
  absolutePositionOf(bodyName: string, et: number): [number, number, number] {
    try {
      const body = this.getBody(bodyName);
      if (!body) return [NaN, NaN, NaN];

      const state = body.stateAt(et);
      let pos: Vec3 = [state.position[0], state.position[1], state.position[2]];
      if (isNaN(pos[0])) return [NaN, NaN, NaN];

      // For composite trajectories the ARC's centerName is the authoritative
      // parent for the body's current state — the arc's positions are
      // expressed relative to that body, regardless of any static parentName.
      // This matches what UniverseRenderer's trajectory-line code does (arc
      // center first, parentName as fallback); without it a multi-phase
      // mission that switches Earth → Moon for a lunar segment would have its
      // marker added to Earth's position while the line anchored to the Moon.
      let currentParent = body.activeParentAt(et);
      let frame = this.resolveFrame(body.frameAt(et), currentParent);

      while (currentParent) {
        const parent = this.getBody(currentParent);
        if (!parent) break;
        const ps = parent.stateAt(et);
        if (isNaN(ps.position[0])) return [NaN, NaN, NaN];

        let nextParent = parent.parentName;
        if (!nextParent && parent.trajectory instanceof CompositeTrajectory) {
          nextParent = parent.trajectory.arcAt(et).centerName;
        }
        const parentFrame = this.resolveFrame(parent.frameAt(et), nextParent);

        pos = this.frames.transform(pos, frame, parentFrame, et);
        pos = [pos[0] + ps.position[0], pos[1] + ps.position[1], pos[2] + ps.position[2]];
        frame = parentFrame;
        currentParent = nextParent;
      }

      pos = this.frames.transform(pos, frame, WORLD_FRAME, et);
      return [pos[0], pos[1], pos[2]];
    } catch {
      // SPICE throws "insufficient ephemeris" when a body's position can't be
      // computed at this epoch. Return NaN so callers — body-mesh placement,
      // trajectory-line offsets, close-approach finders — can detect this and
      // skip rather than silently treating the body as if it were at the origin.
      return [NaN, NaN, NaN];
    }
  }

  dispose(): void {
    for (const plugin of this.plugins) {
      plugin.dispose?.();
    }
    this.plugins = [];
    this.bodies.clear();
    this._viewpoints = [];
    this._defaultViewpoint = undefined;
    this.events.dispose();
    this.state.dispose();
  }
}
