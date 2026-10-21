import * as THREE from 'three';
import { SurfaceAppearance, type SurfaceAppearanceSettings } from './SurfaceAppearance.js';
import { TerrainContourLabels } from './TerrainContourLabels.js';
import type { ScreenRect } from './EventCallout.js';
import * as TilesThree from '3d-tiles-renderer/three';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { injectShadowIntoShader, type ShadowUniforms } from './EclipseShadow.js';
import { injectAerialPerspectiveIntoShader, type AerialPerspectiveUniforms } from './AerialPerspective.js';
import { isMesh, isMeshBasicMaterial } from './internal/three-typeguards.js';
import { QuantizedMeshPlugin, ImageOverlayPlugin, XYZTilesOverlay, WMSTilesOverlay, WMTSTilesOverlay, TMSTilesOverlay, TilesFadePlugin, DebugTilesPlugin, XYZTilesPlugin, WMTSTilesPlugin, WMTSCapabilitiesLoader, CesiumIonAuthPlugin, type WMTSCapabilitiesResult } from '3d-tiles-renderer/three/plugins';
import { TerrainSampler, bodyFixedToGeodetic, type BodyFixedCartesian, type BodyFixedPosition, type TerrainDatum, type TerrainSample, type TerrainSamplerDiagnostics, type TerrainSourceMetadata } from './TerrainSampler.js';
import { decodeQuantizedMesh, toTerrainMeshTile } from './internal/quantized-mesh.js';
import { parseTileKey, sharedEdgeReport, tileKeyId, type TileKey } from './TerrainValidation.js';
import { clampOpacity, describeImageryLayers, imageryList, layerStatus, overlapsBounds, reorderedLayers, type ImageryLayerInfo, type ImageryLayerView } from './ImageryLayers.js';
import { CubeGridSurface, CubeSphereGridSource, type CubeCoverage, type CubeGridSourceStats } from './surface/CubeSphereGrids.js';
import type { SurfaceIntersection, SurfaceQueryOptions, SurfaceRay } from './surface/PhysicalSurface.js';
import type { CubeFace } from './surface/CubeSphere.js';
import { fetchWithRetry } from './fetchWithRetry.js';
import { CubeImageryLayer, type CubeImageryConfig, type CubeImageryStats } from './CubeImageryLayer.js';

export interface TerrainImageryConfig {
  /** Imagery source type. Default 'xyz'.
   *
   *  - `'cube'`: preprocessed cube-face imagery.json; requires cubeSphere terrain.
   *    Uses the same source controls with independent imagery blocks.
   *  - `'xyz'`, `'tms'`, `'wms'`, `'wmts'`: standard tile sources assuming
   *    a 2^z × (2^z or 2^(z-1)) tile-count progression per level.
   *  - `'wmts-capabilities'`: discovers tile grid + projection from the
   *    service's `WMTSCapabilities.xml`. Required for services with
   *    non-standard tile grids (e.g. NASA GIBS' EPSG:4326 endpoint uses
   *    2/3/5/10/20/40/80/160/320 columns per level). `url` is the
   *    GetCapabilities URL; `layer` + `tileMatrixSet` pick which layer
   *    and which matrix set inside the capabilities document. */
  type?: 'xyz' | 'wms' | 'wmts' | 'tms' | 'wmts-capabilities' | 'cube';
  /** Tile URL template (XYZ: {x},{y},{z} placeholders; WMS/TMS: base URL).
   *  For `'wmts-capabilities'`: URL of the GetCapabilities XML document. */
  url: string;
  /** Max zoom level available. Default 8. */
  levels?: number;
  /** Tile pixel dimension. Default 256. */
  dimension?: number;
  /** Projection identifier. Default 'EPSG:4326'.
   *
   *  Applies to `type: 'xyz'` overlays. For `'wmts'`, projection is read from
   *  the GetCapabilities `tileMatrixSet.supportedCRS` and this field is ignored
   *  (the upstream `WMTSImageSource` does not accept an override). For `'wms'`,
   *  use the separate `crs` field. */
  projection?: string;
  /** WMS layer name (required for `type: 'wms'`). For `'wmts-capabilities'`:
   *  layer identifier in the capabilities document (e.g.
   *  `'BlueMarble_NextGeneration'`). If omitted, the first layer is used. */
  layer?: string;
  /** TileMatrixSet identifier (only for `type: 'wmts-capabilities'`).
   *  e.g. `'500m'` selects the 500m EPSG:4326 matrix set on NASA GIBS. If
   *  omitted, the first tileMatrixSet on the layer is used. */
  tileMatrixSet?: string;
  /** WMS coordinate reference system. Default 'EPSG:4326'. */
  crs?: string;
  /** WMS image format. Default 'image/png'. */
  format?: string;
  /** WMS styles parameter */
  styles?: string;
  /** WMS version. Default '1.1.1'. */
  version?: string;
  /** WMS: request transparent tiles. Default true. */
  transparent?: boolean;
  /** Bounding box [west, south, east, north] in degrees. Tiles outside are skipped. */
  bounds?: [number, number, number, number];
  /** Minimum zoom level. Tiles below this are skipped (regional data doesn't exist at low zoom). */
  minZoom?: number;
  /** Stretch the top/bottom tile row to ±90° latitude when using Mercator (EPSG:3857).
   *  Default true (3d-tiles-renderer default). Set false for `type: 'imagery'` if
   *  you'd rather see the underlying body sphere at the polar cap than a smear of
   *  the highest-latitude mercator pixel row. Only meaningful for mercator content. */
  endCaps?: boolean;
  /** Layer opacity 0..1. Default 1. Applied to ImageOverlayPlugin overlays; ignored
   *  for the first imagery in an imagery-only array (which generates geometry, not
   *  an overlay). Useful for semi-transparent layers like cloud cover. */
  opacity?: number;
  /** Layer tint color (hex int or any three.js Color value). Default 0xffffff
   *  (no tint). Multiplied per-pixel with the layer texture in the overlay
   *  shader. Mostly useful for diagnostics ("does the overlay render at all?"
   *  — set a wild color) but also for stylized basemaps. Applied to overlays
   *  only; ignored for the geometry-generating first imagery. */
  color?: number;
  /** ISO date string `YYYY-MM-DD` for time-dimensioned services (NASA GIBS).
   *  The literal string `'yesterday'` resolves to today-UTC minus one day —
   *  matches the typical 24h publishing lag of daily imagery products like
   *  VIIRS/MODIS true-color reflectance. When set, the resolved date replaces
   *  the `default` time segment in the WMTS tile URL path. */
  time?: string | 'yesterday';
  /** Stable id for viewer controls. Defaults to `layer-<index>`. */
  id?: string;
  /** Display name for viewer controls. Defaults to the product name in the URL path. */
  name?: string;
  /** Provenance shown with the layer. Defaults to the service host. */
  attribution?: string;
  /** The full product name, shown in the layer's details; keep `name` short. */
  description?: string;
  /** Native ground resolution in m/px, as the provider advertises it. The
   *  tile pyramid's own pixel size is often finer, since providers pad levels. */
  resolutionMeters?: number;
  /** Start switched on. Default true. A layer that starts off requests nothing
   *  until switched on. Ignored for the bottom (base) layer, which is always on. */
  visible?: boolean;
}

export interface TerrainConfig {
  /** Terrain source type. 'imagery' uses XYZ image tiles projected onto an ellipsoid (no terrain mesh needed). */
  type: 'quantized-mesh' | 'cesium-ion' | '3dtiles' | 'imagery';
  /** Base URL for quantized-mesh or 3dtiles tileset.json */
  url?: string;
  /** Cesium Ion asset ID (for type: 'cesium-ion') */
  cesiumIonAssetId?: number;
  /** Cesium Ion API token (for type: 'cesium-ion') */
  cesiumIonToken?: string;
  /** Imagery overlay to drape on terrain (single layer or array of layers, bottom to top) */
  imagery?: TerrainImageryConfig | TerrainImageryConfig[];
  /** Screen-space error threshold — higher = coarser tiles. Default 6. */
  errorTarget?: number;
  /** LRU cache max bytes. Default 256MB. */
  maxCacheBytes?: number;
  /** URL of a heightmap to derive per-pixel normals from.
   *  Applied to terrain tiles to smooth shadow boundaries at the terminator. */
  normalMapUrl?: string;
  /** Normal map strength (higher = more dramatic shadows). Default 3. */
  normalMapStrength?: number;
  /** Screen-space body size (pixels) at which to start streaming tiles below the
   *  visible sphere. Tiles pre-load so they're warm by the time the sphere swaps
   *  out. Default 40. Pair with showAtPixels (must be < showAtPixels). */
  preloadAtPixels?: number;
  /** Screen-space body size (pixels) at which to swap from the static sphere to
   *  streamed tiles. Lower = tiles appear sooner (more bandwidth, more pop-in
   *  on slow connections). Default 80. Tune per-body: a high-res GIBS Earth
   *  might warrant 60; a coarse Mars overlay might warrant 200. */
  showAtPixels?: number;
  /** Offset (km) between this tileset's reference surface and the body's IAU sphere.
   *  Some Mars QuantizedMesh datasets (e.g., marshub Mars_v14) encode heights against
   *  a non-standard reference, putting decoded ECEF positions ~8 km above where SPICE
   *  expects them. Setting this to a positive value subtracts it from the ellipsoid
   *  radius the QuantizedMesh decoder uses, pulling decoded vertices radially inward
   *  by that amount so they align with SPICE positions. Calibrate by sampling terrain
   *  at a body with a known SPICE position (e.g., a rover) and computing
   *  `terrain_sample_elev - spice_elev`. */
  referenceRadiusOffsetKm?: number;
  /** Explicit scientific datum metadata for CPU terrain samples. */
  datum?: Partial<Omit<TerrainDatum, 'referenceShape'>>;
  /** Provenance and stated vertical uncertainty for terrain samples. */
  sourceMetadata?: Partial<TerrainSourceMetadata>;
  /** Maximum number of decoded CPU terrain tiles retained for sampling. */
  samplerMaxTiles?: number;
  /** Quantized-mesh tile skirt length (m). Each tile edge gets a vertical
   *  skirt hanging down from its perimeter, hiding cracks at LOD-swap
   *  boundaries. The default `null` makes the plugin use `tile.geometricError`
   *  per zoom, which shrinks at high zooms (~1m at z15) and becomes too small
   *  to hide the few-tens-of-meters height mismatches caused by overview
   *  resampling at LOD boundaries. Setting this to a fixed value (e.g., 50)
   *  forces uniform skirts at all zoom levels — same trick the marshub
   *  Mars_v14 setup uses. Use `skirtScale` for distance-adaptive sizing. */
  skirtLength?: number;
  /** Multiplier applied to `tile.geometricError` to derive per-tile skirt
   *  length. Lets you keep small skirts at close zoom (z15 default ~1.25 m)
   *  while scaling them up at altitude (z10 default ~40 m) so they actually
   *  cover the gaps between low-LOD tiles. Typical values 0.03–0.1. When
   *  unset (and `skirtLength` also unset), the plugin defaults to
   *  `tile.geometricError` outright, which produces visible terraces. Ignored
   *  when `skirtLength` is set (skirtLength wins). */
  skirtScale?: number;
  /** `TilesFadePlugin` LOD crossfade in ms; 0 disables it. Defaults to 300,
   *  or 0 for an imagery-only Globe: its parent and child tiles lie on the
   *  same ellipsoid, so wherever both draw mid-fade they z-fight. */
  fadeDurationMs?: number;
  /**
   * Draw only the tiles the main camera can see (default: on for `cubeSphere`
   * products, off otherwise). The renderer marks a tile visible when any of the
   * streaming cameras (the wider terrain camera, the 178° coverage and 90° nadir
   * cameras) sees it, so most tiles it selects lie beside, behind or below the
   * view and would be drawn for no pixels (#149). Culled tiles stay selected,
   * loaded and pickable; only their draw is skipped. See `setDrawCulling`.
   */
  drawCulling?: boolean;
  /** ImageOverlayPlugin per-terrain-tile composited texture resolution in
   *  pixels. When unset the plugin uses its built-in default of 256. Each
   *  terrain tile gets one composited texture at this resolution containing
   *  all WMTS overlays sampled across its lat/lon span. Higher = sharper
   *  imagery + less downsampling seams between adjacent terrain tiles, at
   *  the cost of GPU memory (R² × 4 bytes × N tiles) and per-tile composite
   *  cost (re-rendered when LOD changes). Bumping from 256 to 1024 makes the
   *  composite ~16× more expensive per tile, which can outweigh the
   *  resolution gain when terrain is moving — tiles arrive stale-looking
   *  during pan/zoom. Try modest steps (e.g. 512) before reaching for 1024+. */
  overlayResolution?: number;
  /**
   * Experimental cube-sphere CPU grids (#149): the `cpu-grids.json` that
   * `scripts/terrain/dem.py cube-tile` writes beside a `type: '3dtiles'` cube
   * product. When set, CPU samples (readouts, clamping, waypoints) and
   * `intersectSurfaceRay` read these grids, which load by query location and
   * never from rendered meshes; until they arrive, samples are null.
   */
  cubeSphere?: {
    cpuGrids: string;
    /** Levels loaded up front and kept as the coarse fallback. Default 2. */
    residentLevel?: number;
    /** Finer grids retained (LRU). Default 2048. */
    maxDetailTiles?: number;
    /**
     * Cube-face map imagery (`imagery.json` from `scripts/terrain/cube_imagery.py`)
     * draped at its own levels, independently of this product's geometry LOD; see
     * `CubeImageryLayer`. Legacy single product, or shared budget/selection options
     * for `Globe.imagery` layers of type `cube`. The geographic overlay plugin
     * maps through per-vertex longitude/latitude, which cannot
     * register the tiles meeting at each pole (both are face centres).
     */
    imagery?: Omit<CubeImageryConfig, 'url'> & { url?: string };
    /**
     * Draw the product's mixed-LOD skirts (default true). Each .glb lists its
     * surface triangles first (glTF primitive extras `surfaceTriangles`); false
     * draws, and ray-casts, only those, leaving cracks open for diagnosis. CPU
     * queries read the grids, never meshes, so skirts never reach them.
     */
    skirts?: boolean;
  };
}

/**
 * Opt-in debug surface coloring (issue #52). Every mode is diagnostic only: it
 * swaps tile materials for flat unlit colors and restores them on `'none'`.
 *
 * - `lod` — tile depth in the pyramid.
 * - `geometric-error` / `screen-error` — the tileset's declared error, and the
 *   error the renderer computed for the current view; what drives refinement.
 * - `cpu-coverage` — green where the CPU sampler holds this tile's own decoded
 *   heights, amber where the renderer synthesized it by splitting a parent (CPU
 *   queries there answer from the parent, one level coarser). With cube-sphere
 *   grids: green where this tile's own grid is resident, amber where only an
 *   ancestor's is, grey where none is.
 * - `cube-face` — experimental cube-sphere products (#149): hue per face,
 *   brighter with depth, alternate tiles shaded so tile and face edges show.
 * - `imagery-level` — cube imagery (#149): hue per displayed imagery level,
 *   modulated by the texel, independent of the geometry tiles' depth.
 * - `imagery-unlit` — cube imagery texels written unlit, without tone mapping
 *   or colour conversion: what registration checks read back.
 * - `datum-height` — mean tile elevation relative to the terrain datum, blue
 *   below and red above, so below-reference terrain (Jezero) is explicit.
 * - `seam-error` — largest height mismatch along this tile's shared edges with
 *   cached same-level neighbours, green (0) to red (≥ `seamErrorScaleKm`); grey
 *   when no neighbour is cached. The same numbers `scripts/validate-terrain.mjs`
 *   reports offline.
 *
 * Base/residual/coverage-boundary views need the fused products' coverage
 * metadata (#50, #48) and are added with them.
 */
