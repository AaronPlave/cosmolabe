import type { TerrainConfig, TerrainImageryConfig } from './TerrainManager.js';

/**
 * Streamed surface imagery as a Globe capability (#123).
 *
 * A Globe draws in up to three tiers: its static `baseMap` (always loaded,
 * shown from far away and whenever streaming fails), a streamed imagery stack
 * that replaces it as the camera approaches, and optional physical terrain the
 * same stack is draped over. Imagery is independent of terrain: it may be
 * declared as a sibling `Globe.imagery`, and a Globe with imagery but no
 * terrain renders it on the body's ellipsoid.
 *
 * Everything here is plain config arithmetic, kept free of the tiles renderer
 * so the catalog rules and layer bookkeeping are testable on their own.
 */

/** Where a layer sits in the stack. The base is the bottom layer and is always on. */
export type ImageryLayerRole = 'base' | 'overlay';

/**
 * Load health of one layer, as the viewer reports it.
 *
 * - `idle` — nothing requested yet (or the layer is switched off).
 * - `ok` — tiles are arriving and none have failed.
 * - `partial` — some tiles failed; lower layers show through the gaps.
 * - `failed` — every request so far failed, or the source could not be set up.
 */
export type ImageryLayerStatus = 'idle' | 'ok' | 'partial' | 'failed';

/** One layer of a body's imagery stack, as the viewer controls see it. */
export interface ImageryLayerInfo {
  id: string;
  name: string;
  /** Who serves the data, for provenance. Defaults to the service host. */
  attribution: string;
  role: ImageryLayerRole;
  /** False for the base, which keeps the globe textured with every overlay off. */
  optional: boolean;
  visible: boolean;
  opacity: number;
  /** Coverage `[west, south, east, north]` in degrees; null for global layers. */
  bounds: [number, number, number, number] | null;
  /** First source zoom with data (regional products have none below it). */
  minZoom: number;
  /** Deepest source zoom. */
  maxLevel: number;
  /** Equatorial ground size of one pixel at `maxLevel`, estimated from the tile pyramid; often finer than the data (`resolutionMeters`). Null when the grid is discovered at load time. */
  metersPerPixel: number | null;
  status: ImageryLayerStatus;
  requests: number;
  failedTiles: number;
  /** Native ground resolution in m/px, as the provider advertises it; null when the catalog does not say. */
  resolutionMeters: number | null;
  /** The full product name, for details. Null when the catalog gives none. */
  description: string | null;
  /** What the layer adds to the current view; null while it is not drawn, and for an imagery-only base. */
  view: ImageryLayerView | null;
}

