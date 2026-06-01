import type { SpiceInstance } from '@cosmolabe/spice';
import { Body } from './Body.js';
import { CatalogLoader } from './catalog/CatalogLoader.js';
import type { CatalogJson, CatalogLoaderOptions, ViewpointDefinition, TrajectoryFactory, RotationFactory } from './catalog/CatalogLoader.js';
import type { CosmolabePlugin } from './plugins/Plugin.js';
import { CompositeTrajectory } from './trajectories/CompositeTrajectory.js';
import { alignPositionToFrame, bodyTrajectoryFrameName, rotateVecByQuat } from './kinematics.js';
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

  constructor(spice?: SpiceInstance, options?: UniverseOptions) {
    this.spice = spice;
    this.resolveFile = options?.resolveFile;
    this.resolveFileBinary = options?.resolveFileBinary;
    this.trajectoryFactories = options?.trajectoryFactories;
    this.rotationFactories = options?.rotationFactories;
    this.state = new StateStore<UniverseState>({ ...DEFAULT_UNIVERSE_STATE });
  }

  loadCatalog(json: CatalogJson): void {
    const loaderOpts: CatalogLoaderOptions = {
      spice: this.spice,
      resolveFile: this.resolveFile,
      resolveFileBinary: this.resolveFileBinary,
      trajectoryFactories: this.trajectoryFactories,
      rotationFactories: this.rotationFactories,
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

  /**
   * Compute a body's absolute position in km by walking up the parent chain.
   * Trajectories give positions relative to their center body, so Moon's position
   * is relative to Earth, Earth's is relative to Sun, etc.
   */
  absolutePositionOf(bodyName: string, et: number): [number, number, number] {
    try {
      const body = this.getBody(bodyName);
      if (!body) return [NaN, NaN, NaN];

      const state = body.stateAt(et);
      let x = state.position[0];
      let y = state.position[1];
      let z = state.position[2];
      if (isNaN(x)) return [NaN, NaN, NaN];

      // Walk up the parent chain, resolving composite trajectory centers at
      // each step. For composite trajectories the ARC's centerName is the
      // authoritative parent for the body's current state — the arc's
      // positions are expressed relative to that body, regardless of any
      // static parentName on the body itself. This matches what
      // UniverseRenderer's trajectory-line code already does (arc center
      // first, parentName as fallback) — without this the line drew
      // correctly but the body marker was placed using the wrong parent
      // chain (e.g. a multi-phase mission that switches Earth → Moon for
      // a lunar segment would have its marker added to Earth's position
      // while the line correctly anchored to the Moon).
      let currentParent: string | undefined;
      if (body.trajectory instanceof CompositeTrajectory) {
        currentParent = body.trajectory.arcAt(et).centerName ?? body.parentName;
      } else {
        currentParent = body.parentName;
      }

      // Body-fixed trajectories (e.g. FixedSpherical for surface points) output
      // positions in the parent body's body-fixed frame. Rotate by the parent's
      // body-fixed → inertial transform before adding the parent's inertial
      // position, so the child rotates with the parent (e.g. ground stations on
      // Earth, volcanoes on Io).
      if (body.trajectoryFrame === 'body-fixed' && currentParent) {
        const parent = this.getBody(currentParent);
        const q = parent?.rotationAt(et);
        if (q) {
          // RotationModel.rotationAt returns inertial → body-fixed. Use the
          // conjugate [w, -x, -y, -z] to go body-fixed → inertial.
          const qw = q[0];
          const qx = -q[1];
          const qy = -q[2];
          const qz = -q[3];
          // Standard quaternion-vector rotation: v' = v + 2 q_xyz × (q_xyz × v + w v)
          const tx = 2 * (qy * z - qz * y);
          const ty = 2 * (qz * x - qx * z);
          const tz = 2 * (qx * y - qy * x);
          const rx = x + qw * tx + (qy * tz - qz * ty);
          const ry = y + qw * ty + (qz * tx - qx * tz);
          const rz = z + qw * tz + (qx * ty - qy * tx);
          x = rx; y = ry; z = rz;
        }
      }

      while (currentParent) {
        const parent = this.getBody(currentParent);
        if (!parent) break;
        const ps = parent.stateAt(et);
        if (isNaN(ps.position[0])) return [NaN, NaN, NaN];
        x += ps.position[0];
        y += ps.position[1];
        z += ps.position[2];
        currentParent = parent.parentName;
        if (!currentParent && parent.trajectory instanceof CompositeTrajectory) {
          currentParent = parent.trajectory.arcAt(et).centerName;
        }
      }

      return [x, y, z];
    } catch {
      // SPICE throws "insufficient ephemeris" when a body's position can't be
      // computed at this epoch. Return NaN so callers — body-mesh placement,
      // trajectory-line offsets, close-approach finders — can detect this and
      // skip rather than silently treating the body as if it were at the origin.
      return [NaN, NaN, NaN];
    }
  }

  /** Planetocentric sub-point — the lat/lon on the body's active parent
   *  (per `body.activeParentAt(et)`) directly below the body, plus altitude
   *  above the parent's equatorial radius. Returns null when the body has
   *  no parent, the parent has no rotation model, or out-of-coverage.
   *
   *  Frame composition: walks the parent rotation's `sourceFrame` and
   *  rotates `body.stateAt(et).position` into that frame if its own
   *  trajectory lives in a different one (EquatorJ2000 ↔ EclipticJ2000
   *  via the J2000 obliquity). Same machinery as `BodyMesh.updatePosition`,
   *  exposed so app-side body-fixed math doesn't have to re-derive. */
  subPointOf(
    bodyName: string,
    et: number,
  ): { lat: number; lon: number; altKm: number } | null {
    const body = this.bodies.get(bodyName);
    if (!body) return null;
    const parentName = body.activeParentAt(et);
    if (!parentName) return null;
    const parent = this.bodies.get(parentName);
    if (!parent || !parent.rotation) return null;
    let state;
    try {
      state = body.stateAt(et);
    } catch {
      return null;
    }
    if (!state) return null;
    const q = parent.rotationAt(et);
    if (!q) return null;
    const aligned = alignPositionToFrame(
      state.position,
      bodyTrajectoryFrameName(body),
      parent.rotation.sourceFrame,
    );
    const bf = rotateVecByQuat(aligned, q);
    const r = Math.sqrt(bf[0] * bf[0] + bf[1] * bf[1] + bf[2] * bf[2]);
    if (r <= 0) return null;
    const lat = (Math.asin(bf[2] / r) * 180) / Math.PI;
    const lon = (Math.atan2(bf[1], bf[0]) * 180) / Math.PI;
    const surfaceRadius = parent.radii
      ? Math.max(parent.radii[0], parent.radii[1])
      : 0;
    return { lat, lon, altKm: r - surfaceRadius };
  }

  /** Body-fixed (rotating-frame) velocity magnitude of a body relative to
   *  its active parent, via numerical d/dt of body-fixed position. Goes to
   *  ~0 for a landed spacecraft co-rotating with its parent; ~7.2 km/s
   *  for a typical LEO sat (ground-track speed).
   *
   *  Returns null on the same conditions as `subPointOf` (missing parent /
   *  parent rotation / out-of-coverage). `dt` defaults to 1 second — finer
   *  is noisier, coarser smears burns. */
  bodyFixedVelocityMagnitudeOf(
    bodyName: string,
    et: number,
    dt: number = 1,
  ): number | null {
    const body = this.bodies.get(bodyName);
    if (!body) return null;
    const parentName = body.activeParentAt(et);
    if (!parentName) return null;
    const parent = this.bodies.get(parentName);
    if (!parent || !parent.rotation) return null;
    const parentFrame = parent.rotation.sourceFrame;
    const scFrame = bodyTrajectoryFrameName(body);
    try {
      const sA = body.stateAt(et - dt);
      const sB = body.stateAt(et + dt);
      const qA = parent.rotationAt(et - dt);
      const qB = parent.rotationAt(et + dt);
      if (!sA || !sB || !qA || !qB) return null;
      const pA = alignPositionToFrame(sA.position, scFrame, parentFrame);
      const pB = alignPositionToFrame(sB.position, scFrame, parentFrame);
      const bfA = rotateVecByQuat(pA, qA);
      const bfB = rotateVecByQuat(pB, qB);
      const dvx = (bfB[0] - bfA[0]) / (2 * dt);
      const dvy = (bfB[1] - bfA[1]) / (2 * dt);
      const dvz = (bfB[2] - bfA[2]) / (2 * dt);
      return Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
    } catch {
      return null;
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