export type TerrainDebugMode = 'none' | 'lod' | 'geometric-error' | 'screen-error' | 'cpu-coverage' | 'datum-height' | 'seam-error' | 'cube-face' | 'imagery-level' | 'imagery-unlit';
export const TERRAIN_DEBUG_MODES: readonly TerrainDebugMode[] = ['none', 'lod', 'geometric-error', 'screen-error', 'cpu-coverage', 'datum-height', 'seam-error', 'cube-face', 'imagery-level', 'imagery-unlit'];
/** Debug views drawn by the cube imagery shader rather than DebugTilesPlugin. */
const IMAGERY_DEBUG: Partial<Record<TerrainDebugMode, 'unlit' | 'level'>> = { 'imagery-level': 'level', 'imagery-unlit': 'unlit' };
const CUBE_FACE_HUE: Record<string, number> = { px: 0.0, nx: 0.5, py: 0.33, ny: 0.83, pz: 0.16, nz: 0.62 };
/** `face/level/x/y` of a cube-sphere tile's content, or null. */
const cubeAddress = (tile: any): { face: CubeFace; level: number; x: number; y: number } | null => {
  const m = /(?:^|\/)(px|nx|py|ny|pz|nz)\/(\d+)\/(\d+)\/(\d+)\.glb$/.exec(tile?.content?.uri ?? '');
  return m ? { face: m[1] as CubeFace, level: Number(m[2]), x: Number(m[3]), y: Number(m[4]) } : null;
};

export interface TerrainTiming {
  count: number;
  lastMs: number;
  meanMs: number;
  maxMs: number;
}

/**
 * Terrain cost and load, cheap enough to read every UI tick. Timings are
 * main-thread wall time. Memory is an estimate from the loaded tiles' buffers
 * (geometry attributes, and texture dimensions × 4 bytes), not a GPU query.
 */
export interface TerrainPerformanceMetrics {
  /** `tiles.update()` per frame, over the last 120 frames. */
  update: TerrainTiming;
  /** Renderer mesh construction (`parseToMesh`), per tile, since start. */
  parse: TerrainTiming;
  /** CPU-sampler decode + triangle binning, per tile, since start. */
  cpuDecode: TerrainTiming;
  /** CPU height queries. Independent of rendered vertex count by construction. */
  sample: { count: number; lastMicros: number; meanMicros: number };
  /** `visible`: selected by any streaming camera; `drawn`: of those, left visible by the main-view draw cull. */
  tiles: { active: number; visible: number; drawn: number; inCache: number; cpu: number };
  network: { requests: number; queued: number; downloading: number; parsing: number; failed: number };
  memory: { cacheBytes: number; maxCacheBytes: number; geometryBytes: number; textureBytes: number };
  /** Imagery stack load. `requests`/`failed` count overlay fetches; in imagery-only mode the base layer's tiles are in `network`. */
  imagery: { layers: number; activeOverlays: number; overlayResolution: number; requests: number; failed: number };
}

/** Accumulates per-event wall time; `window` > 0 keeps only the most recent samples. */
class TimingStat {
  private readonly ring: Float64Array | null;
  private idx = 0;
  count = 0;
  private total = 0;
  private last = 0;
  private max = 0;
  constructor(window = 0) { this.ring = window > 0 ? new Float64Array(window) : null; }
  add(ms: number): void {
    this.last = ms;
    this.count++;
    if (this.ring) {
      this.total += ms - this.ring[this.idx];
      this.ring[this.idx] = ms;
      this.idx = (this.idx + 1) % this.ring.length;
    } else {
      this.total += ms;
      this.max = Math.max(this.max, ms);
    }
  }
  reset(): void { this.count = 0; this.total = 0; this.last = 0; this.max = 0; this.idx = 0; this.ring?.fill(0); }
  get value(): TerrainTiming {
    const n = this.ring ? Math.min(this.count, this.ring.length) : this.count;
    const max = this.ring ? this.ring.reduce((a, v) => Math.max(a, v), 0) : this.max;
    return { count: this.count, lastMs: this.last, meanMs: n ? this.total / n : 0, maxMs: max };
  }
}

const _debugColor = /* @__PURE__ */ new THREE.Color();

/**
 * Upstream's own texture sizing (format, mipmaps, array depth) — what its LRU
 * cache counts. Exported at runtime; the package ships no typings for it.
 */
const MemoryUtils = (TilesThree as unknown as { MemoryUtils: { getTextureByteLength(tex: THREE.Texture): number } }).MemoryUtils;

/**
 * The material `DebugTilesPlugin` set aside when it swapped in a debug one. The
 * plugin keys it by a module-private `Symbol('ORIGINAL_MATERIAL')`, so it is
 * found by description; absent (undefined) when the plugin never touched the mesh.
 */
function originalDebugMaterial(mesh: THREE.Mesh): THREE.Material | undefined {
  for (const sym of Object.getOwnPropertySymbols(mesh)) {
    if (sym.description === 'ORIGINAL_MATERIAL') {
      const m = (mesh as unknown as Record<symbol, THREE.Material | undefined>)[sym];
      return m && m !== mesh.material ? m : undefined;
    }
  }
  return undefined;
}

/**
 * 1×1 transparent PNG returned by preprocessURL when a tile should be skipped.
 *
 * Returning `null` from preprocessURL causes the overlay to call `fetch(null)` → fetch("null")
 * which fetches an HTML page. The browser then fails to decode HTML as an image →
 * InvalidStateError. This cascades and breaks the entire ImageOverlayPlugin.
 * Instead, return a transparent PNG that decodes successfully and contributes nothing visually.
 */
const SKIP_TILE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Resolve a `time` config value to an ISO date string `YYYY-MM-DD`.
 *  Supports the literal `'yesterday'` to mean today-UTC minus one day —
 *  matches the 24h publishing lag of daily GIBS reflectance products.
 *  Returns undefined for unset input. */
function resolveTime(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  if (spec === 'yesterday') {
    return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  }
  return spec;
}

/** Substitute the resolved date into a GIBS-style REST URL. GIBS WMTS REST
 *  URLs follow `/{Layer}/{Style}/{Time}/{TileMatrixSet}/...`; the upstream
 *  WMTSImageSource bakes the capabilities' time-dimension default into the
 *  URL template at init (`{Time}` → `2026-05-18` or whatever), so by the
 *  time `preprocessURL` runs the date is already a path segment, not
 *  `default`. Match that ISO-date segment between style and TMS and swap
 *  it for the user-requested date. Services with a custom style or a
 *  non-date time format fall through unchanged. */