/** One overlay against the tiles in view, rather than the session's request counters. */
export interface ImageryLayerView {
  /** Some tile in view lies inside the layer's coverage. Always true for a global layer. */
  inCoverage: boolean;
  /** Deepest source zoom those tiles ask for. Below `minZoom` the layer draws nothing there. */
  zoomLevel: number | null;
  /** Tiles in view drawn without this layer, because its source tiles failed. */
  missingTiles: number;
  /** Source tiles in view that failed and are drawn from a coarser tile instead. */
  degradedTiles: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `imagery` as written in a catalog: one layer or a bottom→top list. */
export function imageryList(imagery: unknown): TerrainImageryConfig[] {
  const list = Array.isArray(imagery) ? imagery : imagery == null ? [] : [imagery];
  return list.filter((l): l is TerrainImageryConfig => isObj(l) && typeof l.url === 'string' && l.url !== '');
}

/** Whether a terrain config names a source the renderer can stream. */
function streamable(t: TerrainConfig): boolean {
  if (!t.type) return false;
  if (t.type === 'imagery') return imageryList(t.imagery).length > 0;
  return !!(t.url || t.cesiumIonAssetId != null);
}

/**
 * The single streamed-surface config a Globe's geometry asks for, or null when
 * it has none (static `baseMap` only).
 *
 * - `terrain` alone: unchanged, so existing catalogs keep their behaviour.
 * - `imagery` alone: imagery-only rendering on the body ellipsoid.
 * - both: the terrain source with the sibling imagery stack draped on it. A
 *   `terrain: { "type": "imagery", ... }` with no layers of its own takes the
 *   sibling stack too, which is how imagery-only rendering gets its tuning
 *   fields (`showAtPixels`, `overlayResolution`, ...).
 *
 * When both `imagery` and `terrain.imagery` are present the sibling wins and
 * `onWarning` is told: two stacks for one surface is a catalog mistake, not
 * something to merge.
 */
export function resolveGlobeSurfaceConfig(
  geometry: { terrain?: unknown; imagery?: unknown } | null | undefined,
  onWarning?: (message: string) => void,
): TerrainConfig | null {
  if (!geometry) return null;
  const terrain = isObj(geometry.terrain) ? geometry.terrain as unknown as TerrainConfig : null;
  const sibling = imageryList(geometry.imagery);

  if (sibling.length === 0) return terrain && streamable(terrain) ? terrain : null;
  if (!terrain) return { type: 'imagery', imagery: sibling };
  if (imageryList(terrain.imagery).length > 0) {
    onWarning?.('Globe declares both `imagery` and `terrain.imagery`; using `imagery`.');
  }
  const merged: TerrainConfig = { ...terrain, imagery: sibling };
  return streamable(merged) ? merged : null;
}

/**
 * A readable name for a layer the catalog did not name. Tile services put the
 * product name in the path: Trek and other WMTS REST endpoints as the segment
 * before the `1.0.0` version, ArcGIS as the segment before `MapServer`.
 */
export function defaultLayerName(cfg: TerrainImageryConfig): string {
  if (cfg.layer) return cfg.layer;
  const path = cfg.url.split(/[?#]/)[0].split('/').filter(Boolean);
  const version = path.findIndex((s) => /^\d+\.\d+\.\d+$/.test(s));
  if (version > 0) return path[version - 1];
  const mapServer = path.findIndex((s) => /^(Map|Image)Server$/i.test(s));
  if (mapServer > 0) return path[mapServer - 1];
  return hostOf(cfg.url) ?? cfg.url;
}

function hostOf(url: string): string | null {
  const m = /^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1] : null;
}

/**
 * Equatorial metres per pixel at a layer's deepest level, from its tile
 * pyramid. XYZ/TMS grids in EPSG:4326 have 2×1 tiles at level 0, Web Mercator
 * 1×1; `levels` counts levels, so the deepest is `levels - 1`. Grids that are
 * discovered from a capabilities document or a WMS server return null.
 */
export function nativeMetersPerPixel(cfg: TerrainImageryConfig, equatorialRadiusKm: number): number | null {
  const type = cfg.type ?? 'xyz';
  if (type !== 'xyz' && type !== 'tms') return null;
  const levels = cfg.levels ?? 8;
  const dim = cfg.dimension ?? 256;
  const mercator = (cfg.projection ?? 'EPSG:4326') === 'EPSG:3857';
  const tilesAcross = (mercator ? 1 : 2) * 2 ** (levels - 1);
  return (2 * Math.PI * equatorialRadiusKm * 1000) / (tilesAcross * dim);
}

/** Initial UI-facing state for each configured layer, bottom → top. */
export function describeImageryLayers(configs: TerrainImageryConfig[], equatorialRadiusKm: number): ImageryLayerInfo[] {
  const used = new Set<string>();
  return configs.map((cfg, i) => {
    let id = cfg.id ?? `layer-${i}`;
    while (used.has(id)) id = `${id}-${i}`;
    used.add(id);
    const base = i === 0;
    return {
      id,
      name: cfg.name ?? defaultLayerName(cfg),
      attribution: cfg.attribution ?? hostOf(cfg.url) ?? '',
      role: base ? 'base' : 'overlay',
      optional: !base,
      visible: base || cfg.visible !== false,
      opacity: clampOpacity(cfg.opacity ?? 1),
      bounds: cfg.bounds ?? null,
      minZoom: cfg.minZoom ?? 0,
      maxLevel: (cfg.levels ?? 8) - 1,
      metersPerPixel: nativeMetersPerPixel(cfg, equatorialRadiusKm),
      status: 'idle',
      requests: 0,
      failedTiles: 0,
      resolutionMeters: cfg.resolutionMeters ?? null,
      description: cfg.description ?? null,
      view: null,
    };
  });
}

export function clampOpacity(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

/** The health a layer's request and failure counts amount to. */
export function layerStatus(requests: number, failedTiles: number, setupFailed = false): ImageryLayerStatus {
  if (setupFailed) return 'failed';
  if (requests === 0 && failedTiles === 0) return 'idle';
  if (failedTiles >= Math.max(1, requests)) return 'failed';
  return failedTiles > 0 ? 'partial' : 'ok';
}

/**
 * Whether a `[west, south, east, north]` range in radians (a tile's footprint)
 * overlaps a layer's coverage in degrees. Global layers cover everywhere.
 */
export function overlapsBounds([w, s, e, n]: readonly number[], bounds: ImageryLayerInfo['bounds']): boolean {
  if (!bounds) return true;
  const deg = 180 / Math.PI;
  const [west, south, east, north] = bounds;
  if (n * deg < south || s * deg > north) return false;
  const lonHit = (lo: number, hi: number) => e * deg >= lo && w * deg <= hi;
  // A box crossing the antimeridian is written with west > east.
  return west <= east ? lonHit(west, east) : lonHit(west, 180) || lonHit(-180, east);
}

/**
 * The new bottom→top order after moving one overlay to `toIndex`. The base
 * stays at index 0 whatever is asked, so an all-overlays-off stack is still
 * textured. Returns null when the move is not allowed or changes nothing.
 */
export function reorderedLayers<T extends { role: ImageryLayerRole }>(layers: readonly T[], fromIndex: number, toIndex: number): T[] | null {
  if (fromIndex < 0 || fromIndex >= layers.length || layers[fromIndex].role === 'base') return null;
  const firstOverlay = layers[0]?.role === 'base' ? 1 : 0;
  const to = Math.max(firstOverlay, Math.min(layers.length - 1, toIndex));
  if (to === fromIndex) return null;
  const next = layers.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(to, 0, moved);
  return next;
}
