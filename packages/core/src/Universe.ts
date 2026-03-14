import type { SpiceInstance } from '@spicecraft/spice';
import { Body } from './Body.js';
import { CatalogLoader } from './catalog/CatalogLoader.js';
import type { CatalogJson, CatalogLoaderOptions, ViewpointDefinition } from './catalog/CatalogLoader.js';
import type { SpiceCraftPlugin } from './plugins/Plugin.js';

export interface UniverseOptions {
  /** Resolve trajectory data files (e.g. .xyzv). Return file text content or undefined. */
  resolveFile?: (source: string) => string | undefined;
  /** Resolve binary data files (e.g. .cheb). Return raw bytes or undefined. */
  resolveFileBinary?: (source: string) => ArrayBuffer | undefined;
}

export class Universe {
  private bodies = new Map<string, Body>();
  private _viewpoints: ViewpointDefinition[] = [];
  private currentEt = 0;
  private plugins: SpiceCraftPlugin[] = [];
  private readonly spice?: SpiceInstance;
  private readonly resolveFile?: (source: string) => string | undefined;
  private readonly resolveFileBinary?: (source: string) => ArrayBuffer | undefined;

  constructor(spice?: SpiceInstance, options?: UniverseOptions) {
    this.spice = spice;
    this.resolveFile = options?.resolveFile;
    this.resolveFileBinary = options?.resolveFileBinary;
  }

  loadCatalog(json: CatalogJson): void {
    const loaderOpts: CatalogLoaderOptions = { spice: this.spice, resolveFile: this.resolveFile, resolveFileBinary: this.resolveFileBinary };
    const loader = new CatalogLoader(loaderOpts);
    const result = loader.load(json);

    for (const body of result.bodies) {
      this.bodies.set(body.name, body);
      // Set up parent-child relationships
      if (body.parentName) {
        const parent = this.bodies.get(body.parentName);
        if (parent) parent.children.push(body);
      }
    }

    for (const vp of result.viewpoints) {
      this._viewpoints.push(vp);
    }

    for (const plugin of this.plugins) {
      plugin.onUniverseLoaded?.(this);
    }
  }

  addBody(body: Body): void {
    this.bodies.set(body.name, body);
    if (body.parentName) {
      const parent = this.bodies.get(body.parentName);
      if (parent) parent.children.push(body);
    }
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
   *  Returns [minEt, maxEt] or undefined if no bodies have finite time bounds. */
  getTimeRange(): [number, number] | undefined {
    let min = Infinity;
    let max = -Infinity;
    for (const body of this.bodies.values()) {
      const s = body.trajectory.startTime;
      const e = body.trajectory.endTime;
      if (s !== undefined && s < min) min = s;
      if (e !== undefined && e > max) max = e;
    }
    if (min === Infinity || max === -Infinity) return undefined;
    return [min, max];
  }

  dispose(): void {
    for (const plugin of this.plugins) {
      plugin.dispose?.();
    }
    this.plugins = [];
    this.bodies.clear();
    this._viewpoints = [];
  }
}