function timeSubstitutedURL(url: string, resolvedTime: string): string {
  return url.replace(/\/default\/\d{4}-\d{2}-\d{2}\//, `/default/${resolvedTime}/`);
}

/** Build a `preprocessURL` callback for a WMTS overlay that does time
 *  substitution. Returns undefined if no time substitution is needed.
 *  (For XYZ overlays, the equivalent helper in `createImageryOverlay` also
 *  enforces minZoom-skipping; for WMTS overlays minZoom semantics live on
 *  `calculateLevel` instead — clamping the requested level so the data is
 *  *up*-sampled rather than skipped.) */
function buildWmtsOverlayPreprocessURL(
  time: string | undefined,
): ((url: string) => string) | undefined {
  if (!time) return undefined;
  return (url: string) => timeSubstitutedURL(url, time);
}

/** Clamp a WMTS overlay's `calculateLevel` to a minimum, so far-out zooms
 *  request good-quality tiles rather than the source's coarse-LOD output.
 *  Distinct from `preprocessURL`-based skipping (the XYZ pattern): a clamp
 *  *up-samples* — the overlay fetches level-`min` tiles even when the base
 *  is rendering at level 0, and `ImageOverlayPlugin` composites them over
 *  the larger base region. Result: overlay stays visible at every zoom,
 *  just uses a fixed-floor LOD when the natural one would be too coarse.
 *
 *  Use case: NASA GIBS' VIIRS_*_TrueColor at levels 0-2 shows individual
 *  orbital swaths (data not composited). Level 3+ blends cleanly. Clamping
 *  to 3 keeps clouds visible without the streaky low-LOD artifacts.
 *
 *  `calculateLevel` lives on `TiledImageOverlay`, the (non-exported)
 *  superclass of `WMTSTilesOverlay`, so we monkey-patch through `any`. */
function clampOverlayMinLevel(overlay: WMTSTilesOverlay, minLevel: number): void {
  type CalcFn = (range: number[], tile: unknown) => number;
  const o = overlay as unknown as { calculateLevel: CalcFn };
  const original = o.calculateLevel.bind(o);
  o.calculateLevel = (range, tile) => Math.max(original(range, tile), minLevel);
}

type ImageryOverlay = XYZTilesOverlay | WMSTilesOverlay | WMTSTilesOverlay | TMSTilesOverlay;

/** An overlay built and initialized for one layer, waiting to be attached. */
interface PreparedOverlay { id: string; overlay: ImageryOverlay; generation: number }

/** Upstream overlay members the shipped typings leave out. */
type OverlayInternals = { opacity: number; preprocessURL: ((url: string) => string) | null; init(): Promise<unknown> };
/** Upstream tile loading states (`3d-tiles-renderer/core` constants, missing from its typings). */
const FAILED = -1, LOADED = 4;
type CoverageTile = {
  internal?: { hasContent: boolean; loadingState: number };
  traversal?: { inFrustum: boolean };
  children: CoverageTile[];
};
/** The slice of upstream's TilingScheme the in-view report reads. */
type OverlayTiling = {
  minLevel: number;
  maxLevel: number;
  toCartographicRange(range: number[]): number[];
  getTilesInRange(minX: number, minY: number, maxX: number, maxY: number, level: number, normalized: boolean): number[];
};
type TileFetcher = { fetchItem(tokens: number[], signal?: AbortSignal): Promise<THREE.Texture> };

/** Coarser levels tried in place of a source tile that fails. */
/** The parts of a tile's bounding volume `tileInMainView` reads. */
interface TileVolume {
  sphere?: THREE.Sphere | null;
  obb?: { points: THREE.Vector3[] } | null;
  regionObb?: { points: THREE.Vector3[] } | null;
}

/**
 * Whether a tile's bounding volume can show in a frustum, seen from `eye`, all
 * in tile space (the body centre at the origin, metres). Conservative: hidden
 * only when outside one plane of the frustum, or when every box corner lies
 * behind a sphere of `minRadius` (below all terrain) as seen from the eye —
 * beyond its horizon plane and inside its shadow cone, a convex region, so the
 * whole box is (Cesium's ellipsoidal occluder test, for a sphere).
 */
export function tileInMainView(bv: TileVolume, frustum: THREE.Frustum, eye: THREE.Vector3, minRadius: number): boolean {
  if (bv.sphere && !frustum.intersectsSphere(bv.sphere)) return false;
  const points = (bv.obb ?? bv.regionObb)?.points;
  if (!points) return true;
  if (!frustum.planes.every((p) => points.some((v) => p.distanceToPoint(v) >= 0))) return false;
  const vh2 = eye.lengthSq() - minRadius * minRadius;
  if (vh2 <= 0) return true;
  return points.some((v) => {
    const d = -_horizon.subVectors(v, eye).dot(eye);
    return !(d > vh2 && d * d > vh2 * _horizon.lengthSq());
  });
}
const _horizon = /* @__PURE__ */ new THREE.Vector3();

const PARENT_FALLBACK_LEVELS = 4;

/**
 * Stand in for an XYZ source tile that fails (a bad request, an undecodable
 * image) with the matching quarter of its parent, up to
 * PARENT_FALLBACK_LEVELS coarser. Upstream composites a terrain tile from
 * every source tile under it at once, so one bad source tile otherwise drops
 * the layer from the whole terrain tile. ArcGIS's CTX mosaic serves
 * corrupt PNGs at some z11/z12 tiles around Jezero.
 */
export function fallBackToParentTiles(source: TileFetcher, onLoad: (tile: number[], fromParent: boolean) => void): void {
  const fetchItem = source.fetchItem.bind(source);
  const fetchOrParent = async ([x, y, level]: number[], signal: AbortSignal | undefined, depth: number): Promise<THREE.Texture> => {
    try {
      const tex = await fetchItem([x, y, level], signal);
      if (depth === 0) onLoad([x, y, level], false);
      return tex;
    } catch (err) {
      if (signal?.aborted || level === 0 || depth >= PARENT_FALLBACK_LEVELS) throw err;
      const parent = await fetchOrParent([x >> 1, y >> 1, level - 1], signal, depth + 1);
      const image = parent.image as ImageBitmap;
      if (depth === 0) onLoad([x, y, level], true);
      // A 1×1 skip tile (outside coverage) has no quarter to cut.
      if (image.width < 2) return parent;
      // Source bitmaps are pre-flipped (south row first); tile y counts from the north.
      const w = image.width / 2, h = image.height / 2;
      const quarter = await createImageBitmap(image, (x & 1) * w, (y & 1) ? 0 : h, w, h);
      image.close();
      parent.dispose();
      const tex = new THREE.Texture(quarter);
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    }
  };
  source.fetchItem = (tokens, signal) => fetchOrParent(tokens, signal, 0);
}

/**
 * Hold the static map this long at most once streamed tiles are visible but
 * the queue is still busy. Long enough for the first wave of tiles on a normal
 * connection, short enough that a camera that keeps moving (and so keeps the
 * queue busy) still gets the streamed surface.
 */
const SHOW_GRACE_MS = 1500;

/** With tiles failed, none loaded and nothing in flight this long, the stream is dead. */
const STREAM_STALL_MS = 3000;

/** Create the appropriate imagery overlay based on config type. */
function createImageryOverlay(img: TerrainImageryConfig): ImageryOverlay {
  const type = img.type ?? 'xyz';
  switch (type) {
    case 'wms':
      return new WMSTilesOverlay({
        url: img.url,
        layer: img.layer!,
        crs: img.crs ?? 'EPSG:4326',
        format: img.format ?? 'image/png',
        styles: img.styles,
        version: img.version ?? '1.1.1',
        levels: img.levels ?? 8,
        tileDimension: img.dimension ?? 256,
        transparent: img.transparent ?? true,
        color: img.color ?? 0xffffff,
        opacity: clampOpacity(img.opacity ?? 1),
      });
    case 'wmts': {
      const preprocessURL = buildWmtsOverlayPreprocessURL(resolveTime(img.time));
      // The 3d-tiles-renderer 0.4.24 TS defs made `tileMatrices` required even
      // for the url-only overlay shape — the JS constructor still accepts the
      // old form (it derives matrices from the WMTS URL pattern), so cast
      // through `unknown` to keep the simpler call site.
      const overlay = new WMTSTilesOverlay({
        url: img.url,
        color: img.color ?? 0xffffff,
        opacity: clampOpacity(img.opacity ?? 1),
        ...(preprocessURL ? { preprocessURL } : {}),
      } as unknown as ConstructorParameters<typeof WMTSTilesOverlay>[0]);
      if (img.minZoom != null) clampOverlayMinLevel(overlay, img.minZoom);
      return overlay;
    }
    case 'tms':
      return new TMSTilesOverlay({
        url: img.url,
        color: img.color ?? 0xffffff,
        opacity: clampOpacity(img.opacity ?? 1),
      });
    case 'xyz':
    default: {
      // bounds + minZoom filter: skip tiles outside the coverage rectangle or below minimum zoom.
      // Returns a transparent 1×1 PNG instead of null — fetch(null) would call fetch("null")
      // which returns HTML, and createImageBitmap(htmlBlob) throws InvalidStateError that
      // cascades and breaks the entire ImageOverlayPlugin (including the global Viking layer).
      let preprocessURL: ((url: string) => string) | undefined;
      if (img.bounds || img.minZoom) {
        const bounds = img.bounds;
        const minZ = img.minZoom ?? 0;
        preprocessURL = (url: string) => {
          // Extract z/y/x from URL pattern like .../default028mm/{z}/{y}/{x}.png
          const parts = url.split('/');
          const z = parseInt(parts[parts.length - 3], 10);
          if (isNaN(z)) return url;

          // Skip tiles below minimum zoom — regional datasets don't have data at low levels.
          if (z < minZ) return SKIP_TILE_DATA_URL;

          if (bounds) {
            const y = parseInt(parts[parts.length - 2], 10);
            const x = parseInt(parts[parts.length - 1], 10);
            if (isNaN(y) || isNaN(x)) return url;

            const [west, south, east, north] = bounds;
            const numTilesX = 2 * (1 << z);
            const numTilesY = 1 << z;
            const tileLonSize = 360 / numTilesX;
            const tileLatSize = 180 / numTilesY;
            const tileWest = -180 + x * tileLonSize;
            const tileNorth = 90 - y * tileLatSize;
            const tileEast = tileWest + tileLonSize;
            const tileSouth = tileNorth - tileLatSize;

            if (tileEast < west || tileWest > east || tileNorth < south || tileSouth > north) {
              return SKIP_TILE_DATA_URL;
            }
          }
          return url;
        };
      }
      return new XYZTilesOverlay({
        url: img.url,
        levels: img.levels ?? 8,
        tileDimension: img.dimension ?? 256,
        projection: img.projection ?? 'EPSG:4326',
        color: img.color ?? 0xffffff,
        opacity: clampOpacity(img.opacity ?? 1),
        preprocessURL,
      });
    }
  }
}

/**
 * Manages streaming terrain tiles for a planetary body.
 * Wraps 3DTilesRendererJS's TilesRenderer with appropriate plugins
 * and coordinate transforms for non-Earth bodies.
 */
const _camPos = /* @__PURE__ */ new THREE.Vector3();
const _viewMat = /* @__PURE__ */ new THREE.Matrix4();
const _bufferSize = /* @__PURE__ */ new THREE.Vector2();

export class TerrainManager {
  private readonly contourLabels = new TerrainContourLabels();
  private surfaceStyle: SurfaceAppearance | null;
  private readonly cubeScenes = new Set<THREE.Object3D>();
  private readonly cubeStyleCandidate: boolean;
  private cubeStyleHeightRange: readonly [number, number] | null = null;

  get surfaceAppearance(): SurfaceAppearanceSettings | null { return this.surfaceStyle?.current ?? null; }
  get surfaceContourIntervalKm(): number | null { return this.surfaceStyle?.contourIntervalKm ?? null; }
  get surfaceAppearanceDatum(): TerrainDatum | null { return this.surfaceStyle?.datum ?? null; }
  setSurfaceAppearance(settings: SurfaceAppearanceSettings): void { this.surfaceStyle?.set(settings); }
  readonly tiles: TilesRenderer;
  /** Group to add to the scene. Positioned at body center, transforms meters→km and Z-up→Y-up. */
  readonly group: THREE.Group;
  private readonly isImageryOnly: boolean;
  /** Imagery draped on the body ellipsoid, with no physical terrain. */
  get imageryOnly(): boolean { return this.isImageryOnly; }
  /** Composites imagery overlays per tile; null when no overlay layer is configured. */
  private overlayPlugin: ImageOverlayPlugin | null = null;
  /** True when `ImageOverlayPlugin` is registered. Gates the imagery-only
   *  MeshBasicMaterial → MeshStandardMaterial swap in `customizeTileMaterial`:
   *  the swap discards `ImageOverlayPlugin`'s shader wrap (it lives on the
   *  original material instance via `onBeforeCompile`), so when overlays are
   *  present the wrap is carried across. */
  private get hasOverlays(): boolean { return this.overlayPlugin !== null; }
  /** The imagery stack, bottom → top, in its current order. */
  private readonly layers: ImageryLayerInfo[];
  private readonly layerConfigs = new Map<string, TerrainImageryConfig>();
  /** Overlays currently in the plugin, by layer id. Switched-off layers have none and request nothing. */
  private readonly activeOverlays = new Map<string, ImageryOverlay>();
  private readonly overlayLayerIds = new WeakMap<object, string>();
  /** Bumped on every enable/disable so a slow setup cannot attach a stale overlay. */
  private readonly overlayGeneration = new Map<string, number>();
  /** Layers whose source could not be set up (capabilities fetch, init). */
  private readonly setupFailed = new Set<string>();
  /** Per layer, source tiles (`level/x/y`) that failed and are drawn from a parent. */
  private readonly degradedTiles = new Map<string, Set<string>>();
  private readonly capabilitiesCache = new Map<string, Promise<WMTSCapabilitiesResult>>();
  private _overlayResolution: number;
  /** Tiles that loaded, and geometry/base-imagery tiles that failed, for the stream-failure fallback. */
  private loadedModels = 0;
  /** Tile materials already customized. A virtual (split) tile hands back the
   *  same scene each time it reloads, and chaining the shader injections onto
   *  it again redefines every injected symbol, so the program fails to compile. */
  private readonly customizedMaterials = new WeakSet<THREE.Material>();
  private geometryFailures = 0;
  private rootFailed = false;
  private lastGeometryFailureAt = 0;
  /** When the stream first had visible tiles in the current show attempt (see `isReadyToShow`). */
  private firstVisibleAt = 0;
  /** False while we're still waiting on an async plugin registration (e.g.
   *  wmts-capabilities fetch). tiles.update() crashes on a TilesRenderer with
   *  no URL and no plugin (tries to fetch a null tileset URL), so the render
   *  loop skips updates until this flips true. */
  private _pluginReady = true;
  private readonly bodyRadiusKm: number;
  /** Tileset height-encoding correction applied to CPU samples, in km. */
  private readonly terrainHeightOffsetKm: number;
  /** CPU-only sampler. It never reads renderer scene meshes during a query. */
  readonly sampler: TerrainSampler;
  /** Experimental cube-sphere CPU grids and their #148 ray surface, once the manifest loads. */
  private cube: { source: CubeSphereGridSource; surface: CubeGridSurface } | null = null;
  private readonly cubeConfigured: boolean;
  private cubeSkirts = true;
  private drawCulling = false;
  /** Tile scenes hidden this frame by the main-view cull, shown again before the next update. */
  private readonly culledScenes: THREE.Object3D[] = [];
  /** Experimental cube-face map imagery, independent of geometry LOD (#149). */
  private readonly cubeImagery: CubeImageryLayer | null = null;
  private disposed = false;
  /** Ends the CPU-grid manifest's wait through an outage on dispose. */
  private readonly cubeGridsAbort = new AbortController();
  private shadowUniforms: ShadowUniforms | null = null;
  private aerialPerspectiveUniforms: AerialPerspectiveUniforms | null = null;
  /** Global equirectangular normal map derived from heightmap. Applied per-tile with UV transforms. */
  private normalMap: THREE.CanvasTexture | null = null;
  private debugPlugin: DebugTilesPlugin | null = null;
  private debugMode: TerrainDebugMode = 'none';
  private showBounds = false;
  /** Seam view: an edge mismatch at or above this (km) renders fully red. */
  seamErrorScaleKm = 0.005;
  /** CPU tile id by `z/x/y`, for neighbour lookups in the seam view. */
  private readonly cpuIdByKey = new Map<string, string>();
  private readonly cpuKeyById = new Map<string, TileKey>();
  /** Memoized per-tile debug values, invalidated when a tile or its neighbour changes. */
  private readonly seamErrorKm = new Map<string, number | null>();
  private readonly meanElevationKm = new Map<string, number>();
  private readonly updateTiming = new TimingStat(120);
  private readonly parseTiming = new TimingStat();
  private readonly decodeTiming = new TimingStat();
  private requestCount = 0;
  /** Coverage camera: ensures tiles load for the body's visible hemisphere
   *  even when the main camera's frustum doesn't include the body. */
  private coverageCam: THREE.PerspectiveCamera | null = null;
  /** Nadir camera: 90° FOV pointing straight down to drive high-LOD tiles directly
   *  under the camera. The 178° coverage camera uses such an extreme FOV that its
   *  screen-space error calculation requests only coarse tiles (tiles appear tiny in
   *  the fisheye projection). This camera fills that gap with a normal-FOV view of
   *  the nadir region so the closest tiles always load at the correct detail level. */
  private nadirCam: THREE.PerspectiveCamera | null = null;
  /** Terrain camera: mirrors main camera with terrain-appropriate near/far.
   *  The scene camera's near/far can have extreme ratios (1e-12/1e6) that
   *  produce degenerate frustum planes in the tiles renderer's SAT test. */
  private terrainCam: THREE.PerspectiveCamera | null = null;
  /** The main camera's frustum and position in tile space, set each update. */
  private mainView: { frustum: THREE.Frustum; eye: THREE.Vector3 } | null = null;

  /**
   * @param config Terrain source configuration
   * @param bodyRadii Body radii in km — either a single value (treats body as
   *   a sphere) or `[rx, ry, rz]` for oblate bodies. Oblateness matters
   *   visibly on Mars: at Jezero's 18.44°N the IAU radius is ~3393.95 km,
   *   2.24 km smaller than the equatorial 3396.19 km — treating Mars as a
   *   sphere puts terrain ~2.24 km too high at that latitude vs the
   *   trajectory's latitude-aware position.
   * @param renderer WebGL renderer (needed for ImageOverlayPlugin texture rendering)
   */
  /** Screen-px threshold to begin pre-loading tiles below the visible sphere. */
  readonly preloadAtPixels: number;
  /** Screen-px threshold to swap the static sphere for streamed tiles. */
  readonly showAtPixels: number;

  constructor(
    config: TerrainConfig,
    bodyRadii: number | [number, number, number],
    renderer: THREE.WebGLRenderer,
  ) {
    const [rxKm, ryKm, rzKm] = typeof bodyRadii === 'number'
      ? [bodyRadii, bodyRadii, bodyRadii]
      : bodyRadii;
    this.bodyRadiusKm = Math.max(rxKm, ryKm, rzKm);
    // The datum stays the body's true IAU shape. `referenceRadiusOffsetKm` is a
    // property of the TILESET's height encoding, not of the body, so it is
    // applied to decoded sample heights (see captureDecodedQuantizedMesh)
    // rather than folded into the reference shape here.
    this.terrainHeightOffsetKm = config.referenceRadiusOffsetKm ?? 0;
    const datum: TerrainDatum = {
      referenceShape: rxKm === ryKm && ryKm === rzKm
        ? { kind: 'sphere', radiusKm: rxKm }
        : { kind: 'ellipsoid', radiiKm: [rxKm, ryKm, rzKm] },
      verticalDatum: config.datum?.verticalDatum ?? 'ellipsoid',
      heightConvention: config.datum?.heightConvention ?? 'radial',
    };
    this.sampler = new TerrainSampler(datum, {
      id: config.sourceMetadata?.id ?? config.url ?? `terrain:${config.type}`,
      kind: config.sourceMetadata?.kind ?? (config.type === 'quantized-mesh' ? 'quantized-mesh' : config.type === 'imagery' ? 'imagery' : 'unknown'),
      url: config.sourceMetadata?.url ?? config.url,
      uncertaintyKm: config.sourceMetadata?.uncertaintyKm,
      version: config.sourceMetadata?.version,
    }, config.samplerMaxTiles ?? 256);
    // Other tile types may contain authored models, baked imagery, or an unknown
    // vertical reference. Do not present their coordinates as terrain heights.
    this.surfaceStyle = config.type === 'quantized-mesh' &&
      (datum.verticalDatum === 'ellipsoid' || datum.verticalDatum === 'reference-sphere')
      && (datum.heightConvention === 'radial' || rxKm === ryKm)
      ? new SurfaceAppearance(datum) : null;
    // The sampler's own LRU drops tiles independently of the renderer's; the
    // seam/datum debug indexes must forget them too or they report neighbours
    // the sampler no longer holds.
    this.sampler.onEvict = (id) => this.dropCpuIndexes(id);
    this.cubeConfigured = !!config.cubeSphere;
    this.cubeStyleCandidate = config.type === '3dtiles' && !!config.cubeSphere;
    this.cubeSkirts = config.cubeSphere?.skirts !== false;
    this.drawCulling = config.drawCulling ?? !!config.cubeSphere;
    this.isImageryOnly = config.type === 'imagery';
    const imageryConfigs = imageryList(config.imagery);
    const cubeSources = imageryConfigs.some(c => c.type === 'cube');
    if (cubeSources && (!config.cubeSphere || !imageryConfigs.every(c => c.type === 'cube'))) throw new Error('Cube imagery sources require cubeSphere terrain and an entirely cube imagery stack');
    if (config.cubeSphere?.imagery?.url && imageryConfigs.length > 0 && !cubeSources) {
      throw new Error('Legacy cube imagery cannot be combined with geographic imagery; use an entirely cube imagery stack or remove cubeSphere.imagery.url');
    }
    if (config.cubeSphere) this.loadCubeGrids(config.cubeSphere, datum);
    if (config.cubeSphere?.imagery?.url || cubeSources) {
      const cubeConfig = config.cubeSphere?.imagery ?? {};
      this.cubeImagery = new CubeImageryLayer({ ...cubeConfig, url: cubeConfig.url ?? imageryConfigs[0].url, ...(cubeSources ? { layers: imageryConfigs } : {}) }, { radiusKm: rxKm });
      this.cubeImagery.ready.catch((err) => this.warnOnce('cube-imagery', 'Terrain: cube imagery unavailable', err));
    }
    this.layers = describeImageryLayers(imageryConfigs, rxKm);
    this.layers.forEach((l, i) => this.layerConfigs.set(l.id, imageryConfigs[i]));
    this._overlayResolution = config.overlayResolution ?? 256;
    this.preloadAtPixels = config.preloadAtPixels ?? 40;
    this.showAtPixels = config.showAtPixels ?? 80;

    // For imagery-only mode, no tileset URL needed — XYZTilesPlugin generates geometry.
    // For Cesium Ion, the auth plugin resolves the tileset URL via the Ion API, so we
    // also construct without a URL. For quantized-mesh / 3dtiles, the URL points at
    // the tileset's layer.json / tileset.json.
    const constructWithoutUrl = this.isImageryOnly || config.type === 'cesium-ion';
    this.tiles = new TilesRenderer(constructWithoutUrl ? undefined : config.url);

    // Upstream bug guard: multiple plugins (QuantizedMeshPlugin, ImageOverlayPlugin)
    // access tile.children.length in disposeTile without null checks. During LRU cache
    // eviction, tile.children can be null. Register a guard plugin FIRST so its
    // disposeTile runs before the others and ensures children is always an array.
    this.tiles.registerPlugin({
      disposeTile(tile: any) {
        if (!tile.children) tile.children = [];
      },
    } as any);

    if (this.isImageryOnly) {
      // Imagery-only mode: the first imagery config generates ellipsoid tile
      // geometry (XYZTilesPlugin or WMTSTilesPlugin); any additional configs
      // get draped on top as ImageOverlayPlugin overlays. Mirrors the
      // terrain-mesh branch's overlay handling (line ~360) so multi-layer
      // composition works regardless of which TerrainConfig.type is in use.
      //
      // Setup is async whenever any layer uses wmts-capabilities (the
      // GetCapabilities fetch). We dedupe by URL so multiple GIBS layers that
      // all point at the same WMTSCapabilities.xml only fetch once and share
      // the parsed document — tile-grid alignment between base and overlays
      // depends on them seeing the same capabilities. `_pluginReady` gates
      // tiles.update() until everything is registered (calling update() on a
      // TilesRenderer with no plugin crashes inside fetch(null)).
      this._pluginReady = false;
      const baseImg = imageryConfigs[0];
      if (!baseImg) throw new Error('TerrainManager: type "imagery" needs at least one imagery layer with a `url`.');

      const basePluginOpts = {
        shape: 'ellipsoid' as const,
        useRecommendedSettings: true,
        // Mercator end caps stretch the top/bottom tile row to ±90°. Useful
        // when there's no underlying sphere, awkward when there is one (the
        // smeared southernmost mercator row covers the body's static baseMap
        // at the polar cap). Only applied to the base layer — overlays follow
        // the base's geometry.
        ...(baseImg.endCaps === false ? { endCaps: false } : {}),
      };

      // Base layer setup — synchronous for XYZ, async for wmts-capabilities.
      // Resolves to a 0-arg function that actually registers the plugin so we
      // can sequence base before overlays in the final Promise.all callback.
      const baseReady: Promise<() => void> = baseImg.type === 'wmts-capabilities'
        ? this.fetchCapabilities(baseImg.url).then((capabilities) => () => {
            // `capabilities` is the deprecated-but-still-runtime-supported shape
            // (0.4.24 changelog). TS defs now require `tileMatrices` directly;
            // cast through `unknown` to preserve the simpler runtime call.
            this.tiles.registerPlugin(new WMTSTilesPlugin({
              capabilities,
              layer: baseImg.layer,
              tileMatrixSet: baseImg.tileMatrixSet,
              ...basePluginOpts,
            } as unknown as ConstructorParameters<typeof WMTSTilesPlugin>[0]));
          })
        : Promise.resolve(() => {
            this.tiles.registerPlugin(new XYZTilesPlugin({
              url: baseImg.url,
              levels: baseImg.levels ?? 8,
              // The same default as overlays. Upstream's is Web Mercator, which
              // put an equirectangular base (all of Trek) in the wrong place.
              // Supported at runtime, missing from the shipped typings.
              projection: baseImg.projection ?? 'EPSG:4326',
              ...basePluginOpts,
            } as ConstructorParameters<typeof XYZTilesPlugin>[0]));
          });

      // Base layer time substitution. The WMTSTilesPlugin / XYZTilesPlugin
      // construction pipeline (ImageFormatPlugin in 3d-tiles-renderer) calls
      // `tiles.invokeAllPlugins(plugin => preprocessURL?.(...))` to massage
      // tile URLs — so registering a plain plugin object with a preprocessURL
      // is enough. ImageOverlayPlugin uses its OWN per-overlay preprocessURL
      // (not this chain), so this hook never affects overlay URLs.
      const baseTime = resolveTime(baseImg.time);
      if (baseTime) {
        this.tiles.registerPlugin({
          preprocessURL: (url: string) => timeSubstitutedURL(url, baseTime),
        } as { preprocessURL: (url: string) => string });
      }

      // The first layer generates ellipsoid geometry; every other layer is an
      // ImageOverlayPlugin overlay. The plugin is registered whenever overlays
      // are configured, even if all start switched off, so the viewer can turn
      // them on later. Tile splitting is the upstream default here: in
      // imagery-only mode the base tiles need the plugin's splitter to take
      // higher-resolution overlay data. (The terrain-mesh branch disables it
      // because the terrain mesh already provides the splitting strategy.)
      if (imageryConfigs.length > 1) this.registerOverlayPlugin(renderer, true);
      const overlaysReady = this.layers.slice(1).filter((l) => l.visible).map((l) => this.prepareOverlay(l.id));

      Promise.all([baseReady, Promise.all(overlaysReady)]).then(([registerBase, overlays]) => {
        registerBase();
        overlays.forEach((o) => this.attachOverlay(o));
        this._pluginReady = true;
      }).catch((err) => {
        // Only the base can reject (overlay setup failures are per layer).
        // Without it there is no geometry: the body keeps its static map.
        this.setupFailed.add(this.layers[0].id);
        console.error('[TerrainManager] Failed to set up base imagery layer; keeping the static map:', err);
      });
    } else {
      if (config.type === 'quantized-mesh') {
        const qmOpts: { useRecommendedSettings: boolean; skirtLength?: number } = {
          useRecommendedSettings: true,
        };
        if (config.skirtLength != null) qmOpts.skirtLength = config.skirtLength;
        // Monkey-patch parseToMesh so skirtLength = tile.geometricError * skirtScale
        // per tile. The plugin only supports a single scalar skirtLength, but a
        // single value either visibly terraces at altitude (when big enough to
        // hide low-LOD gaps) or shows hairline cracks at high LOD (when small).
        // skirtScale gives us a per-LOD skirt without forking the plugin.
        const qmPlugin = new QuantizedMeshPlugin(qmOpts) as unknown as {
          parseToMesh: (buffer: ArrayBuffer, tile: any, extension: string, uri: string) => unknown;
          skirtLength: number | null;
        };
        const parseToMesh = qmPlugin.parseToMesh.bind(qmPlugin);
        qmPlugin.parseToMesh = (buffer, tile, extension, uri) => {
          if (extension === 'terrain') this.captureDecodedQuantizedMesh(buffer, tile, uri);
          const start = performance.now();
          const result = parseToMesh(buffer, tile, extension, uri);
          const done = () => this.parseTiming.add(performance.now() - start);
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            (result as Promise<unknown>).then(done, () => {});
          } else {
            done();
          }
          return result;
        };
        if (config.skirtLength == null && config.skirtScale != null) {
          const skirtScale = config.skirtScale;
          const origParseToMesh = qmPlugin.parseToMesh.bind(qmPlugin);
          qmPlugin.parseToMesh = function (buffer, tile, extension, uri) {
            const prev = qmPlugin.skirtLength;
            qmPlugin.skirtLength = tile.geometricError * skirtScale;
            try {
              return origParseToMesh(buffer, tile, extension, uri);
            } finally {
              qmPlugin.skirtLength = prev;
            }
          };
        }
        this.tiles.registerPlugin(qmPlugin as any);
      } else if (config.type === 'cesium-ion') {
        if (!config.cesiumIonToken) {
          throw new Error(`TerrainManager: type "cesium-ion" requires \`cesiumIonToken\` (Cesium Ion API token). Set VITE_CESIUM_ION_TOKEN in apps/viewer/.env.local and the loader will inject it.`);
        }
        if (config.cesiumIonAssetId == null) {
          throw new Error(`TerrainManager: type "cesium-ion" requires \`cesiumIonAssetId\` (e.g. 3644333 for Cesium Mars).`);
        }
        this.tiles.registerPlugin(new CesiumIonAuthPlugin({
          apiToken: config.cesiumIonToken,
          assetId: String(config.cesiumIonAssetId),
        }));
        // Cesium Ion returns 404 "ResourceNotFound" when the asset isn't in
        // your account, even with a valid token. Premium assets (Cesium Mars,
        // Moon, etc.) require an explicit "Add to my assets" click in the
        // Asset Depot first — surface this hint instead of the bare 404.
        const ionAssetId = config.cesiumIonAssetId;
        this.tiles.addEventListener('load-error', (event: any) => {
          if (event.url?.includes(`/v1/assets/${ionAssetId}/endpoint`) && event.error?.message?.includes('404')) {
            console.error(`[Cosmolabe:Terrain] Cesium Ion asset ${ionAssetId} returned 404. Likely cause: the asset isn't in your account yet. Visit https://ion.cesium.com/assetdepot, find the asset, click "Add to my assets", then reload.`);
          }
        });
      }

      // Imagery overlays: drape image tiles onto terrain geometry. Overlays
      // attach in stack order once all are constructed (capabilities-discovered
      // grids wait on a fetch) so tiles never load before their imagery.
      if (imageryConfigs.length > 0 && !this.cubeImagery) {
        this.registerOverlayPlugin(renderer, false);
        this._pluginReady = false;
        Promise.all(this.layers.filter((l) => l.visible).map((l) => this.prepareOverlay(l.id))).then((overlays) => {
          overlays.forEach((o) => this.attachOverlay(o));
          this._pluginReady = true;
        });
      }
    }

    // Fade between LOD transitions to smooth color differences between zoom
    // levels. Off by default for imagery-only (see `fadeDurationMs`); set it
    // to 0 in the catalog for HiRISE-detail terrain, where the fade can jitter
    // as tiles stream in/out while the camera is moving.
    // Every tile of a cube product exists (the publisher checks), so a network error, 5xx
    // or 429 is transient: retry it, with no attempt limit, while the tile stays loading.
    // Upstream counts a failed child as ready and drops its parent, which would leave a
    // hole for the session; this way the parent stays drawn through an outage and the
    // tile arrives when the host recovers. The renderer aborts it if it is no longer wanted.
    if (config.cubeSphere) {
      this.tiles.registerPlugin({ fetchData: (url: string, options: RequestInit) => fetchWithRetry(url, options, { tries: Infinity }) } as never);
    }

    const fadeMs = config.fadeDurationMs ?? (this.isImageryOnly ? 0 : 300);
    if (fadeMs > 0) {
      this.tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: fadeMs }));
    }

    // Upstream bug: QuantizedMeshPlugin.expandChildren always pushes new children
    // without checking if children already exist. When a tile is evicted from the LRU
    // cache, disposeTile removes virtual children but keeps real ones. When the tile
    // is re-loaded, expandChildren creates duplicates. The old children have .traversal
    // (from preprocessing) but the new ones don't, causing TypeError crashes in the
    // traversal that silently abort the entire update cycle — no tiles get queued.
    //
    // Fix: skip only if all 4 quadtree children are present. If < 4, some virtual
    // children were removed during eviction — clear and re-expand to fill the gaps.
    // The cleared children get re-preprocessed on the next traversal cycle.
    const qmPlugin = (this.tiles as any).getPluginByName('QUANTIZED_MESH_PLUGIN');
    if (qmPlugin && qmPlugin.expandChildren) {
      const origExpand = qmPlugin.expandChildren.bind(qmPlugin);
      qmPlugin.expandChildren = (tile: any) => {
        if (tile.children && tile.children.length >= 4) return;
        // Clear partial children to prevent duplicates, then re-expand.
        tile.children = [];
        origExpand(tile);
      };
    }

    // Customize tile materials as they load
    this.tiles.addEventListener('load-model', (event: { scene: THREE.Object3D; tile: any }) => {
      this.loadedModels++;
      this.customizeTileMaterial(event.scene, event.tile);
      if (this.cubeConfigured) {
        this.cubeScenes.add(event.scene);
        this.applyCubeSkirts(event.scene);
      }
      const address = this.cubeImagery ? cubeAddress(event.tile) : null;
      if (address) this.cubeImagery!.addTile(event.tile, event.scene, address);
      if (this.cubeConfigured) this.attachSurfaceStyle(event.scene);
    });
    this.tiles.addEventListener('dispose-model', (event: { tile: any; scene: THREE.Object3D }) => {
      this.cubeScenes.delete(event.scene);
      if (event.scene) this.surfaceStyle?.forget(event.scene);
      this.cubeImagery?.removeTile(event.tile);
      const id = this.cpuTileId(event.tile);
      if (id) this.forgetCpuTile(id);
    });
    this.tiles.addEventListener('tile-download-start', () => {
      this.requestCount++;
      // Imagery-only: the base layer's images are the geometry tiles.
      if (this.isImageryOnly && this.layers[0]) this.layers[0].requests++;
    });
    // Attribute failures to the layer that owns them. ImageOverlayPlugin tags
    // overlay failures with the overlay; anything else is a geometry tile (the
    // base imagery, in imagery-only mode) or, with no tile, the root tileset.
    this.tiles.addEventListener('load-error', (event: { tile?: unknown; overlay?: object }) => {
      if (event.overlay) {
        const id = this.overlayLayerIds.get(event.overlay);
        const layer = id ? this.layer(id) : undefined;
        if (layer && this.activeOverlays.get(layer.id) === event.overlay) layer.failedTiles++;
        return;
      }
      if (!event.tile) this.rootFailed = true;
      this.geometryFailures++;
      this.lastGeometryFailureAt = performance.now();
      if (this.isImageryOnly && this.layers[0]) this.layers[0].failedTiles++;
    });

    // Log tile load errors — rate-limited to avoid flooding the console.
    // Sparse terrain datasets (e.g. Mars Hub at level 12+) may return 404 for valid-looking
    // tile coordinates that simply aren't in the dataset. These are non-blocking but noisy.
    let errCount = 0, errLoggedAt = 0;
    this.tiles.addEventListener('load-error', (event: any) => {
      errCount++;
      const now = Date.now();
      if (now - errLoggedAt > 5000) {
        const suffix = errCount > 1 ? ` (+${errCount - 1} suppressed since last log)` : '';
        console.warn('[Cosmolabe:Terrain] Tile load error:', event.url, event.error?.message, suffix);
        errCount = 0;
        errLoggedAt = now;
      }
    });

    // Load heightmap and generate per-pixel normal map for terrain tiles.
    // Smooths out the faceted vertex-normal shading from coarse tile geometry.
    if (config.normalMapUrl) {
      this.loadNormalMap(config.normalMapUrl, config.normalMapStrength ?? 1.5);
    }

    // Set ellipsoid to the body's actual radii (oblate spheroids matter here —
    // Mars at Jezero's 18.44°N has a 2.24 km smaller radius than at the equator,
    // and treating it as a sphere puts terrain that much too high at that
    // latitude vs the trajectory's latitude-aware position).
    // referenceRadiusOffsetKm compensates for tilesets that encode heights against
    // a non-standard reference (see TerrainConfig.referenceRadiusOffsetKm doc).
    const offsetKm = config.referenceRadiusOffsetKm ?? 0;
    this.tiles.ellipsoid.radius.set(
      (rxKm - offsetKm) * 1000,
      (ryKm - offsetKm) * 1000,
      (rzKm - offsetKm) * 1000,
    );

    // Only override errorTarget if explicitly set in config.
    // QuantizedMeshPlugin's useRecommendedSettings already sets errorTarget=2.
    if (config.errorTarget != null) {
      this.tiles.errorTarget = config.errorTarget;
    } else if (this.isImageryOnly) {
      // Imagery-only: match the quantized-mesh default. Going lower (e.g. 1)
      // causes more zoom-level mixing, which shows as color seams in composite
      // imagery sources where adjacent zoom levels have different color grading.
      this.tiles.errorTarget = 2;
    }
    this.tiles.lruCache.maxBytesSize = config.maxCacheBytes ?? 512 * 1024 * 1024;
    this.tiles.downloadQueue.maxJobs = 12;
    this.tiles.parseQueue.maxJobs = 6;

    // Upstream bug: ThreeJS TilesRenderer.disposeTile crashes when
    // engineData.geometry/materials/textures are null (tile was partially loaded
    // or already disposed). Guard by ensuring arrays exist before the original runs.
    const origDisposeTile = (this.tiles as any).disposeTile.bind(this.tiles);
    (this.tiles as any).disposeTile = (tile: any) => {
      const ed = tile?.engineData;
      if (ed?.scene) {
        if (!ed.geometry) ed.geometry = [];
        if (!ed.materials) ed.materials = [];
        if (!ed.textures) ed.textures = [];
      }
      return origDisposeTile(tile);
    };

    // Upstream bugs cause crashes inside dispose callbacks during LRU cache eviction.
    // The cache's unloadUnusedContent uses forEach to splice+dispose items. If any
    // dispose callback throws, the forEach aborts — orphaning remaining items and
    // stalling all future tile loading. Proxy the callbacks Map so every dispose
    // callback returned by .get() is individually wrapped in try-catch.
    const cache = this.tiles.lruCache as any;
    const origCallbacks = cache.callbacks;
    const noopCb = () => {};
    cache.callbacks = new Proxy(origCallbacks, {
      get(target: Map<any, (tile: unknown) => unknown>, prop: string | symbol, receiver: any) {
        if (prop === 'get') {
          return (key: any) => {
            const cb = target.get(key);
            if (typeof cb !== 'function') return noopCb;
            return (tile: any) => {
              try { return cb(tile); } catch (e) {
                console.warn('[Cosmolabe] Error in tile dispose, caught to prevent stall:', (e as Error).message);
              }
            };
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    // The tiles.group contains tile meshes in meters, Z-up (3D Tiles convention).
    // We need to transform to cosmolabe's coordinate system: km, Y-up.
    // Wrap in a parent group that applies the conversion.
    this.group = new THREE.Group();
    this.group.name = 'terrain';

    // Scale: meters → km
    const mToKm = 0.001;
    this.tiles.group.scale.setScalar(mToKm);

    // Rotate: Z-up → Y-up (rotate -90° around X)
    this.tiles.group.rotation.x = -Math.PI / 2;

    this.group.add(this.tiles.group);
    this.group.add(this.contourLabels.group);
  }

  /**
   * Call once per frame to update tile LOD based on camera position.
   * @param camera Scene camera
   * @param renderer WebGL renderer
   * @param bodyWorldPos World-space position of the body center (for coverage camera)
   */
  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer, bodyWorldPos?: THREE.Vector3, labelObstacles: readonly ScreenRect[] = []): void {
    if (this.disposed) return;

    // Compute terrain-appropriate near/far from camera position.
    // The scene camera can have extreme near/far ratios (e.g. 1e-12 / 1e6)
    // which make projection matrix rows 3 and 4 nearly identical. When
    // 3d-tiles-renderer extracts frustum planes via SAT, the far plane
    // (row4 - row3) collapses to zero → NaN after normalization → the root
    // tile's bounding volume fails the frustum test → 0 tiles rendered.
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    const distToBody = bodyWorldPos ? _camPos.distanceTo(bodyWorldPos) : 0;

    // Near the surface, distToBody ≈ bodyRadius so distToBody*0.001 clips terrain
    // for km around the camera (e.g., 3.4 km near clip at Mars surface).
    // Switch to altitude-based near/far when close to the surface.
    const sf = this.group.scale.x || 1e-6;
    const bodyRadiusSU = this.bodyRadiusKm * sf;
    const altAboveRefSphere = distToBody - bodyRadiusSU;
    let terrainNear: number;
    let terrainFar: number;
    if (Math.abs(altAboveRefSphere) < bodyRadiusSU * 0.01) {
      // Near surface: tight near/far for ground-level viewing.
      // 1m near, 50km far → ratio 5e4, within Float64 precision for SAT.
      terrainNear = Math.max(1e-10, 0.001 * sf);
      terrainFar = Math.max(50 * sf, 1e-4);
    } else {
      // Orbital: near = 0.1% of body distance, far = 100×. Ratio ≤ 1e5.
      terrainNear = Math.max(1e-8, distToBody * 0.001);
      terrainFar = Math.max(distToBody * 100, 1e-2);
    }

    // Terrain camera: mirrors main camera but with terrain-appropriate near/far.
    const mainCam = camera as THREE.PerspectiveCamera;
    if (!this.terrainCam) {
      this.terrainCam = new THREE.PerspectiveCamera(mainCam.fov, mainCam.aspect, terrainNear, terrainFar);
    }
    const tc = this.terrainCam;
    // Use a wider FOV than the main camera so terrain tiles load beyond the
    // view edges. At close range (near surface), camera rotation can quickly
    // expose new terrain; pre-loading with a wider frustum prevents gaps.
    tc.fov = Math.min(mainCam.fov * 1.5, 120);
    tc.aspect = mainCam.aspect;
    tc.near = terrainNear;
    tc.far = terrainFar;
    tc.updateProjectionMatrix();
    tc.position.copy(_camPos);
    tc.quaternion.copy(mainCam.quaternion);
    tc.updateMatrixWorld();

    this.tiles.setCamera(tc);
    this.tiles.setResolutionFromRenderer(tc, renderer);

    // The main camera's own view in tile space, for overlayView and the draw cull:
    // the streaming cameras above see wider than the screen. Neither near nor far
    // plane (three.js planes 5 and 4): the main camera's own reach far beyond both.
    const group = this.tiles.group;
    group.updateMatrixWorld();
    const mv = this.mainView ??= { frustum: new THREE.Frustum(), eye: new THREE.Vector3() };
    const top = terrainNear * Math.tan(THREE.MathUtils.DEG2RAD * 0.5 * mainCam.fov);
    _viewMat.makePerspective(-top * mainCam.aspect, top * mainCam.aspect, top, -top, terrainNear, terrainFar)
      .multiply(tc.matrixWorldInverse).multiply(group.matrixWorld);
    mv.frustum.setFromProjectionMatrix(_viewMat);
    mv.frustum.planes[4].constant = Infinity;
    mv.frustum.planes[5].constant = Infinity;
    mv.eye.copy(_camPos).applyMatrix4(_viewMat.copy(group.matrixWorld).invert());

    // Coverage cameras: ensure tiles load for the full visible hemisphere.
    // At close range (near surface), the terrain camera only sees ±45° from
    // the view direction, missing terrain at the sides and horizon. Two cameras
    // looking toward body center fill this gap:
    //   1. Coverage camera: 178° FOV → hemisphere-wide tile loading (coarse LOD)
    //   2. Nadir camera: 90° FOV → high-LOD tiles directly under the camera
    //
    // The 178° coverage camera uses tan(89°)≈57 in its screen-space error formula,
    // making every tile appear 57× smaller than it really is — only coarse tiles
    // get loaded. A separate 90° nadir camera (tan(45°)=1) correctly drives
    // high-resolution loading for terrain immediately underfoot.
    if (bodyWorldPos) {
      // Coverage/nadir cameras: at the surface, use the same near/far as the terrain
      // camera so the ratio stays within SAT precision limits (~1e5). The standard
      // formula (near=terrainNear*0.001, far=distToBody*2) produces ratios of ~7e7
      // at ground level (distToBody ≈ bodyRadius), causing NaN in frustum plane
      // extraction and zero tiles loaded → visible gaps in terrain.
      const isSurface = Math.abs(altAboveRefSphere) < bodyRadiusSU * 0.01;
      const camNear = isSurface ? terrainNear : Math.max(1e-10, terrainNear * 0.001);
      const camFar = isSurface ? terrainFar : Math.max(distToBody * 2, terrainFar);

      if (!this.coverageCam) {
        this.coverageCam = new THREE.PerspectiveCamera(178, 1, camNear, camFar);
      }
      const cc = this.coverageCam;
      cc.near = camNear;
      cc.far = camFar;
      cc.updateProjectionMatrix();
      cc.position.copy(_camPos);
      cc.up.copy(camera.up);
      cc.lookAt(bodyWorldPos);
      cc.updateMatrixWorld();
      this.tiles.setCamera(cc);
      this.tiles.setResolutionFromRenderer(cc, renderer);

      // Nadir camera: 90° FOV pointing at body center drives high-LOD loading
      // for tiles directly under the camera. Only activate when the camera is
      // close to the surface (altitude < 2× body radius in scene units) to avoid
      // the extra tiles.update() traversal pass at orbital distances where the
      // terrain camera already provides sufficient LOD.
      const bodyRadiusSceneUnits = this.tiles.ellipsoid.radius.x * 0.001; // m→km, matches scene scale
      const altitudeSceneUnits = distToBody - bodyRadiusSceneUnits;
      if (altitudeSceneUnits < bodyRadiusSceneUnits * 2) {
        if (!this.nadirCam) {
          this.nadirCam = new THREE.PerspectiveCamera(90, 1, camNear, camFar);
        }
        const nc = this.nadirCam;
        nc.near = camNear;
        nc.far = camFar;
        nc.updateProjectionMatrix();
        nc.position.copy(_camPos);
        nc.up.copy(camera.up);
        nc.lookAt(bodyWorldPos);
        nc.updateMatrixWorld();
        this.tiles.setCamera(nc);
        this.tiles.setResolutionFromRenderer(nc, renderer);
      } else if (this.nadirCam) {
        this.tiles.deleteCamera(this.nadirCam);
        this.nadirCam = null;
      }
    }

    if (!this._pluginReady) return;
    const updateStart = performance.now();
    // The renderer and TilesFadePlugin see every scene as they left it.
    this.showCulledTiles();
    try {
      this.tiles.update();
      this.updateTiming.add(performance.now() - updateStart);
    } catch (e) {
      console.error('[Cosmolabe] tiles.update() crashed:', e);
    }
    if (this.drawCulling) this.cullToMainView();
    this.surfaceStyle?.update();
    if (this.cubeImagery) {
      // Distance and frustum from the terrain camera (sane near/far, a wider
      // field so imagery just outside the view is ready); texel size against
      // the main camera's pixels.
      this.tiles.group.updateWorldMatrix(true, false);
      const pixelAngle = 2 * Math.tan(THREE.MathUtils.degToRad(mainCam.fov) / 2) / Math.max(1, renderer.getDrawingBufferSize(_bufferSize).y);
      const useImagery = this.debugMode === 'none' || !!IMAGERY_DEBUG[this.debugMode];
      try {
        this.cubeImagery.update(tc, this.tiles.group.matrixWorld, pixelAngle, renderer, useImagery);
      } catch (err) {
        // Imagery must never stop terrain streaming or the frame loop.
        this.warnOnce('cube-imagery-update', 'Terrain: cube imagery update failed', err);
      }
    }
    if (this.surfaceStyle) {
      const size = renderer.getSize(_bufferSize);
      const settings = this.surfaceStyle.current;
      const sources = settings.contours ? this.surfaceStyle.contourSources() : [];
      this.surfaceStyle.updateContourInterval(camera, size.x, size.y, sources);
      this.contourLabels.update(camera, size.x, size.y,
        settings.contourLabels ? sources : [], { ...settings, contourIntervalKm: this.surfaceStyle.contourIntervalKm },
        this.debugMode === 'none', labelObstacles);
    }
  }

  /** Hide this frame's visible tiles that the main camera cannot see (see `TerrainConfig.drawCulling`). */
  private cullToMainView(): void {
    const mv = this.mainView;
    if (!mv) return;
    const minRadius = this.horizonRadius();
    const visibleTiles = (this.tiles as unknown as { visibleTiles: Set<{ engineData?: { scene?: THREE.Object3D | null; boundingVolume?: TileVolume } }> }).visibleTiles;
    for (const tile of visibleTiles) {
      const { scene, boundingVolume } = tile.engineData ?? {};
      if (!scene?.visible || !boundingVolume || tileInMainView(boundingVolume, mv.frustum, mv.eye, minRadius)) continue;
      scene.visible = false;
      this.culledScenes.push(scene);
    }
  }

  /**
   * Draw every selected tile again until the next update. Call before rendering
   * the scene with a camera other than the main one (the instrument view): the
   * cull is the main camera's.
   */
  showCulledTiles(): void {
    for (const scene of this.culledScenes) scene.visible = true;
    this.culledScenes.length = 0;
  }

  /** Turn the main-view draw cull on or off (`TerrainConfig.drawCulling`); takes effect from the next update. */
  setDrawCulling(enabled: boolean): void {
    this.drawCulling = enabled;
    if (!enabled) this.showCulledTiles();
  }

  /**
   * Radius, tile-set metres, of a sphere below every rendered triangle, for
   * conservative horizon tests: the cube product's validated lower bound
   * (`CubeGridSurface.renderedInnerRadiusKm`) once its CPU-grid manifest has
   * loaded. Otherwise 0: a point occludes nothing, so the tests fall back to
   * the frustum alone.
   */
  private horizonRadius(): number {
    return this.cube ? this.cube.surface.renderedInnerRadiusKm * 1000 : 0;
  }

  /** Show or hide cube-sphere skirts on every loaded and future tile; imagery blocks rebuild to match. */
  setCubeSkirts(visible: boolean): void {
    if (visible === this.cubeSkirts) return;
    this.cubeSkirts = visible;
    this.tiles.forEachLoadedModel((scene: THREE.Object3D) => this.applyCubeSkirts(scene));
    this.cubeImagery?.invalidateBlocks();
  }

  private applyCubeSkirts(scene: THREE.Object3D): void {
    scene.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      const n = g?.userData?.surfaceTriangles;
      if (typeof n === 'number') g.setDrawRange(0, this.cubeSkirts ? Infinity : 3 * n);
    });
  }

  /** The experimental cube imagery layer, for diagnostics and live option changes; null when not configured. */
  get cubeImageryLayer(): CubeImageryLayer | null {
    return this.cubeImagery;
  }

  /** Cube imagery residency, requests and blocks, or null when the terrain has no cube imagery. */
  get cubeImageryStats(): CubeImageryStats | null {
    return this.cubeImagery?.stats ?? null;
  }

  /** CPU terrain query. Null means decoded data is not currently cached. */
  sample(latDeg: number, lonDeg: number, deriveNormal = false): TerrainSample | null {
    // Cube grids carry no derived normals; `normal` stays absent rather than invented.
    if (this.cubeConfigured) return this.cube?.source.sample(latDeg, lonDeg) ?? null;
    return this.sampler.sample(latDeg, lonDeg, deriveNormal);
  }

  sampleBodyFixed(point: BodyFixedCartesian, deriveNormal = false): TerrainSample | null {
    if (this.cubeConfigured) {
      const { latDeg, lonDeg } = bodyFixedToGeodetic(point, this.sampler.datum);
      return this.sample(latDeg, lonDeg, deriveNormal);
    }
    return this.sampler.sampleBodyFixedCartesian(point, deriveNormal);
  }

  /** CPU cache state of whichever CPU source answers `sample` (cube grids when configured). */
  get cpuDiagnostics(): TerrainSamplerDiagnostics {
    if (!this.cubeConfigured) return this.sampler.diagnostics;
    const tiles = this.cube?.source.sampler.tileCount ?? 0;
    return { tileCount: tiles, sampleCount: 0, lastSampleMicros: 0, meanSampleMicros: 0, state: tiles ? 'ready' : 'unloaded' };
  }

  /** Source identity of whichever CPU source answers `sample`. */
  get cpuSource(): TerrainSourceMetadata {
    return this.cube?.source.manifest.source ?? this.sampler.source;
  }

  /** Explicit CPU coverage at a point: finest, coarse parent fallback, or unloaded. Null without cube grids. */
  cubeCoverage(latDeg: number, lonDeg: number): CubeCoverage | null {
    if (!this.cubeConfigured) return null;
    return this.cube?.source.coverage(latDeg, lonDeg)
      ?? { state: 'unloaded', availableLevel: 0, residentLevel: null, residentTileId: null };
  }

  /** Cube CPU grid residency and request counters, or null without cube grids. */
  get cubeStats(): (CubeGridSourceStats & { version: string | null }) | null {
    if (!this.cubeConfigured) return null;
    const stats = this.cube?.source.stats ?? { residentTiles: 0, detailTiles: 0, requests: 0, bytes: 0, failed: 0, inFlight: 0 };
    return { ...stats, version: this.cube?.source.manifest.source.version ?? null };
  }

  /**
   * #148 Cartesian ray query (body-fixed km, Z-up) against resident CPU terrain.
   * Only cube grids implement it here; the result is provisional (`coarse`)
   * because their coverage is partial. It also starts the surface's own
   * ensure-coverage pass along the ray, so a repeated query finds finer triangles;
   * `requestSurfaceIntersection` awaits that pass instead.
   */
  intersectSurfaceRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection | null {
    if (!this.cube) return null;
    const result = this.cube.surface.intersectRay(ray, options);
    this.cube.surface.ensureRayCoverage(ray, options, new AbortController().signal)
      .catch((err) => this.warnOnce('cube-ray', 'Terrain: cube grid ray coverage failed', err));
    return result;
  }

  private loadCubeGrids(config: NonNullable<TerrainConfig['cubeSphere']>, datum: TerrainDatum): void {
    CubeSphereGridSource.fromUrl(config.cpuGrids, { ...config, signal: this.cubeGridsAbort.signal }).then((source) => {
      if (this.disposed) return;
      // The grids carry their own datum; refuse any that disagrees with the body's.
      const a = source.manifest.datum.referenceShape, b = datum.referenceShape;
      const radii = (shape: TerrainDatum['referenceShape']) => shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : [...shape.radiiKm];
      if (source.manifest.datum.verticalDatum !== datum.verticalDatum || source.manifest.datum.heightConvention !== datum.heightConvention ||
        a.kind !== b.kind || radii(a).some((r, i) => Math.abs(r - radii(b)[i]) > 1e-9)) {
        throw new Error(`cube grid datum ${JSON.stringify(source.manifest.datum.referenceShape)} does not match the body ${JSON.stringify(datum.referenceShape)}`);
      }
      const surface = new CubeGridSurface(source, 'body', 'body-fixed');
      source.onChange = (id) => surface.invalidate(id);
      this.cube = { source, surface };
      // Geometry and grids must be one product revision (the builder writes the grids'
      // source version as the tileset's asset.tilesetVersion). Checked once the tileset
      // arrives, so CPU queries never wait on rendering; a mismatch drops the grids.
      this.onRootTileset((tileset) => {
        const version = (tileset as { asset?: { tilesetVersion?: string } }).asset?.tilesetVersion;
        if (this.cube?.source !== source) return;
        // Only the known builder's Z-north, body-fixed metre product is eligible.
        // Config alone is insufficient: arbitrary 3D Tiles stay unsupported.
        const asset = (tileset as { asset?: { generator?: string } }).asset;
        if (this.cubeStyleCandidate && version && version === source.manifest.source.version &&
          /^scripts\/terrain\/dem\.py cube-(tile|error)(?: |$)/.test(asset?.generator ?? '') &&
          datum.referenceShape.kind === 'sphere' && datum.verticalDatum === 'reference-sphere' && datum.heightConvention === 'radial' &&
          source.manifest.grid.encoding === 'float32 little-endian, metres above the reference sphere') {
          this.cubeStyleHeightRange = source.manifest.heightRangeKm;
          this.surfaceStyle = new SurfaceAppearance(datum);
          if (this.cubeImagery) { this.cubeImagery.invalidateBlocks(); this.cubeImagery.surfaceAppearance = this.surfaceStyle; }
          for (const scene of this.cubeScenes) this.attachSurfaceStyle(scene);
        }
        if (version === undefined || version === source.manifest.source.version) return;
        this.cube = null;
        source.dispose();
        this.warnOnce('cube-grids', `Terrain: cube-sphere CPU grids unavailable (${config.cpuGrids})`,
          new Error(`grid revision ${source.manifest.source.version} does not match the tileset's ${version}`));
      });
      return source.ready;
    }).catch((err) => this.warnOnce('cube-grids', `Terrain: cube-sphere CPU grids unavailable (${config.cpuGrids})`, err));
  }

  /** Call `fn` with the root tileset JSON now if it has loaded, else once it does. */
  private onRootTileset(fn: (tileset: object) => void): void {
    const tiles = this.tiles as unknown as { rootTileset: object | null } & THREE.EventDispatcher<{ 'load-root-tileset': object }>;
    if (tiles.rootTileset) { fn(tiles.rootTileset); return; }
    const listener = () => { tiles.removeEventListener('load-root-tileset', listener); if (tiles.rootTileset) fn(tiles.rootTileset); };
    tiles.addEventListener('load-root-tileset', listener);
  }

  bodyFixedToGeodetic(point: BodyFixedCartesian): BodyFixedPosition {
    return bodyFixedToGeodetic(point, this.sampler.datum);
  }

  // ---------------------------------------------------------------------------
  // Imagery layers (#123)
  // ---------------------------------------------------------------------------

  /** The imagery stack, bottom → top, with each layer's current load health. */
  get imageryLayers(): ImageryLayerInfo[] {
    if (this.cubeImagery && this.layers.length) return this.cubeImagery.imageryLayers;
    return this.layers.map((l) => ({
      ...l,
      bounds: l.bounds ? [...l.bounds] as [number, number, number, number] : null,
      status: layerStatus(l.requests, l.failedTiles, this.setupFailed.has(l.id)),
      view: this.overlayView(l),
    }));
  }

  /** What overlay `layer` adds to the tiles in view, or null while it is not drawn. */
  private overlayView(layer: ImageryLayerInfo): ImageryLayerView | null {
    type Overlay = { calculateLevel(range: number[]): number; tiling: OverlayTiling };
    const overlay = this.activeOverlays.get(layer.id) as unknown as Overlay | undefined;
    const info = (this.overlayPlugin as unknown as { overlayInfo?: Map<unknown, { tileInfo: Map<unknown, { range: number[] | null; failed: boolean }> }> } | null)
      ?.overlayInfo?.get(overlay);
    const visibleTiles = (this.tiles as unknown as { visibleTiles: Set<unknown> }).visibleTiles;
    // Nothing drawn yet, so nothing to judge.
    if (!overlay?.tiling || !info || visibleTiles.size === 0) return null;
    const { tiling } = overlay;
    const degraded = this.degradedTiles.get(layer.id);
    const degradedInView = new Set<string>();
    const cacheFull = (this.tiles.lruCache as unknown as { isFull(): boolean }).isFull();
    const view: ImageryLayerView = { inCoverage: false, zoomLevel: null, missingTiles: 0, degradedTiles: 0, cacheFull };
    for (const tile of visibleTiles) {
      const bv = (tile as { engineData?: { boundingVolume?: TileVolume } }).engineData?.boundingVolume;
      if (this.mainView && bv && !tileInMainView(bv, this.mainView.frustum, this.mainView.eye, this.horizonRadius())) continue;
      const t = info.tileInfo.get(tile);
      if (!t?.range) continue;
      if (layer.bounds && !overlapsBounds(tiling.toCartographicRange(t.range), layer.bounds)) continue;
      view.inCoverage = true;
      const level = overlay.calculateLevel(t.range);
      view.zoomLevel = Math.max(view.zoomLevel ?? 0, level);
      if (t.failed) view.missingTiles++;
      if (!degraded?.size) continue;
      // The source tiles this terrain tile is composed from, as the plugin picks them.
      const [minX, minY, maxX, maxY] = t.range;
      const l = Math.max(Math.min(level, tiling.maxLevel), tiling.minLevel);
      const [x0, y0, x1, y1] = tiling.getTilesInRange(minX + 1e-8, minY + 1e-8, maxX - 1e-8, maxY - 1e-8, l, true);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) if (degraded.has(`${l}/${x}/${y}`)) degradedInView.add(`${l}/${x}/${y}`);
      }
    }
    view.degradedTiles = degradedInView.size;
    return view;
  }

  /**
   * Switch an optional layer on or off. Off removes its overlay from the
   * compositor, which aborts its pending fetches and releases its textures, so
   * a hidden layer costs no requests. Returns false when nothing changed (the
   * base layer, an unknown id, or the same state).
   */
  setImageryLayerVisible(id: string, visible: boolean): boolean {
    if (this.cubeImagery) return this.cubeImagery.setLayerVisible(id, visible);
    const layer = this.layer(id);
    if (!layer || !layer.optional || !this.overlayPlugin || layer.visible === visible) return false;
    layer.visible = visible;
    if (visible) {
      layer.requests = 0;
      layer.failedTiles = 0;
      void this.prepareOverlay(id).then((p) => this.attachOverlay(p));
    } else {
      this.overlayGeneration.set(id, (this.overlayGeneration.get(id) ?? 0) + 1);
      this.setupFailed.delete(id);
      this.detachOverlay(id);
    }
    return true;
  }

  /**
   * Layer opacity, 0..1. Read by the overlay shader every frame, so no tile is
   * recomposited. The imagery-only base is tile geometry, not an overlay, and
   * has no opacity.
   */
  setImageryLayerOpacity(id: string, opacity: number): boolean {
    if (this.cubeImagery) return this.cubeImagery.setLayerOpacity(id, opacity);
    const layer = this.layer(id);
    if (!layer || (layer.role === 'base' && this.isImageryOnly)) return false;
    layer.opacity = clampOpacity(opacity);
    const overlay = this.activeOverlays.get(id);
    if (overlay) (overlay as unknown as OverlayInternals).opacity = layer.opacity;
    return true;
  }

  /**
   * Move an overlay to `toIndex` in the bottom → top stack. The base stays at
   * the bottom. Reordering only re-binds per-tile layer textures; nothing is
   * fetched again.
   */
  moveImageryLayer(id: string, toIndex: number): boolean {
    if (this.cubeImagery) return this.cubeImagery.moveLayer(id, toIndex);
    const next = reorderedLayers(this.layers, this.layers.findIndex((l) => l.id === id), toIndex);
    if (!next) return false;
    this.layers.splice(0, this.layers.length, ...next);
    this.layers.forEach((l, i) => {
      const overlay = this.activeOverlays.get(l.id);
      if (overlay) this.overlayPlugin?.setOverlayOrder(overlay, i);
    });
    return true;
  }

  /** Per-terrain-tile composite resolution, in pixels. */
  get overlayResolution(): number { return this._overlayResolution; }

  /**
   * Change the composite resolution at runtime, for side-by-side measurement
   * (see docs/catalog-format.md, `overlayResolution`). The plugin applies a
   * resolution when an overlay is added, so every active overlay is rebuilt.
   */
  setOverlayResolution(px: number): void {
    if (!this.overlayPlugin || !(px > 0) || px === this._overlayResolution) return;
    this._overlayResolution = px;
    (this.overlayPlugin as unknown as { resolution: number }).resolution = px;
    for (const id of [...this.activeOverlays.keys()]) {
      this.detachOverlay(id);
      void this.prepareOverlay(id).then((p) => this.attachOverlay(p));
    }
  }

  /** Overlay fetches since start, across all layers. */
  get imageryRequests(): number {
    if (this.cubeImagery) return this.cubeImagery.stats.requests;
    let n = 0;
    for (const l of this.layers) if (l.role === 'overlay' || !this.isImageryOnly) n += l.requests;
    return n;
  }

  /**
   * The stream cannot supply a surface: the imagery-only base could not be set
   * up, the root tileset failed, or tiles failed with none loaded and nothing
   * left in flight for `STREAM_STALL_MS`. The body keeps its static map.
   * Overlay failures never count here — the layers beneath them still render.
   */
  hasStreamFailed(now = performance.now()): boolean {
    if (this.isImageryOnly && this.layers[0] && this.setupFailed.has(this.layers[0].id)) return true;
    // A hole in the coarsest surface (one of two level-0 imagery tiles, say)
    // never fills: nothing else covers that part of the globe.
    if (this.coverageTiles().some((t) => t.internal?.loadingState === FAILED)) return true;
    if (this.loadedModels > 0 || this.geometryFailures === 0) return false;
    if (this.rootFailed || this.geometryFailures >= 4) return true;
    // A single early failure (one of the two level-0 imagery tiles, say) can
    // leave the traversal with nothing else to ask for; give the queue a
    // moment to pick up siblings before calling the stream dead.
    const stats = (this.tiles as unknown as { stats?: Record<string, number> }).stats ?? {};
    const pending = (stats.queued ?? 0) + (stats.downloading ?? 0) + (stats.parsing ?? 0);
    return pending === 0 && now - this.lastGeometryFailureAt >= STREAM_STALL_MS;
  }

  /**
   * Whether the streamed surface can replace the static map without a hole or
   * a flash of untextured tiles: every coverage tile in view has loaded, and
   * either the queue has drained or it has been busy for `SHOW_GRACE_MS` since
   * tiles appeared. Below the coverage tiles a parent stays drawn until all its
   * children are ready, so a loaded coverage set leaves no holes.
   * Call once per frame while the body is in the show zone; `resetShowWait`
   * when it leaves.
   */
  isReadyToShow(now = performance.now()): boolean {
    if (!this._pluginReady || this.hasStreamFailed(now)) return false;
    if (this.cubeImagery && (this.debugMode === 'none' || IMAGERY_DEBUG[this.debugMode])) {
      const imagery = this.cubeImagery.stats;
      if (!imagery.ready || !imagery.tiles || imagery.untexturedBlocks > 0 || imagery.baseUncoveredBlocks > 0) return false;
    }
    const stats = (this.tiles as unknown as { stats?: Record<string, number> }).stats ?? {};
    if (!((stats.visible ?? 0) > 0)) { this.firstVisibleAt = 0; return false; }
    if (this.coverageTiles().some((t) => t.traversal?.inFrustum !== false && t.internal?.loadingState !== LOADED)) return false;
    if (!this.firstVisibleAt) this.firstVisibleAt = now;
    const pending = (stats.queued ?? 0) + (stats.downloading ?? 0) + (stats.parsing ?? 0);
    return pending === 0 || now - this.firstVisibleAt >= SHOW_GRACE_MS;
  }

  resetShowWait(): void { this.firstVisibleAt = 0; }

  /**
   * The shallowest tiles with content, which the surface is built from before
   * any refinement: the level-0 tiles of an imagery-only globe or a quantized
   * mesh, or a 3D Tiles root. A tile the traversal has not reached yet counts
   * too, as not loaded.
   */
  private coverageTiles(): CoverageTile[] {
    const out: CoverageTile[] = [];
    const walk = (t: CoverageTile) => {
      if (!t.internal || t.internal.hasContent) out.push(t);
      else t.children.forEach(walk);
    };
    const root = (this.tiles as unknown as { root: CoverageTile | null }).root;
    if (root) walk(root);
    return out;
  }

  private layer(id: string): ImageryLayerInfo | undefined {
    return this.layers.find((l) => l.id === id);
  }

  private registerOverlayPlugin(renderer: THREE.WebGLRenderer, enableTileSplitting: boolean): void {
    this.overlayPlugin = new ImageOverlayPlugin({
      overlays: [],
      renderer,
      enableTileSplitting,
      resolution: this._overlayResolution,
    } as ConstructorParameters<typeof ImageOverlayPlugin>[0]);
    this.tiles.registerPlugin(this.overlayPlugin);
  }

  /** One capabilities fetch per URL, so layers sharing a GIBS endpoint share its tile grid. */
  private fetchCapabilities(url: string): Promise<WMTSCapabilitiesResult> {
    let p = this.capabilitiesCache.get(url);
    if (!p) {
      p = new WMTSCapabilitiesLoader().loadAsync(url) as Promise<WMTSCapabilitiesResult>;
      this.capabilitiesCache.set(url, p);
    }
    return p;
  }

  /**
   * Build and initialize a fresh overlay for a layer. A fresh one every time:
   * the plugin wraps an overlay's `fetch` when it is added, so re-adding a
   * removed overlay would queue every request twice. Never rejects; a layer
   * that cannot be set up is marked failed and the rest of the stack carries on.
   */
  private async prepareOverlay(id: string): Promise<PreparedOverlay | null> {
    const generation = (this.overlayGeneration.get(id) ?? 0) + 1;
    this.overlayGeneration.set(id, generation);
    const cfg = this.layerConfigs.get(id)!;
    const layer = this.layer(id)!;
    try {
      let overlay: ImageryOverlay;
      if (cfg.type === 'wmts-capabilities') {
        const capabilities = await this.fetchCapabilities(cfg.url);
        const preprocessURL = buildWmtsOverlayPreprocessURL(resolveTime(cfg.time));
        overlay = new WMTSTilesOverlay({
          capabilities,
          layer: cfg.layer,
          tileMatrixSet: cfg.tileMatrixSet,
          color: cfg.color ?? 0xffffff,
          opacity: layer.opacity,
          ...(preprocessURL ? { preprocessURL } : {}),
        } as unknown as ConstructorParameters<typeof WMTSTilesOverlay>[0]);
        if (cfg.minZoom != null) clampOverlayMinLevel(overlay, cfg.minZoom);
      } else {
        overlay = createImageryOverlay(cfg);
      }
      const o = overlay as unknown as OverlayInternals;
      o.opacity = layer.opacity;
      const inner = o.preprocessURL;
      o.preprocessURL = (url: string) => {
        // The plugin queues overlay fetches on the shared download queue, and
        // removing an overlay does not drain them. Fetches a switched-off
        // layer still has queued resolve to an empty tile instead of going out.
        if (this.activeOverlays.get(id) !== overlay) return SKIP_TILE_DATA_URL;
        const out = inner ? inner(url) : url;
        // Count real requests, not the skip tiles outside a layer's coverage.
        if (out !== SKIP_TILE_DATA_URL) layer.requests++;
        return out;
      };
      // ponytail: XYZ only, where tile y counts from the north; TMS/WMTS/WMS keep upstream's all-or-nothing.
      const source = (overlay as unknown as { imageSource?: TileFetcher }).imageSource;
      if ((cfg.type ?? 'xyz') === 'xyz' && source) {
        // A fresh set per overlay: a rebuilt layer refetches everything, and a
        // source tile that loads on retry is no longer degraded.
        const degraded = new Set<string>();
        this.degradedTiles.set(id, degraded);
        fallBackToParentTiles(source, ([x, y, level], fromParent) => {
          if (fromParent) {
            layer.failedTiles++;
            degraded.add(`${level}/${x}/${y}`);
          } else {
            degraded.delete(`${level}/${x}/${y}`);
          }
        });
      }
      await o.init();
      this.setupFailed.delete(id);
      return { id, overlay, generation };
    } catch (err) {
      if (this.overlayGeneration.get(id) === generation) this.setupFailed.add(id);
      this.warnOnce(`imagery-setup:${id}`, `[Cosmolabe:Imagery] Layer "${layer.name}" could not be set up; the layers beneath it stay visible.`, err);
      return null;
    }
  }

  private attachOverlay(prepared: PreparedOverlay | null): void {
    if (!prepared || this.disposed || !this.overlayPlugin) return;
    const { id, overlay, generation } = prepared;
    const layer = this.layer(id);
    if (!layer?.visible || this.overlayGeneration.get(id) !== generation || this.activeOverlays.has(id)) return;
    if (this.activeOverlays.size >= 10) {
      // ImageOverlayPlugin's shader composites at most ten layers.
      this.warnOnce('imagery-layer-limit', `[Cosmolabe:Imagery] At most 10 imagery layers can be shown at once; "${layer.name}" stays off.`);
      layer.visible = false;
      return;
    }
    this.activeOverlays.set(id, overlay);
    this.overlayLayerIds.set(overlay, id);
    this.overlayPlugin.addOverlay(overlay, this.layers.indexOf(layer));
  }

  private detachOverlay(id: string): void {
    const overlay = this.activeOverlays.get(id);
    if (!overlay) return;
    this.activeOverlays.delete(id);
    this.overlayPlugin?.deleteOverlay(overlay);
  }

  /**
   * Decode a quantized-mesh tile into the CPU sampler before the renderer turns
   * it into geometry. The tile is kept as the TIN it actually is — its vertices
   * are scattered, not a U×V raster, so it cannot be flattened to a height grid.
   *
   * Only `terrain` payloads are captured. Tiles the plugin synthesizes by
   * splitting a parent (`quantized_tile_split`) carry no quantized-mesh buffer
   * of their own; the parent they were cut from already provides CPU coverage
   * for the same ground, at one level coarser.
   */
  private captureDecodedQuantizedMesh(buffer: ArrayBuffer, tile: any, uri: string): void {
    if (this.isImageryOnly) return;
    const id = this.cpuTileId(tile);
    if (!id) return;
    const region = tile?.boundingVolume?.region;
    if (!region) return;
    const decodeStart = performance.now();
    let parsed;
    try {
      parsed = decodeQuantizedMesh(buffer);
    } catch (err) {
      // A tile we cannot decode must be loud: silently skipping it strands the
      // sampler with no coverage and every consumer falls back to the datum.
      this.warnOnce('qm-decode', `Terrain: failed to decode quantized-mesh tile ${uri}`, err);
      return;
    }
    const [westRad, southRad, eastRad, northRad] = region;
    // Heights decode against the tileset's own reference surface. The renderer
    // compensates for a non-standard one by shrinking the decode ellipsoid
    // (see TerrainConfig.referenceRadiusOffsetKm), so the same correction has to
    // be applied here or CPU samples sit `offset` km above the rendered surface.
    try {
      this.sampler.addTile(toTerrainMeshTile(parsed, {
        id,
        westDeg: westRad * 180 / Math.PI,
        eastDeg: eastRad * 180 / Math.PI,
        southDeg: southRad * 180 / Math.PI,
        northDeg: northRad * 180 / Math.PI,
        source: this.sampler.source,
      }, this.terrainHeightOffsetKm));
      this.decodeTiming.add(performance.now() - decodeStart);
      this.indexCpuTile(id);
    } catch (err) {
      this.warnOnce('qm-tile', `Terrain: rejected decoded tile ${uri}`, err);
    }
  }

  /** Record a captured tile's `z/x/y` and drop memoized debug values it may change. */
  private indexCpuTile(id: string): void {
    const key = parseTileKey(id);
    if (!key) return;
    this.cpuIdByKey.set(tileKeyId(key), id);
    this.cpuKeyById.set(id, key);
    this.invalidateDebugValues(id, key);
  }

  private forgetCpuTile(id: string): void {
    this.sampler.removeTile(id);
    this.dropCpuIndexes(id);
  }

  /** Forget a tile the sampler no longer holds, and every memoized debug value it fed. */
  private dropCpuIndexes(id: string): void {
    const key = this.cpuKeyById.get(id);
    this.cpuKeyById.delete(id);
    if (key && this.cpuIdByKey.get(tileKeyId(key)) === id) this.cpuIdByKey.delete(tileKeyId(key));
    this.invalidateDebugValues(id, key);
  }

  private invalidateDebugValues(id: string, key: TileKey | undefined): void {
    this.seamErrorKm.delete(id);
    this.meanElevationKm.delete(id);
    if (!key) return;
    for (const n of this.sameLevelNeighbours(key)) {
      const nid = this.cpuIdByKey.get(tileKeyId(n));
      if (nid) this.seamErrorKm.delete(nid);
    }
  }

  private sameLevelNeighbours(k: TileKey): TileKey[] {
    const nx = 2 ** (k.z + 1), ny = 2 ** k.z;
    const out: TileKey[] = [
      { z: k.z, x: (k.x + 1) % nx, y: k.y },
      { z: k.z, x: (k.x - 1 + nx) % nx, y: k.y },
    ];
    if (k.y + 1 < ny) out.push({ z: k.z, x: k.x, y: k.y + 1 });
    if (k.y > 0) out.push({ z: k.z, x: k.x, y: k.y - 1 });
    return out;
  }

  /** Rate-limited warning so a systematically broken tileset logs once, not per tile. */
  private readonly warnedKeys = new Set<string>();
  private warnOnce(key: string, message: string, err?: unknown): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    console.warn(message, err);
  }

  /**
   * Identity for a decoded CPU tile. Derived only from the tile object, never
   * from the URL handed to `parseToMesh` — the renderer resolves that against
   * the base path, so it is absolute while `content.uri` stays relative. Using
   * one on insert and the other on dispose leaks every tile.
   */
  private cpuTileId(tile: any): string | null {
    const value = tile?.content?.uri ?? tile?.__cacheKey ?? tile?.id;
    return value == null ? null : `decoded:${value}`;
  }

  /** Log tile renderer stats to console for debugging */
  logStats(): void {
    const t = this.tiles as any;
    const cache = t.lruCache as any;
    const queue = t.downloadQueue as any;

    console.table({
      visibleTiles: t.visibleTiles?.size ?? '?',
      activeTiles: t.activeTiles?.size ?? '?',
      errorTarget: t.errorTarget,
      cacheMB: `${((cache.cachedBytes ?? 0) / (1024 * 1024)).toFixed(1)} / ${(cache.maxBytesSize / (1024 * 1024)).toFixed(0)}`,
      downloading: queue.currJobs ?? '?',
      queued: queue.items?.length ?? '?',
      cpuTiles: this.sampler.diagnostics.tileCount,
      cpuSampleUs: this.sampler.diagnostics.lastSampleMicros.toFixed(1),
      cpuState: this.sampler.diagnostics.state,
    });

    // Active tile depth and error
    const depthCounts: Record<number, number> = {};
    let maxErr = 0, minErr = Infinity;
    t.activeTiles?.forEach((tile: any) => {
      const depth = tile.internal?.depth ?? -1;
      depthCounts[depth] = (depthCounts[depth] || 0) + 1;
      const err = tile.traversal?.error ?? 0;
      if (err > maxErr) maxErr = err;
      if (err < minErr) minErr = err;
    });
    console.log('[Cosmolabe] Active tiles by depth:', depthCounts,
      '| error range:', minErr.toFixed(2), '-', maxErr.toFixed(2));
  }

  /** Toggle debug tile bounds visualization. Lazily registers the plugin on first enable. */
  setDebug(show: boolean): void {
    this.showBounds = show;
    if (!show && !this.debugPlugin) return;
    const plugin = this.ensureDebugPlugin();
    plugin.displayBoxBounds = show;
    plugin.displayRegionBounds = show;
    this.releaseIdleDebugPlugin();
  }

  /** Current debug surface mode. */
  get debugSurfaceMode(): TerrainDebugMode { return this.debugMode; }

  /** Color tiles by a diagnostic quantity; `'none'` restores the real materials. See {@link TerrainDebugMode}. */
  setDebugMode(mode: TerrainDebugMode): void {
    if (!TERRAIN_DEBUG_MODES.includes(mode)) throw new Error(`Unknown terrain debug mode "${mode}"`);
    if (mode === this.debugMode) return;
    this.debugMode = mode;
    if (this.cubeImagery) this.cubeImagery.debug = IMAGERY_DEBUG[mode] ?? 'none';
    if ((mode === 'none' || IMAGERY_DEBUG[mode]) && !this.debugPlugin) return;
    const plugin = this.ensureDebugPlugin();
    // `ColorModes` exists at runtime but the upstream typings omit the static.
    const C = (DebugTilesPlugin as unknown as { ColorModes: Record<'NONE' | 'DEPTH' | 'GEOMETRIC_ERROR' | 'SCREEN_ERROR' | 'CUSTOM_COLOR', number> }).ColorModes;
    (plugin as unknown as { colorMode: number }).colorMode = mode === 'none' || IMAGERY_DEBUG[mode] ? C.NONE
      : mode === 'lod' ? C.DEPTH
      : mode === 'geometric-error' ? C.GEOMETRIC_ERROR
      : mode === 'screen-error' ? C.SCREEN_ERROR
      : C.CUSTOM_COLOR;
    // Unlit, so the night side and terminator don't hide the encoding.
    plugin.unlit = mode !== 'none' && !IMAGERY_DEBUG[mode];
    this.releaseIdleDebugPlugin();
  }

  /**
   * With no debug view and no bounds, drop the plugin entirely: registered, it
   * walks every visible tile each frame (~1 ms at 1000 tiles, measured on
   * MoonFall). Unregistering disposes it, which restores every material.
   */
  private releaseIdleDebugPlugin(): void {
    if (!this.debugPlugin || (this.debugMode !== 'none' && !IMAGERY_DEBUG[this.debugMode]) || this.showBounds) return;
    this.tiles.unregisterPlugin(this.debugPlugin);
    this.debugPlugin = null;
  }

  private ensureDebugPlugin(): DebugTilesPlugin {
    if (!this.debugPlugin) {
      this.debugPlugin = new DebugTilesPlugin({
        displayBoxBounds: false,
        displayRegionBounds: false,
        customColorCallback: (tile: any, object: THREE.Object3D) => {
          const material = (object as THREE.Mesh).material as THREE.MeshBasicMaterial;
          if (material?.color) this.debugColorFor(tile, material.color);
        },
      });
      this.tiles.registerPlugin(this.debugPlugin);
    }
    return this.debugPlugin;
  }

  /** The custom-mode color for one rendered tile. Runs per visible tile per frame, so values are memoized. */
  private debugColorFor(tile: any, target: THREE.Color): void {
    const ownId = this.cpuTileId(tile);
    const hasOwn = !!ownId && !!this.sampler.getTile(ownId);
    const cube = this.cubeConfigured ? cubeAddress(tile) : null;
    switch (this.debugMode) {
      case 'cpu-coverage':
        if (cube) {
          const sampler = this.cube?.source.sampler;
          let resident: 'own' | 'ancestor' | null = sampler?.getTile(cube) ? 'own' : null;
          for (let l = cube.level - 1; !resident && sampler && l >= 0; l--) {
            if (sampler.getTile({ face: cube.face, level: l, x: cube.x >> (cube.level - l), y: cube.y >> (cube.level - l) })) resident = 'ancestor';
          }
          target.set(resident === 'own' ? 0x2fbf71 : resident === 'ancestor' ? 0xf2a33a : 0x595959);
          return;
        }
        target.set(hasOwn ? 0x2fbf71 : 0xf2a33a);
        return;
      case 'cube-face':
        if (!cube) { target.setRGB(0.35, 0.35, 0.35); return; }
        target.setHSL(CUBE_FACE_HUE[cube.face], 0.75, 0.25 + 0.04 * Math.min(cube.level, 12) + ((cube.x + cube.y) % 2 ? 0.06 : 0));
        return;
      case 'datum-height': {
        // Synthesized split tiles answer CPU queries from an ancestor; color them the same way.
        let t = tile, id: string | null = null;
        while (t) {
          const tid = this.cpuTileId(t);
          if (tid && this.sampler.getTile(tid)) { id = tid; break; }
          t = t.parent;
        }
        const mean = id ? this.meanElevation(id) : null;
        if (mean == null) { target.setRGB(0.35, 0.35, 0.35); return; }
        let scale = 0.1;
        for (const v of this.meanElevationKm.values()) scale = Math.max(scale, Math.abs(v));
        const f = Math.max(-1, Math.min(1, mean / scale));
        target.setHSL(f < 0 ? 0.6 : 0.0, 0.8, 0.92 - 0.47 * Math.abs(f));
        return;
      }
      case 'seam-error': {
        const err = hasOwn ? this.tileSeamError(ownId!) : null;
        if (err == null) { target.setRGB(0.35, 0.35, 0.35); return; }
        const f = Math.max(0, Math.min(1, err / this.seamErrorScaleKm));
        target.copy(_debugColor.setHSL((1 - f) * 0.33, 0.85, 0.5));
        return;
      }
      default:
        target.setRGB(1, 1, 1);
    }
  }

  private meanElevation(id: string): number | null {
    const cached = this.meanElevationKm.get(id);
    if (cached != null) return cached;
    const tile = this.sampler.getTile(id);
    if (!tile || !tile.elevationsKm.length) return null;
    let sum = 0;
    for (let i = 0; i < tile.elevationsKm.length; i++) sum += tile.elevationsKm[i];
    const mean = sum / tile.elevationsKm.length;
    this.meanElevationKm.set(id, mean);
    return mean;
  }

  /** Largest shared-edge mismatch (km) between a cached tile and its cached same-level neighbours. */
  tileSeamError(id: string): number | null {
    if (this.seamErrorKm.has(id)) return this.seamErrorKm.get(id)!;
    const key = this.cpuKeyById.get(id);
    const tile = this.sampler.getTile(id);
    let worst: number | null = null;
    if (key && tile) {
      for (const n of this.sameLevelNeighbours(key)) {
        const nid = this.cpuIdByKey.get(tileKeyId(n));
        const neighbour = nid ? this.sampler.getTile(nid) : undefined;
        if (!neighbour) continue;
        const report = sharedEdgeReport(tile, neighbour, { samples: 33 });
        if (report && report.stats.count) worst = Math.max(worst ?? 0, report.stats.maxAbsKm);
      }
    }
    this.seamErrorKm.set(id, worst);
    return worst;
  }

  /** Terrain cost/load snapshot. See {@link TerrainPerformanceMetrics}. */
  get metrics(): TerrainPerformanceMetrics {
    const t = this.tiles as any;
    const stats = t.stats ?? {};
    const cache = t.lruCache ?? {};
    let geometryBytes = 0, textureBytes = 0;
    const seenGeometry = new Set<THREE.BufferGeometry>();
    // Keyed by Source, not Texture: per-tile clones of one map (applyNormalMap)
    // share a Source, and three.js uploads a shared Source to the GPU once.
    const seenTexture = new Set<unknown>();
    const countTexture = (tex: THREE.Texture | null | undefined) => {
      if (!tex?.isTexture) return;
      const source = tex.source ?? tex;
      if (seenTexture.has(source)) return;
      seenTexture.add(source);
      textureBytes += MemoryUtils.getTextureByteLength(tex);
    };
    const countMaterial = (m: THREE.Material | undefined) => {
      for (const value of Object.values(m ?? {})) countTexture(value as THREE.Texture);
    };
    // ImageOverlayPlugin draws imagery from a uniform array, not a material map —
    // usually the bulk of texture memory. It keys that array by mesh, so it is
    // still found after customizeTileMaterial swaps the material out.
    const overlayParams = (this.overlayPlugin as unknown as { meshParams?: WeakMap<THREE.Mesh, { layerMaps: { value: Array<THREE.Texture | null> } }> } | null)?.meshParams;
    // Every loaded model, not just `group`: the renderer detaches tiles that
    // leave the view but keeps their buffers cached until LRU disposal.
    this.tiles.forEachLoadedModel((scene: THREE.Object3D) => {
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        if (g && !seenGeometry.has(g)) {
          seenGeometry.add(g);
          for (const attr of Object.values(g.attributes)) geometryBytes += (attr as THREE.BufferAttribute).array?.byteLength ?? 0;
          geometryBytes += g.index?.array.byteLength ?? 0;
        }
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) countMaterial(m);
        // While a debug mode is on, the plugin holds the real material aside
        // (restored on 'none'); its textures are still allocated.
        countMaterial(originalDebugMaterial(mesh));
        for (const tex of overlayParams?.get(mesh)?.layerMaps.value ?? []) countTexture(tex);
      });
    });
    this.cubeImagery?.forEachResidentTexture(countTexture);
    const d = this.cpuDiagnostics;
    return {
      update: this.updateTiming.value,
      parse: this.parseTiming.value,
      cpuDecode: this.decodeTiming.value,
      sample: { count: d.sampleCount, lastMicros: d.lastSampleMicros, meanMicros: d.meanSampleMicros },
      tiles: { active: stats.active ?? 0, visible: stats.visible ?? 0, drawn: (stats.visible ?? 0) - this.culledScenes.length, inCache: stats.inCache ?? 0, cpu: d.tileCount },
      network: {
        requests: this.requestCount,
        queued: stats.queued ?? 0,
        downloading: stats.downloading ?? 0,
        parsing: stats.parsing ?? 0,
        failed: stats.failed ?? 0,
      },
      memory: { cacheBytes: cache.cachedBytes ?? 0, maxCacheBytes: cache.maxBytesSize ?? 0, geometryBytes, textureBytes },
      imagery: {
        layers: this.layers.length,
        activeOverlays: this.cubeImagery ? this.cubeImagery.imageryLayers.filter(l => l.visible).length : this.activeOverlays.size,
        overlayResolution: this._overlayResolution,
        requests: this.imageryRequests,
        failed: this.imageryLayers.reduce((n, l) => n + (l.role === 'overlay' || !this.isImageryOnly ? l.failedTiles : 0), 0),
      },
    };
  }

  /** Restart timing windows and the request counter, for a before/after measurement. */
  resetMetrics(): void {
    this.updateTiming.reset();
    this.parseTiming.reset();
    this.decodeTiming.reset();
    this.sampler.resetTiming();
    this.requestCount = 0;
    this.cubeImagery?.resetCounters();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contourLabels.dispose();
    this.cubeGridsAbort.abort();
    this.cube?.source.dispose();
    this.cubeImagery?.dispose();
    this.cubeScenes.clear();
    if (this.terrainCam) {
      this.tiles.deleteCamera(this.terrainCam);
      this.terrainCam = null;
    }
    if (this.coverageCam) {
      this.tiles.deleteCamera(this.coverageCam);
      this.coverageCam = null;
    }
    if (this.nadirCam) {
      this.tiles.deleteCamera(this.nadirCam);
      this.nadirCam = null;
    }
    this.normalMap?.dispose();
    this.tiles.dispose();
  }

  // ---------------------------------------------------------------------------
  // Normal map from heightmap — per-pixel surface normals for smooth terminators
  // ---------------------------------------------------------------------------

  private async loadNormalMap(url: string, strength: number): Promise<void> {
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });

      this.normalMap = this.generateNormalMap(img, strength);
      console.log(`[Cosmolabe] Generated terrain normal map from heightmap (${this.normalMap.image.width}x${this.normalMap.image.height})`);

      // Retroactively apply to tiles that loaded before the normal map was ready
      this.tiles.forEachLoadedModel((scene: THREE.Object3D, tile: any) => {
        this.applyNormalMap(scene, tile);
      });
    } catch (e) {
      console.warn('[Cosmolabe] Failed to load terrain normal map source:', e);
    }
  }

  /**
   * Generate a tangent-space normal map from a heightmap image.
   * Caps resolution at 4096px wide for performance (~32MB working memory).
   */
  private generateNormalMap(img: HTMLImageElement, strength: number): THREE.CanvasTexture {
    const maxDim = 4096;
    let w = img.naturalWidth ?? img.width;
    let h = img.naturalHeight ?? img.height;
    if (w > maxDim) {
      h = Math.round(h * maxDim / w);
      w = maxDim;
    }

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = w;
    srcCanvas.height = h;
    const srcCtx = srcCanvas.getContext('2d')!;
    srcCtx.drawImage(img, 0, 0, w, h);
    const srcData = srcCtx.getImageData(0, 0, w, h).data;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d')!;
    const outImg = outCtx.createImageData(w, h);
    const out = outImg.data;

    // Sample height, wrapping horizontally (equirectangular), clamping vertically
    const getH = (x: number, y: number) => {
      x = ((x % w) + w) % w;
      y = Math.max(0, Math.min(h - 1, y));
      return srcData[(y * w + x) * 4] / 255;
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const hL = getH(x - 1, y);
        const hR = getH(x + 1, y);
        const hU = getH(x, y - 1);
        const hD = getH(x, y + 1);
        const dx = (hR - hL) * strength;
        const dy = (hD - hU) * strength;
        const len = Math.sqrt(dx * dx + dy * dy + 1);
        const idx = (y * w + x) * 4;
        out[idx]     = (-dx / len * 0.5 + 0.5) * 255;
        out[idx + 1] = (-dy / len * 0.5 + 0.5) * 255;
        out[idx + 2] = (1 / len * 0.5 + 0.5) * 255;
        out[idx + 3] = 255;
      }
    }

    outCtx.putImageData(outImg, 0, 0);
    const tex = new THREE.CanvasTexture(outCanvas);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  /**
   * Set material properties on a loaded tile, blend normals toward sphere, and apply normal map.
   */
  /** Enable eclipse shadow receiving on all current and future terrain tiles. */
  enableShadowReceiving(uniforms: ShadowUniforms): void {
    this.shadowUniforms = uniforms;
  }

  /** Enable aerial-perspective compositing on all current and future terrain tiles. */
  enableAerialPerspective(uniforms: AerialPerspectiveUniforms): void {
    this.aerialPerspectiveUniforms = uniforms;
  }

  private customizeTileMaterial(scene: THREE.Object3D, tile: any): void {
    // Disable Three.js frustum culling — TilesRenderer handles visibility.
    // The main camera's extreme near/far ratio (up to 10^14 with log depth)
    // can produce degenerate frustum planes that incorrectly cull tiles.
    scene.traverse((child) => { child.frustumCulled = false; });

    // Pin tile renderables to renderOrder = -2 for imagery-only tilesets.
    // TilesFadePlugin (registered above) flips tile materials to
    // `transparent: true` for 300 ms after a tile loads, which puts the tile in
    // three.js's transparent pass at the OBJECT3D's renderOrder. TrajectoryLine
    // uses renderOrder = -1, so without this every fading tile (default
    // renderOrder 0) would render AFTER trails and paint over them whenever the
    // camera moved.
    //
    // Scoped to imagery-only because real 3D Tiles (terrain.url) have actual
    // displacement and interact with the placeholder body sphere differently —
    // setting renderOrder = -2 there can let trajectory lines render visibly
    // *through* the planet at viewpoints where the fading tiles don't yet write
    // depth and the body sphere has been hidden by the close-zoom transition.
    // Imagery-only tiles sit at exact sphere altitude so this concern doesn't
    // apply to them.
    if (this.isImageryOnly) {
      scene.traverse((child) => {
        const c = child as THREE.Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
        if (c.isMesh || c.isLine || c.isPoints || c.isSprite) {
          c.renderOrder = -2;
        }
      });
    }

    const su = this.shadowUniforms;
    const apu = this.aerialPerspectiveUniforms;
    const cacheKey = (su ? '_shadow_v1' : '') + (apu ? '_ap_v2' : '');

    scene.traverse((child) => {
      if (!isMesh(child) || !child.material) return;
      const material = child.material as THREE.Material;
      if (this.customizedMaterials.has(Array.isArray(child.material) ? child.material[0] : material)) return;

      // Three.js shadow-map receiving for tile geometry. Lets the sun
      // DirectionalLight's shadow map (cast by helicopters / drones) darken
      // the terrain underneath. Independent of the analytical eclipse shadow.
      child.receiveShadow = true;

      // Unlit tiles (MeshBasicMaterial — used by XYZTilesPlugin imagery and
      // also by 3D Tiles that ship with the KHR_materials_unlit extension,
      // e.g. Cesium Mars's photo-baked global imagery) need a swap to
      // MeshStandardMaterial to receive the sun DirectionalLight + atmosphere
      // shading. Originally gated on `isImageryOnly`, but cesium-ion terrain
      // hits the same case via KHR_materials_unlit, so the gate is just
      // "incoming material is unlit".
      //
      // When ImageOverlayPlugin has already wrapped this MeshBasicMaterial
      // (multi-layer config), preserve its wrap: the wrap is an
      // `onBeforeCompile` closure over IOP's shared `params` object (which
      // holds `layerMaps` / `layerInfo` uniform refs) plus a couple of
      // `defines` (`LAYER_COUNT` etc.). Copying those over to the new
      // MeshStandardMaterial keeps overlay composition working — IOP's
      // per-frame `meshParams.get(mesh)` writes land on the new material
      // because it reads `mesh.material` dynamically, not a cached ref.
      if (isMeshBasicMaterial(material) && material.map) {
        const basic = material;
        const overlayOnBeforeCompile = basic.onBeforeCompile;
        const overlayDefines = basic.defines ? { ...basic.defines } : null;
        const hasOverlayWrap = this.hasOverlays && overlayDefines && 'LAYER_COUNT' in overlayDefines;

        const mat = new THREE.MeshStandardMaterial({
          map: basic.map,
          transparent: false,
          metalness: 0,
          roughness: 0.85,
        });
        if (hasOverlayWrap) {
          // Bring the LAYER_COUNT (+ LAYER_N_EXISTS etc.) defines across so the
          // overlay shader chunks compile in. IOP updates these each frame.
          mat.defines = { ...(mat.defines ?? {}), ...overlayDefines };
        }
        // Chain shader injections: IOP wrap first (overlay compositing on top
        // of `diffuseColor`), then cosmolabe's eclipse-shadow + aerial-
        // perspective passes. Order matters — overlays should land before
        // shadow/atmosphere darken the result.
        const cacheKeySuffix = (hasOverlayWrap ? '_overlay_v1' : '');
        if (su || apu || hasOverlayWrap) {
          mat.onBeforeCompile = (shader, renderer) => {
            if (hasOverlayWrap && overlayOnBeforeCompile) {
              (overlayOnBeforeCompile as (s: typeof shader, r: typeof renderer) => void)(shader, renderer);
            }
            if (su) injectShadowIntoShader(shader, su);
            if (apu) injectAerialPerspectiveIntoShader(shader, apu as unknown as Record<string, { value: unknown }>);
          };
          mat.customProgramCacheKey = () => cacheKey + cacheKeySuffix;
        }
        // Keep ImageOverlayPlugin's wrap marker, so it never wraps the swapped
        // material a second time: the chain above already carries its shader.
        for (const sym of Object.getOwnPropertySymbols(basic)) {
          if (sym.description === 'OVERLAY_PARAMS') (mat as unknown as Record<symbol, unknown>)[sym] = (basic as unknown as Record<symbol, unknown>)[sym];
        }
        this.customizedMaterials.add(mat);
        child.material = mat;
        basic.dispose();
        // Imagery-only tiles from XYZTilesPlugin already have correct sphere normals
        // on their generated ellipsoid geometry — skip the expensive per-vertex blend.
        return;
      }

      // Keep the cube builder's central-difference physical normals in ordinary
      // imagery as well as styled mode. The 0.6 QM sphere blend flattens authored
      // slopes; it also assumes the tile centre lives directly on the mesh,
      // which is not a general glTF transform contract. This intentionally
      // changes cube lighting relative to main, independently of style toggles.
      // See docs/validation/cube-surface-appearance for main-vs-PR lit captures.
      if (!this.cubeConfigured) this.blendSphereNormals(child, 0.6);

      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        this.customizedMaterials.add(mat);
        if ('roughness' in mat) (mat as THREE.MeshStandardMaterial).roughness = 0.85;
        if ('metalness' in mat) (mat as THREE.MeshStandardMaterial).metalness = 0;
        if (su || apu) {
          const prevOBC = (mat as any).onBeforeCompile;
          (mat as any).onBeforeCompile = (shader: any) => {
            prevOBC?.(shader);
            if (su) injectShadowIntoShader(shader, su);
            if (apu) injectAerialPerspectiveIntoShader(shader, apu as unknown as Record<string, { value: unknown }>);
          };
          (mat as any).customProgramCacheKey = () => cacheKey;
          (mat as any).needsUpdate = true;
        }
      }
    });

    if (this.normalMap) {
      this.applyNormalMap(scene, tile);
    }
    if (!this.cubeConfigured) this.attachSurfaceStyle(scene);
  }

  private attachSurfaceStyle(scene: THREE.Object3D): void {
    if (!this.surfaceStyle) return;
    scene.traverse(child => {
      if (!isMesh(child) || child.name.startsWith('cube-imagery-block ')) return;
      const matrix = new THREE.Matrix4();
      // Mesh local metres -> body-fixed Z north. Include glTF's Y-up
      // conversion and all tile ancestors, exclude camera-relative tiles.group.
      let node: THREE.Object3D | null = child;
      while (node && node !== this.tiles.group) {
        if (node.matrixAutoUpdate) node.updateMatrix();
        matrix.premultiply(node.matrix);
        node = node.parent;
      }
      if (this.cubeConfigured) {
        const g = child.geometry, n = g.userData.surfaceTriangles;
        if (!Number.isSafeInteger(n) || n <= 0 || !g.index || 3 * n > g.index.count || !this.cubeStyleHeightRange) return;
        const scale = new THREE.Vector3().setFromMatrixScale(matrix);
        if ([scale.x, scale.y, scale.z].some(v => !Number.isFinite(v) || Math.abs(v - 1) > 1e-6)) return;
        const point = new THREE.Vector3(), positions = g.getAttribute('position');
        const radius = this.surfaceStyle!.datum.referenceShape;
        if (radius.kind !== 'sphere') return;
        // Validate metre encoding against the product range on surface vertices;
        // skirts intentionally extend below it. Allow 1 m for float32 offsets.
        for (let i = 0; i < n * 3; i++) {
          point.fromBufferAttribute(positions, g.index.getX(i)).applyMatrix4(matrix);
          const height = point.length() * 0.001 - radius.radiusKm;
          if (!Number.isFinite(height) || height < this.cubeStyleHeightRange[0] - 0.001 || height > this.cubeStyleHeightRange[1] + 0.001) return;
        }
      }
      // A detached cached QM root is still `visible=true`. It must not enter
      // style preparation, auto-spacing or labels with its stale world scale.
      this.surfaceStyle!.attach(child, matrix, scene);
    });
  }

  /**
   * Blend vertex normals toward sphere normals for surface vertices.
   * Skirt vertices (geometry groups 2+) are left unchanged.
   *
   * Vertex positions in quantized mesh are ECEF relative to tile center
   * (mesh.position holds the center offset). Adding it back gives the absolute
   * ECEF position, and normalizing that gives the ellipsoid surface direction.
   *
   * @param blendFactor 0 = pure vertex normal, 1 = pure sphere normal
   */
  private blendSphereNormals(mesh: THREE.Mesh, blendFactor: number): void {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    const norm = geom.getAttribute('normal');
    if (!pos || !norm) return;

    // Find the index range for surface vertices (group 0).
    // Groups: 0=surface, 1=bottom cap (if solid), 2+=skirts
    const groups = geom.groups;
    let surfaceVertexEnd = pos.count; // default: all vertices are surface
    if (groups.length > 0) {
      // Surface group is the first one. Find max vertex index used by surface triangles.
      const surfaceGroup = groups[0];
      const index = geom.index;
      if (index && surfaceGroup) {
        let maxIdx = 0;
        const start = surfaceGroup.start;
        const end = start + surfaceGroup.count;
        for (let i = start; i < end; i++) {
          const idx = index.getX(i);
          if (idx > maxIdx) maxIdx = idx;
        }
        surfaceVertexEnd = maxIdx + 1;
      }
    }

    // Tile center in ECEF — mesh.position is set by QuantizedMeshLoader
    const cx = mesh.position.x;
    const cy = mesh.position.y;
    const cz = mesh.position.z;

    const sphere = new THREE.Vector3();
    const vertex = new THREE.Vector3();

    for (let i = 0; i < surfaceVertexEnd; i++) {
      // Absolute ECEF position = relative position + tile center
      sphere.set(
        pos.getX(i) + cx,
        pos.getY(i) + cy,
        pos.getZ(i) + cz,
      ).normalize();

      // Existing vertex normal
      vertex.set(norm.getX(i), norm.getY(i), norm.getZ(i));

      // Blend: lerp toward sphere normal, then renormalize
      vertex.lerp(sphere, blendFactor).normalize();

      norm.setXYZ(i, vertex.x, vertex.y, vertex.z);
    }
    norm.needsUpdate = true;
  }

  /**
   * Apply the global normal map to a tile's material with per-tile UV offset/repeat.
   * Uses the tile's bounding volume region (EPSG:4326 radians) to compute the
   * transform from tile-local UVs to global equirectangular coordinates.
   */
  private applyNormalMap(scene: THREE.Object3D, tile: any): void {
    if (!this.normalMap) return;

    // boundingVolume.region = [west, south, east, north, minHeight, maxHeight] in radians
    const region = tile?.boundingVolume?.region as number[] | undefined;
    if (!region || region.length < 4) return;

    const [west, south, east, north] = region;
    const TWO_PI = 2 * Math.PI;

    // Map tile UV → global equirectangular UV for the normal map.
    // Normal map: U = (lon + π) / 2π, V = (π/2 - lat) / π
    // Tile UV: u ∈ [0,1] west→east, v ∈ [0,1] south→north
    const repeatX = (east - west) / TWO_PI;
    const offsetX = (west + Math.PI) / TWO_PI;
    const repeatY = -(north - south) / Math.PI;  // negative: tile v goes S→N, texture V goes N→S
    const offsetY = (Math.PI / 2 - south) / Math.PI;

    scene.traverse((child) => {
      if (!isMesh(child) || !child.material) return;
      const mat = child.material as THREE.MeshStandardMaterial;
      if (!('normalMap' in mat)) return;

      // Clone texture — shares GPU data (same source), gets its own offset/repeat
      const normalTex = this.normalMap!.clone();
      normalTex.offset.set(offsetX, offsetY);
      normalTex.repeat.set(repeatX, repeatY);
      normalTex.updateMatrix();

      mat.normalMap = normalTex;
      mat.normalScale = new THREE.Vector2(0.5, 0.5);
      mat.needsUpdate = true;
    });
  }
}
