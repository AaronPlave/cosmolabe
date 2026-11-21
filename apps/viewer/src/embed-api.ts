/**
 * The embeddable workspace's public types — everything a host programs
 * against. Kept free of Svelte so its declarations can be published
 * (`embed-types.ts` is the declaration entry; `embed.ts` the implementation).
 */
import type {
  CatalogJson, MissionActivity, MissionActivitySpec, MissionStateChange, MissionStateSource, SourceStatus,
} from '@cosmolabe/core';
import type { AgentTools, AgentTransport, CapabilityTools, CapabilityToolsOptions, ViewerControl } from '@cosmolabe/control';

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
  /**
   * The Ask Cosmolabe prompt (#311), through the host's own model transport.
   * Omitted: no prompt. A host can still drive `agentTools` from an agent of
   * its own without offering the prompt.
   */
  /** Fixed tools are the default; discovery is opt-in pending broader performance evidence. */
  ask?: { transport: AgentTransport; toolMode?: 'fixed' | 'discovery' };
  /** Trusted discovery/permission policy shared by capabilities and embedded Ask. */
  capabilities?: Pick<CapabilityToolsOptions, 'omitted' | 'allowExternal' | 'confirmExternal' | 'onReceipt'>;
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

/**
 * One observation a host supplies (e.g. a simulation's imaging result): the
 * core `Observation` fields in their Cosmographia-style form — `groups` of
 * `{ startTime, endTime, obsRate? }` (ISO UTC ending in Z, or ET seconds), a
 * given `coverage` (`{ kind: 'footprint', polygonLonLat }`, one polygon per
 * group for per-exposure footprints) — plus `observer`, `instrument`,
 * `provenance` and a `requestedRegion` it was evaluated against.
 */
export interface HostObservationSpec {
  name: string;
  /** The observed body (its body-fixed frame is the polygons' frame). */
  target: string;
  groups: readonly { startTime: string | number; endTime: string | number; obsRate?: number }[];
  /** Vertices are `[lon, lat]` (draped on streamed terrain) or `[lon, lat, heightKm]` above `heightDatum` (placed exactly, never re-draped). */
  coverage: { kind: 'footprint'; polygonLonLat: readonly (readonly (readonly [number, number] | readonly [number, number, number])[])[] };
  instrument?: string;
  observer?: string;
  campaign?: string;
  provenance?: import('@cosmolabe/core').DataProvenance;
  requestedRegion?: { name?: string; label?: string; polygonLonLat: readonly (readonly [number, number] | readonly [number, number, number])[] };
  /** Required with heights: the sphere they are measured from (e.g. the producer's terrain reference radius). */
  heightDatum?: { kind: 'sphere'; radiusKm: number };
  footprintColor?: readonly [number, number, number];
  footprintOpacity?: number;
  fillInObservations?: boolean;
}

/**
 * What a host's simulation says an instrument is doing: `acquiring`
 * (exposing / collecting), `standby` (powered, not acquiring) or `off`, over
 * [start, end) intervals (ISO UTC ending in Z, or ET seconds). A time no
 * interval covers is unknown — never treated as acquiring.
 */
export interface HostSensorStateSpec {
  /** The catalog's Sensor body name. */
  sensor: string;
  intervals: readonly { start: string | number; end: string | number; state: 'off' | 'standby' | 'acquiring' }[];
}

/**
 * Host-owned sensor activity. A sensor with host state shows its FOV while
 * acquiring, while inspected (instrument view open, or selected), or when
 * `showIdle(true)`; a sensor no host reports on keeps the catalog behaviour.
 */
export interface HostSensors {
  /** Validate (all or nothing) and set `owner`'s sensor states, replacing its previous ones. Throws on invalid input. */
  replace(owner: string, specs: readonly HostSensorStateSpec[]): void;
  remove(owner: string): boolean;
  /** "Show FOV": draw host-reported sensors' FOVs whatever their state. */
  showIdle(shown: boolean): void;
  /** The state now: null when no host reports on the sensor, 'unknown' outside every interval. */
  stateAt(sensor: string): 'off' | 'standby' | 'acquiring' | 'unknown' | null;
}

/** What the operator clicked: one footprint of a host observation, or its requested region. */
export interface HostObservationPick {
  owner: string;
  name: string;
  /** Polygon index; null when the requested region was clicked. */
  footprint: number | null;
  region: boolean;
  /** The footprint's exposure epoch (ET), when the observation has one group per polygon. */
  et: number | null;
}

/**
 * Host-owned observations: read-only scene content (not editable geography),
 * drawn whatever the clock and draped on streamed terrain. Each owner's list
 * replaces its previous one; they persist across catalog loads.
 */
export interface HostObservations {
  /** Validate (all or nothing) and show `specs` as `owner`'s observations. Throws on invalid input. */
  replace(owner: string, specs: readonly HostObservationSpec[]): void;
  remove(owner: string): boolean;
  /** Emphasize one footprint or a requested region; null clears. */
  select(selection: { owner: string; name: string; footprint?: number | null; region?: boolean } | null): void;
  /** Called when the operator clicks a host observation in the scene. */
  onSelect(listener: (pick: HostObservationPick) => void): () => void;
}

/** A host owner whose activities could not be shown in a newly loaded scene. */
export interface ActivityConflict {
  readonly owner: string;
  readonly message: string;
}

export interface CosmolabeViewer {
  /** The viewer's control port, with every optional capability implemented. */
  readonly control: Required<ViewerControl>;
  /**
   * `control` as typed tools for a language-model agent: JSON-schema inputs,
   * strict validation, bounded scene reads, observed flight completion,
   * supersession and manual-takeover guards. The same tools the built-in
   * prompt uses; see docs/agent-tools.md.
   */
  readonly agentTools: AgentTools;
  /** Versioned discovery and verified receipts for this viewer's shared control operations. */
  readonly capabilities: CapabilityTools;
  readonly missionState: MissionStateApi;
  readonly activities: HostActivities;
  readonly observations: HostObservations;
  readonly sensors: HostSensors;
  /**
   * Change workspace features after mount (e.g. show the native timeline when
   * the host expands the viewer). Only the given keys change.
   */
  setUi(partial: Partial<WorkspaceUi>): void;
  /**
   * Show exactly [start, end] (ISO UTC ending in Z, or ET seconds) on the
   * native timeline — the host's own view window — without moving the clock.
   * The timeline's navigable range grows to include it.
   */
  setTimeWindow(window: { start: string | number; end: string | number }): void;
  /**
   * Load a catalog (URL, or data), replacing the scene. Resolves when the
   * scene's initial assets have settled; rejects — leaving the previous scene
   * up — when it cannot load. Rejects with `ActivityConflictError` when the
   * scene loaded but host activities clash with its records.
   */
  loadCatalog(catalog: string | URL | CatalogInput): Promise<void>;
  /** Release everything. Idempotent. Every handle from this mount (control, missionState, activities) throws afterwards. */
  dispose(): Promise<void>;
}

