import type { SpiceInstance } from '@spicecraft/spice';
import { Body } from './Body.js';
import { CatalogLoader } from './catalog/CatalogLoader.js';
import type { CatalogJson, CatalogLoaderOptions } from './catalog/CatalogLoader.js';
import type { SpiceCraftPlugin } from './plugins/Plugin.js';

export interface UniverseOptions {
  /** Resolve trajectory data files (e.g. .xyzv). Return file text content or undefined. */
  resolveFile?: (source: string) => string | undefined;
  /** Resolve binary data files (e.g. .cheb). Return raw bytes or undefined. */
  resolveFileBinary?: (source: string) => ArrayBuffer | undefined;
}

export class Universe {
  private bodies = new Map<string, Body>();
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

  get time(): number { return this.currentEt; }

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

  dispose(): void {
    for (const plugin of this.plugins) {
      plugin.dispose?.();
    }
    this.plugins = [];
    this.bodies.clear();
  }
}
