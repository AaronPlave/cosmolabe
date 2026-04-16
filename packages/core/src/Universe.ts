import type { SpiceInstance } from '@spicecraft/spice';
import { Body } from './Body.js';
import { CatalogLoader } from './catalog/CatalogLoader.js';
import type { CatalogJson, CatalogLoaderOptions, ViewpointDefinition, TrajectoryFactory, RotationFactory } from './catalog/CatalogLoader.js';
import type { SpiceCraftPlugin } from './plugins/Plugin.js';
import { CompositeTrajectory } from './trajectories/CompositeTrajectory.js';
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
  private currentEt = 0;
  private plugins: SpiceCraftPlugin[] = [];
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
      this.bodies.set(body.name, body);
      this.wireBodyChangeCallback(body);
      // Set up parent-child relationships
      if (body.parentName) {
        const parent = this.bodies.get(body.parentName);
        if (parent) parent.children.push(body);
      }
    }

    for (const vp of result.viewpoints) {
      this._viewpoints.push(vp);
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

  get time(): number { return this.currentEt; }
  get spiceInstance(): SpiceInstance | undefined { return this.spice; }

  setTime(et: number): void {
    this.currentEt = et;
    this.events.emit('time:change', { et });
    for (const plugin of this.plugins) {
      plugin.onTimeChange?.(et, this);
    }
  }

  use(plugin: SpiceCraftPlugin): void {
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
      if (!body) return [0, 0, 0];

      const state = body.stateAt(et);
      let x = state.position[0];
      let y = state.position[1];
      let z = state.position[2];
      if (isNaN(x)) return [NaN, NaN, NaN];

      // Walk up the parent chain, resolving composite trajectory centers at each step
      let currentParent = body.parentName;
      if (!currentParent && body.trajectory instanceof CompositeTrajectory) {
        currentParent = body.trajectory.arcAt(et).centerName;
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
      return [0, 0, 0];
    }
  }

  dispose(): void {
    for (const plugin of this.plugins) {
      plugin.dispose?.();
    }
    this.plugins = [];
    this.bodies.clear();
    this._viewpoints = [];
    this.events.dispose();
    this.state.dispose();
  }
}
