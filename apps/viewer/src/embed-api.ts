/**
 * The embeddable workspace's public types — everything a host programs
 * against. Kept free of Svelte so its declarations can be published
 * (`embed-types.ts` is the declaration entry; `embed.ts` the implementation).
 */
import type {
  CatalogJson, MissionActivity, MissionActivitySpec, MissionStateChange, MissionStateSource, SourceStatus,
} from '@cosmolabe/core';
import type { ViewerControl } from '@cosmolabe/control';

/** Major workspace features a host can leave out. All on in the standalone app. */
export interface WorkspaceUi {
  timeline: boolean;
  toolRail: boolean;
  /** Tool panels, inspector and probe readout. */
  analysisPanels: boolean;
  catalogBrowser: boolean;
  homeScreen: boolean;
  /** Keyboard shortcuts while the workspace has focus. */
  shortcuts: boolean;
}

export interface MountOptions {
  /** Major workspace features. Defaults: everything but the catalog browser and home screen. */
  ui?: Partial<WorkspaceUi>;
  /**
   * Where the package's data assets (`cspice.wasm`, `stars.bin`) are served.
   * Defaults to the `assets/` directory beside the module, which is right
   * whenever the package's files are served as built. JavaScript chunks and
   * workers always load relative to the module.
   */
  assetBaseUrl?: string | URL;
  /** Mission-state sources to register at mount; more can be added later. */
  missionState?: readonly MissionStateSource[];
}

/** A catalog given as data. Relative paths inside it resolve against `baseUrl` (default: the page). */
export interface CatalogInput {
  json: CatalogJson;
  baseUrl?: string | URL;
  /** Display name; defaults to the catalog's own. */
  name?: string;
}

/** The host's view of mission-state sources; see `MissionStateSource`. */
export interface MissionStateApi {
  addSource(source: MissionStateSource): void;
  replaceSource(source: MissionStateSource): void;
  removeSource(id: string): boolean;
  sourceIds(): string[];
  status(id: string): SourceStatus | undefined;
  onChange(listener: (change: MissionStateChange) => void): () => void;
}

/**
 * Host-owned mission activities, shown on the existing timeline lanes.
 * Each owner's records replace that owner's previous ones atomically and never
 * touch catalog-owned records; they persist across catalog loads.
 */
export interface HostActivities {
  /** Validate (strictly, atomically) and show `specs` as `owner`'s activities. Throws on invalid input or an ID clash. */
  replace(owner: string, specs: readonly MissionActivitySpec[]): readonly MissionActivity[];
  remove(owner: string): boolean;
  owners(): string[];
}

export interface CosmolabeViewer {
  /** The viewer's control port, with every optional capability implemented. */
  readonly control: Required<ViewerControl>;
  readonly missionState: MissionStateApi;
  readonly activities: HostActivities;
  /**
   * Load a catalog (URL, or data), replacing the scene. Resolves when the
   * scene's initial assets have settled; rejects — leaving the previous scene
   * up — when it cannot load.
   */
  loadCatalog(catalog: string | URL | CatalogInput): Promise<void>;
  /** Release everything. Idempotent. */
  dispose(): Promise<void>;
}

