import { cubeFaceBasis, cubeTileAt } from './CubeSphere.js';
import { blockBoundingSphere, parseImageryAddress, texelCenterDirection, type ImageryAddress, type Vec3 } from './CubeImagery.js';

/**
 * Virtual cube imagery (#136): cube tiles resampled on demand from an ordinary
 * geographic (EPSG:4326-style) or Web Mercator (EPSG:3857) tile source, in the
 * exact registration of `CubeImagery.ts`. Pure arithmetic, no Three.js, no I/O.
 *
 * A source is a list of tile matrices. Each matrix is a regular pixel grid in
 * *projected degrees*: `X` is longitude; `Y` is latitude for a geographic
 * source and the Mercator ordinate `deg(asinh(tan φ))` for a Mercator source.
 * Pixel corners are integers and pixel `(i, j)` spans
 * `X ∈ [x0 + i·dx, x0 + (i+1)·dx]`, `Y ∈ [y0 − (j+1)·dy, y0 − j·dy]`, so a
 * sample position `(X, Y)` is source pixel coordinate `((X − x0)/dx, (y0 − Y)/dy)`
 * with pixel centres at `+0.5` — the same corner convention as cube tiles.
 *
 * Each cube texel centre's body-fixed geocentric direction is converted to the
 * source's latitude convention (planetocentric, or geodetic on the terrain's
 * ellipsoid) before it is projected, so pixels register to the same directions
 * as the cube geometry and preprocessed cube products, gutters included.
 */
export type SourceProjection = 'geographic' | 'mercator';
export type SourceLatitudeConvention = 'planetocentric' | 'geodetic';

export interface SourceMatrix {
  /** The source's own matrix identifier (XYZ zoom as a string, or a WMTS TileMatrix id). */
  id: string;
  /** Index in the source's matrix list, coarse → fine. */
  index: number;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  /** Top-left corner, projected degrees. */
  x0: number;
  y0: number;
  /** Pixel size, projected degrees. */
  dx: number;
  dy: number;
}

export interface ProjectedSourceGrid {
  projection: SourceProjection;
  latitudeConvention: SourceLatitudeConvention;
  /** Coarse → fine. Matrices below `minMatrix` hold no data (regional/padded products). */
  matrices: SourceMatrix[];
  minMatrix: number;
  /** Data bounds `[west, south, east, north]`, degrees in the source's latitude convention; null for global. */
  bounds: readonly [number, number, number, number] | null;
}

/** Mercator latitude limit: the latitude whose ordinate equals 180 projected degrees. */
export const MERCATOR_MAX_LATITUDE = Math.atan(Math.sinh(Math.PI)) * 180 / Math.PI;
const RAD = Math.PI / 180;

export function mercatorY(latDeg: number): number { return Math.asinh(Math.tan(latDeg * RAD)) / RAD; }
export function mercatorLatitude(yDeg: number): number { return Math.atan(Math.sinh(yDeg * RAD)) / RAD; }

/** XYZ/TMS source of the conventional quadtree progression. Geographic: 2×1 tiles at z0; Mercator: 1×1. */
export function xyzSourceGrid(options: { projection: SourceProjection; levels: number; tileSize: number; minZoom?: number; latitudeConvention: SourceLatitudeConvention; bounds?: readonly [number, number, number, number] | null }): ProjectedSourceGrid {
  const { projection, levels, tileSize } = options;
  if (!Number.isSafeInteger(levels) || levels < 1 || levels > 31) throw new Error('XYZ source levels must be an integer in [1, 31]');
  if (!Number.isSafeInteger(tileSize) || tileSize < 1) throw new Error('XYZ source tile size must be a positive integer');
  const matrices: SourceMatrix[] = [];
  for (let z = 0; z < levels; z++) {
    const cols = (projection === 'geographic' ? 2 : 1) * 2 ** z, rows = 2 ** z;
    const extentY = projection === 'geographic' ? 180 : 360;
    matrices.push({ id: String(z), index: z, cols, rows, tileWidth: tileSize, tileHeight: tileSize, x0: -180, y0: extentY / 2, dx: 360 / (cols * tileSize), dy: extentY / (rows * tileSize) });
  }
  return { projection, latitudeConvention: options.latitudeConvention, matrices, minMatrix: Math.min(levels - 1, Math.max(0, options.minZoom ?? 0)), bounds: options.bounds ?? null };
}

/** Geocentric unit direction → source latitude/longitude, degrees. */
export function directionToSourceLonLat(d: Vec3, convention: SourceLatitudeConvention, ellipsoid: readonly [number, number] | null): [number, number] {
  const lon = Math.atan2(d[1], d[0]) / RAD;
  const horizontal = Math.hypot(d[0], d[1]);
  let lat = Math.atan2(d[2], horizontal);
  if (convention === 'geodetic' && ellipsoid && ellipsoid[0] !== ellipsoid[1]) {
    // A point at height zero along a geocentric ray: tan φd = (a²/c²) tan φc.
    const ratio = (ellipsoid[0] * ellipsoid[0]) / (ellipsoid[1] * ellipsoid[1]);
    lat = Math.atan2(d[2] * ratio, horizontal);
  }
  return [lon, lat / RAD];
}

/** Source latitude → geocentric latitude, degrees (inverse of the conversion above). */
export function sourceLatitudeToGeocentric(latDeg: number, convention: SourceLatitudeConvention, ellipsoid: readonly [number, number] | null): number {
  if (convention !== 'geodetic' || !ellipsoid || ellipsoid[0] === ellipsoid[1] || Math.abs(latDeg) >= 90) return latDeg;
  return Math.atan(Math.tan(latDeg * RAD) * (ellipsoid[1] * ellipsoid[1]) / (ellipsoid[0] * ellipsoid[0])) / RAD;
}

/** Wrap longitude to `[-180, 180)`. */
export function wrapLongitude(lon: number): number { return ((((lon + 180) % 360) + 360) % 360) - 180; }

/** Projected ordinate of a latitude; NaN where the projection holds no data (Mercator poleward of its limit). */
export function projectLatitude(projection: SourceProjection, latDeg: number): number {
  if (projection === 'geographic') return latDeg;
  return Math.abs(latDeg) > MERCATOR_MAX_LATITUDE ? NaN : mercatorY(latDeg);
}

/** Angular size of one source pixel along the meridian at a latitude, radians. */
export function sourcePixelAngle(grid: ProjectedSourceGrid, matrix: SourceMatrix, latDeg: number): number {
  return grid.projection === 'geographic' ? matrix.dy * RAD : matrix.dy * RAD * Math.cos(Math.min(Math.abs(latDeg), MERCATOR_MAX_LATITUDE) * RAD);
}

/** Whole pixels across 360° of longitude when a matrix wraps exactly; 0 otherwise. */
export function wrapPixels(matrix: SourceMatrix): number {
  const n = 360 / matrix.dx, rounded = Math.round(n);
  return Math.abs(n - rounded) < 1e-6 && rounded <= matrix.cols * matrix.tileWidth ? rounded : 0;
}

/**
 * Deepest useful cube level for a source: the shallowest level whose
 * face-centre texel is no coarser than the source's finest pixel (7 %
 * tolerance), so native detail is never lost to the cube grid. Deeper levels
 * would only magnify source pixels; screen-space error decides whether the
 * deepest level is actually requested.
 */
export function cubeLevelForSourcePixel(pixelAngleRad: number, tileSize: number): number {
  return Math.max(0, Math.min(30, Math.ceil(Math.log2(2 / (tileSize * pixelAngleRad)) - 0.1)));
}

/**
 * Cube levels a source supports. `maxLevel` is the deepest level anywhere;
 * `equatorMaxLevel` the deepest at the equator. They differ for Mercator, whose
 * pixels shrink with cos φ (2.5× finer at 66°, 5.8× at 80°): there the useful
 * depth depends on the tile (`tileMaxLevel`). Below `minLevel` the source's
 * first data matrix would need too many tiles per cube tile.
 */
export interface VirtualLevelRange { minLevel: number; maxLevel: number; equatorMaxLevel: number }

/** Greatest |latitude| (geocentric, degrees) a tile can reach, gutters included, within about 0.3°. */
export function tileMaxAbsLatitude(a: ImageryAddress): number {
  const [N, U, V] = cubeFaceBasis(a.face), size = 2 / 2 ** a.level, u0 = -1 + a.x * size, v0 = -1 + a.y * size;
  const pole = ([[0, 0, 1], [0, 0, -1]] as Vec3[]).some(d => { const t = cubeTileAt(d, a.level); return t.face === a.face && t.x === a.x && t.y === a.y; });
  if (pole) return 90;
  // |z| over a great-circle-bounded tile without a pole peaks on its boundary; 16 samples per edge.
  let best = 0;
  for (let k = 0; k <= 16; k++) for (const [u, v] of [[u0 + k * size / 16, v0], [u0 + k * size / 16, v0 + size], [u0, v0 + k * size / 16], [u0 + size, v0 + k * size / 16]]) {
    const x = N[0] + u * U[0] + v * V[0], y = N[1] + u * U[1] + v * V[1], z = N[2] + u * U[2] + v * V[2];
    best = Math.max(best, Math.abs(Math.atan2(z, Math.hypot(x, y))) / RAD);
  }
  return best;
}

/** Latitude margin (degrees) covering boundary sampling, gutters and the geodetic/geocentric difference. */
const LATITUDE_MARGIN = 0.75;

/**
 * Deepest useful level of one tile: where the cube texel is no coarser than the
 * finest source pixel the tile can hold. Geographic pixels keep their
 * meridian size at every latitude; Mercator pixels shrink with cos φ, so a
 * high-latitude tile may go deeper than an equatorial one. Monotone: a tile
 * never allows less depth than its descendants.
 */
export function tileMaxLevel(grid: ProjectedSourceGrid, tileSize: number, a: ImageryAddress, range: VirtualLevelRange): number {
  if (grid.projection !== 'mercator' || range.maxLevel === range.equatorMaxLevel) return range.maxLevel;
  const finest = grid.matrices[grid.matrices.length - 1];
  const lat = Math.min(tileMaxAbsLatitude(a) + LATITUDE_MARGIN, dataMaxAbsLatitude(grid));
  return Math.max(range.equatorMaxLevel, Math.min(range.maxLevel, cubeLevelForSourcePixel(sourcePixelAngle(grid, finest, lat), tileSize)));
}

/** Greatest |latitude| holding source data (source convention, degrees). */
function dataMaxAbsLatitude(grid: ProjectedSourceGrid): number {
  const limit = grid.projection === 'mercator' ? MERCATOR_MAX_LATITUDE : 90;
  return grid.bounds ? Math.min(limit, Math.max(Math.abs(grid.bounds[1]), Math.abs(grid.bounds[3]))) : limit;
}

export function virtualLevelRange(grid: ProjectedSourceGrid, tileSize: number, maxLevelOverride?: number): VirtualLevelRange {
  const finest = grid.matrices[grid.matrices.length - 1], coarsest = grid.matrices[grid.minMatrix];
  const cap = (level: number) => maxLevelOverride != null ? Math.min(level, Math.max(0, Math.floor(maxLevelOverride))) : level;
  const equatorMaxLevel = cap(cubeLevelForSourcePixel(sourcePixelAngle(grid, finest, 0), tileSize));
  const maxLevel = cap(cubeLevelForSourcePixel(sourcePixelAngle(grid, finest, dataMaxAbsLatitude(grid)), tileSize));
  // Two levels coarser than the first data matrix keeps a cube tile within a few
  // source tiles per side (4× downsampling, area-filtered).
  const minLevel = grid.minMatrix === 0 ? 0 : Math.max(0, Math.min(equatorMaxLevel, cubeLevelForSourcePixel(sourcePixelAngle(grid, coarsest, 0), tileSize) - 2));
  return { minLevel, maxLevel, equatorMaxLevel };
}

/** Conservative spherical-cap overlap of a cube tile with geocentric lon/lat bounds (degrees). */
export function capOverlapsBounds(address: ImageryAddress, bounds: readonly number[] | null): boolean {
  if (!bounds) return true;
  const { centre, radius } = blockBoundingSphere(address, [1, 1]);
  const length = Math.hypot(...centre), angular = Math.asin(Math.min(1, radius / length));
  const lat = Math.atan2(centre[2], Math.hypot(centre[0], centre[1]));
  if (lat + angular < bounds[1] * RAD || lat - angular > bounds[3] * RAD) return false;
  if (Math.abs(lat) + angular >= Math.PI / 2) return true;
  const lon = Math.atan2(centre[1], centre[0]) / RAD;
  const span = Math.asin(Math.min(1, Math.sin(angular) / Math.cos(lat))) / RAD;
  const west = bounds[0], east = bounds[2] < west ? bounds[2] + 360 : bounds[2];
  return [-360, 0, 360].some(offset => lon + span + offset >= west && lon - span + offset <= east);
}

/** Geocentric bounds a source can hold data in: its declared bounds, clipped to the Mercator limit. */
export function geocentricDataBounds(grid: ProjectedSourceGrid, ellipsoid: readonly [number, number] | null): [number, number, number, number] | null {
  const b = grid.bounds;
  const limit = grid.projection === 'mercator' ? MERCATOR_MAX_LATITUDE : 90;
  if (!b && limit === 90) return null;
  const [w, s, e, n] = b ?? [-180, -90, 180, 90];
  const conv = (lat: number) => sourceLatitudeToGeocentric(Math.max(-limit, Math.min(limit, lat)), grid.latitudeConvention, ellipsoid);
  return [w, conv(s), e, conv(n)];
}

/** The read-only part of `Set<string>` that inventories need. */
export interface TileIdSet { has(id: string): boolean }

/**
 * Computed, list-free availability of a virtual source: a tile exists when its
 * level is inside the supported range and it can overlap valid source data.
 * Set-like, so the refinement tree and selection use it unchanged; a new region
 * costs nothing to look up and never needs a planet-wide tile list.
 * `topology` also admits levels above `minLevel` (no pixels), so selection can
 * traverse down to a regional source's first level.
 */
export class VirtualImageryInventory {
  readonly available: TileIdSet;
  readonly topology: TileIdSet;
  constructor(readonly range: VirtualLevelRange, readonly dataBounds: readonly number[] | null,
    /** Whether a tile can be produced within the read budget (see `affordableMatrix`); default always. */
    affordable: (a: ImageryAddress) => boolean = () => true,
    /** Deepest useful level of a tile (see `tileMaxLevel`); default `range.maxLevel`. */
    maxLevelAt: (a: ImageryAddress) => number = () => range.maxLevel) {
    const memo = new Map<string, ImageryAddress | null>(), producible = new Map<string, boolean>();
    const covered = (id: string): ImageryAddress | null => {
      let hit = memo.get(id);
      if (hit !== undefined) return hit;
      try { const a = parseImageryAddress(id); hit = a.level <= range.maxLevel && capOverlapsBounds(a, dataBounds) && (a.level <= range.equatorMaxLevel || a.level <= maxLevelAt(a)) ? a : null; } catch { hit = null; }
      if (memo.size > 65536) memo.clear();
      memo.set(id, hit); return hit;
    };
    this.topology = { has: id => covered(id) !== null };
    this.available = { has: id => {
      const a = covered(id);
      if (!a || a.level < range.minLevel) return false;
      let ok = producible.get(id);
      if (ok === undefined) { ok = affordable(a); if (producible.size > 65536) producible.clear(); producible.set(id, ok); }
      return ok;
    } };
  }
}

/** One source tile key, `matrixIndex/col/row`. */
export type SourceTileKey = string;
export const sourceTileKey = (matrix: number, col: number, row: number): SourceTileKey => `${matrix}/${col}/${row}`;

/**
 * How a cube tile samples one source matrix. Source pixel coordinates (centres
 * at +0.5) are computed exactly on the texel-corner lattice, `(span + 1)²`
 * points; sub-samples inside a texel interpolate its four corners, which is
 * accurate to second order wherever the gnomonic→source mapping is smooth at
 * texel scale. Near a pole (or where a corner has no data) the texel's
 * sub-samples are computed exactly instead.
 */
export interface ReprojectionPlan {
  address: ImageryAddress;
  span: number;
  matrix: SourceMatrix;
  /** Sub-samples per texel along its column (i) and row (j) axes: an anisotropic box filter. */
  samplesX: number;
  samplesY: number;
  /** Lattice source pixel coordinates, NaN where the source holds no data. x is wrapped when the matrix wraps. */
  lx: Float64Array;
  ly: Float64Array;
  /** A pole lies within two texels of the tile: compute every sub-sample exactly. */
  exact: boolean;
  /** Source tiles needed by bilinear sampling. */
  tiles: Array<{ key: SourceTileKey; col: number; row: number }>;
  /** The matrix the texel size asked for, before the read budget coarsened it. */
  wantedMatrix: number;
  grid: ProjectedSourceGrid;
  options: PlanOptions;
}

export interface PlanOptions {
  tileSize: number;
  gutter: number;
  ellipsoid: readonly [number, number] | null;
  /** Upper bound on decoded source pixels one cube tile may read. Default 9 × 512² (nine 512-px or 36 256-px tiles). */
  maxSourcePixels?: number;
  /** Cap on sub-samples per texel side. Default 4. */
  maxSamples?: number;
}

function texelLonLat(grid: ProjectedSourceGrid, a: ImageryAddress, column: number, row: number, opts: PlanOptions): [number, number] {
  return directionToSourceLonLat(texelCenterDirection(a, column, row, opts.tileSize, opts.gutter), grid.latitudeConvention, opts.ellipsoid);
}

/** Angular size of one interior texel of a tile, sampled at the tile's centre and corners; the smallest value. */
export function minTexelAngle(a: ImageryAddress, opts: Pick<PlanOptions, 'tileSize' | 'gutter'>): number {
  const { tileSize: T, gutter: g } = opts;
  let best = Infinity;
  for (const [c, r] of [[g, g], [g + T - 2, g], [g, g + T - 2], [g + T - 2, g + T - 2], [g + T / 2, g + T / 2]]) {
    const p = texelCenterDirection(a, c, r, T, g), q = texelCenterDirection(a, c + 1, r, T, g), s = texelCenterDirection(a, c, r + 1, T, g);
    const angle = Math.min(Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])), Math.acos(Math.min(1, p[0] * s[0] + p[1] * s[1] + p[2] * s[2])));
    best = Math.min(best, angle);
  }
  return best;
}

/** Choose the coarsest matrix at least as fine as the tile's finest texel (on the meridian), within the data matrices. */
export function chooseMatrix(grid: ProjectedSourceGrid, a: ImageryAddress, opts: PlanOptions): number {
  const texel = minTexelAngle(a, opts);
  // Latitudes of the tile's sample points; the finest source requirement wins.
  const lats: number[] = [];
  const span = opts.tileSize + 2 * opts.gutter;
  for (const c of [0, span / 2, span - 1]) for (const r of [0, span / 2, span - 1]) lats.push(texelLonLat(grid, a, c, r, opts)[1]);
  for (let m = grid.minMatrix; m < grid.matrices.length; m++) {
    const matrix = grid.matrices[m];
    if (lats.every(lat => sourcePixelAngle(grid, matrix, lat) <= texel * 1.0001)) return m;
  }
  return grid.matrices.length - 1;
}

/**
 * Plan a cube tile's resampling: pick the source matrix, compute every
 * sub-sample's source pixel position and the source tiles it reads. When the
 * tile would read more than `maxSourceTiles` (near a geographic pole, where a
 * small cap spans every longitude) a coarser matrix is used and recorded.
 */
export function planReprojection(grid: ProjectedSourceGrid, a: ImageryAddress, opts: PlanOptions): ReprojectionPlan {
  const span = opts.tileSize + 2 * opts.gutter;
  const maxSamples = opts.maxSamples ?? 4;
  const wantedMatrix = chooseMatrix(grid, a, opts);
  let m = affordableMatrix(grid, a, opts, wantedMatrix);
  // The estimate picks a starting matrix; the planned tile list is the authority.
  // Nothing is requested unless the actual bilinear read fits the budget.
  while (m !== null) {
    const plan = planAt(grid, a, opts, grid.matrices[m], span, maxSamples, wantedMatrix);
    if (plan.tiles.length <= maxTilesFor(plan.matrix, opts)) return plan;
    m = m > grid.minMatrix ? m - 1 : null;
  }
  throw new SourceBudgetError(`cube tile ${a.face}/${a.level}/${a.x}/${a.y} needs more than the source read budget at every data matrix`);
}

/** A cube tile cannot be produced within `maxSourcePixels` at any data matrix. Deterministic: retrying cannot help. */
export class SourceBudgetError extends Error {
  readonly code = 'source-budget';
  constructor(message: string) { super(message); this.name = 'SourceBudgetError'; }
}

export const DEFAULT_MAX_SOURCE_PIXELS = 9 * 512 * 512;
export const maxTilesFor = (matrix: SourceMatrix, opts: Pick<PlanOptions, 'maxSourcePixels'>) =>
  Math.max(1, Math.floor((opts.maxSourcePixels ?? DEFAULT_MAX_SOURCE_PIXELS) / (matrix.tileWidth * matrix.tileHeight)));

/**
 * Source tiles a cube tile reads at a matrix, estimated from a 9×9 lattice
 * of texel centres (gutters included) plus, when the tile holds a pole, every
 * column of the polar rows: a cap around a pole spans all longitudes. An
 * estimate for availability and the starting matrix only; `planReprojection`
 * enforces the budget on the actual planned tile list.
 */
export function estimateSourceTiles(grid: ProjectedSourceGrid, a: ImageryAddress, matrix: SourceMatrix, opts: PlanOptions): number {
  const span = opts.tileSize + 2 * opts.gutter, tiles = new Set<string>();
  const wrap = wrapPixels(matrix);
  let minRow = Infinity, maxRow = -Infinity;
  for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) {
    const lonLat = texelLonLat(grid, a, i * (span - 1) / 8, j * (span - 1) / 8, opts);
    if (grid.bounds && !insideBounds(lonLat[0], lonLat[1], grid.bounds)) continue;
    const [x, y] = sourcePosition(grid, matrix, lonLat);
    if (!Number.isFinite(x + y)) continue;
    const col = Math.floor((wrap ? ((x % wrap) + wrap) % wrap : x) / matrix.tileWidth), row = Math.floor(y / matrix.tileHeight);
    tiles.add(`${col}/${row}`); minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
  }
  const pole = ([[0, 0, 1], [0, 0, -1]] as Vec3[]).some(d => {
    const t = cubeTileAt(d, a.level);
    return t.face === a.face && t.x === a.x && t.y === a.y;
  });
  if (pole && Number.isFinite(minRow)) return Math.max(tiles.size, matrix.cols * (maxRow - minRow + 1));
  return tiles.size;
}

/** The finest matrix at or below `wanted` whose read fits the pixel budget; null when even the coarsest data matrix does not. */
export function affordableMatrix(grid: ProjectedSourceGrid, a: ImageryAddress, opts: PlanOptions, wanted = chooseMatrix(grid, a, opts)): number | null {
  for (let m = wanted; m >= grid.minMatrix; m--) {
    const matrix = grid.matrices[m];
    // A 3×3 tile read always fits: a cube tile spans at most ~2 source tiles per side at its wanted matrix.
    if (estimateSourceTiles(grid, a, matrix, opts) <= maxTilesFor(matrix, opts)) return m;
  }
  return null;
}

function planAt(grid: ProjectedSourceGrid, a: ImageryAddress, opts: PlanOptions, matrix: SourceMatrix, span: number, maxSamples: number, wantedMatrix: number): ReprojectionPlan {
  const { tileSize: T, gutter: g } = opts;
  const wrap = wrapPixels(matrix);
  // Per-axis sub-samples: the largest source-pixel step per texel step along i and along j.
  let ratioX = 1, ratioY = 1;
  for (const [c, r] of [[g, g], [g + T - 2, g], [g, g + T - 2], [g + T - 2, g + T - 2], [g + T / 2, g + T / 2]]) {
    const p0 = sourcePosition(grid, matrix, texelLonLat(grid, a, c, r, opts));
    const step = (q: [number, number]) => {
      if (!Number.isFinite(p0[0] + q[0])) return 0;
      let ddx = Math.abs(q[0] - p0[0]);
      if (wrap) ddx = Math.min(ddx, wrap - ddx);
      return Math.max(ddx, Math.abs(q[1] - p0[1]));
    };
    ratioX = Math.max(ratioX, step(sourcePosition(grid, matrix, texelLonLat(grid, a, c + 1, r, opts))));
    ratioY = Math.max(ratioY, step(sourcePosition(grid, matrix, texelLonLat(grid, a, c, r + 1, opts))));
  }
  // Up to 1.5 source pixels per texel step stay one bilinear sample (mild minification,
  // which the GPU's mipmaps also absorb); beyond that, a box filter.
  const samplesX = Math.max(1, Math.min(maxSamples, Math.ceil(ratioX - 0.5)));
  const samplesY = Math.max(1, Math.min(maxSamples, Math.ceil(ratioY - 0.5)));
  // Corner lattice, in one tight loop: face point → lon/lat → projected → pixel.
  const n = span + 1, lx = new Float64Array(n * n), ly = new Float64Array(n * n);
  const [N, U, V] = cubeFaceBasis(a.face), size = 2 / 2 ** a.level, u0 = -1 + a.x * size, v1 = -1 + (a.y + 1) * size, step = size / T;
  const geodetic = grid.latitudeConvention === 'geodetic' && opts.ellipsoid && opts.ellipsoid[0] !== opts.ellipsoid[1];
  const ratio = geodetic ? (opts.ellipsoid![0] ** 2) / (opts.ellipsoid![1] ** 2) : 1;
  const mercator = grid.projection === 'mercator', bounds = grid.bounds;
  const pixelsY = matrix.rows * matrix.tileHeight;
  for (let j = 0; j < n; j++) {
    const v = v1 - (j - g) * step;
    for (let i = 0; i < n; i++) {
      const u = u0 + (i - g) * step;
      const x = N[0] + u * U[0] + v * V[0], y = N[1] + u * U[1] + v * V[1], z = N[2] + u * U[2] + v * V[2];
      const lon = Math.atan2(y, x) / RAD, lat = Math.atan2(z * ratio, Math.sqrt(x * x + y * y)) / RAD;
      const k = j * n + i;
      if ((bounds && !insideBounds(lon, lat, bounds)) || (mercator && Math.abs(lat) > MERCATOR_MAX_LATITUDE)) { lx[k] = NaN; ly[k] = NaN; continue; }
      const Y = mercator ? mercatorY(lat) : lat;
      let px = (lon - matrix.x0) / matrix.dx;
      if (wrap) px = ((px % wrap) + wrap) % wrap;
      const py = (matrix.y0 - Y) / matrix.dy;
      if (py < 0 || py > pixelsY) { lx[k] = NaN; ly[k] = NaN; continue; }
      lx[k] = px; ly[k] = py;
    }
  }
  // Exact sampling when a pole lies within two texels of the tile (gutters included).
  let exact = false;
  for (const pole of [[0, 0, 1], [0, 0, -1]] as Vec3[]) {
    const scale = pole[0] * N[0] + pole[1] * N[1] + pole[2] * N[2];
    if (scale <= 0) continue;
    const pu = (pole[0] * U[0] + pole[1] * U[1] + pole[2] * U[2]) / scale, pv = (pole[0] * V[0] + pole[1] * V[1] + pole[2] * V[2]) / scale;
    const margin = (g + 2) * step;
    if (pu >= u0 - margin && pu <= u0 + size + margin && pv >= v1 - size - margin && pv <= v1 + margin) exact = true;
  }
  const plan: ReprojectionPlan = { address: a, span, matrix, samplesX, samplesY, lx, ly, exact, tiles: [], wantedMatrix, grid, options: opts };
  // Tiles read by bilinear sampling at lattice corners and texel centres.
  const seen = new Set<number>();
  const pixelsX = matrix.cols * matrix.tileWidth;
  let last = -1;
  const add = (gx: number, gy: number) => {
    if (gy < 0) gy = 0; else if (gy >= pixelsY) gy = pixelsY - 1;
    if (wrap) gx = ((gx % wrap) + wrap) % wrap; else if (gx < 0) gx = 0; else if (gx >= pixelsX) gx = pixelsX - 1;
    const key = Math.floor(gy / matrix.tileHeight) * matrix.cols + Math.floor(gx / matrix.tileWidth);
    if (key !== last) { last = key; seen.add(key); }
  };
  const visit = (x: number, y: number) => {
    if (!Number.isFinite(x + y)) return;
    const fx = Math.floor(x - 0.5), fy = Math.floor(y - 0.5);
    add(fx, fy); add(fx + 1, fy); add(fx, fy + 1); add(fx + 1, fy + 1);
  };
  // Corners suffice outside exact mode: a texel spans less than a source tile, so the
  // bilinear neighbours of any interior point lie among its corners' neighbours.
  for (let k = 0; k < lx.length; k++) visit(lx[k], ly[k]);
  const sub = (i: number, j: number, fi: number, fj: number) => samplePosition(plan, i, j, fi, fj, wrap);
  if (exact) for (let j = 0; j < span; j++) for (let i = 0; i < span; i++) {
    for (let sj = 0; sj < samplesY; sj++) for (let si = 0; si < samplesX; si++) { const p = sub(i, j, (si + 0.5) / samplesX, (sj + 0.5) / samplesY); visit(p[0], p[1]); }
  }
  plan.tiles = [...seen].map(key => { const col = key % matrix.cols, row = (key - col) / matrix.cols; return { key: sourceTileKey(matrix.index, col, row), col, row }; });
  return plan;
}

/** Source pixel position of a sub-sample (fractions within texel (i, j); 0.5, 0.5 is its centre), as resampling reads it. */
export function texelSamplePosition(plan: ReprojectionPlan, i: number, j: number, fi = 0.5, fj = 0.5): [number, number] {
  const p = samplePosition(plan, i, j, fi, fj, wrapPixels(plan.matrix));
  return [p[0], p[1]];
}

const _position: [number, number] = [NaN, NaN];
/**
 * Source pixel position of a sub-sample at fractions (fi, fj) of texel (i, j).
 * Interpolated from the texel's corners (longitude unwrapped across the
 * antimeridian) unless the plan is exact or a corner has no data.
 */
function samplePosition(plan: ReprojectionPlan, i: number, j: number, fi: number, fj: number, wrap: number): [number, number] {
  const n = plan.span + 1, k = j * n + i, lx = plan.lx, ly = plan.ly;
  const x00 = lx[k], x10 = lx[k + 1], x01 = lx[k + n], x11 = lx[k + n + 1];
  if (!plan.exact && Number.isFinite(x00 + x10 + x01 + x11)) {
    let a = x10, b = x01, c = x11;
    if (wrap) {
      const h = wrap / 2;
      if (a - x00 > h) a -= wrap; else if (x00 - a > h) a += wrap;
      if (b - x00 > h) b -= wrap; else if (x00 - b > h) b += wrap;
      if (c - x00 > h) c -= wrap; else if (x00 - c > h) c += wrap;
    }
    let x = (x00 * (1 - fi) + a * fi) * (1 - fj) + (b * (1 - fi) + c * fi) * fj;
    if (wrap) x = ((x % wrap) + wrap) % wrap;
    _position[0] = x;
    _position[1] = (ly[k] * (1 - fi) + ly[k + 1] * fi) * (1 - fj) + (ly[k + n] * (1 - fi) + ly[k + n + 1] * fi) * fj;
    return _position;
  }
  // Exact: the sub-sample's own direction (pixel centre convention: texel corner + fraction).
  const { grid, options, matrix, address } = plan;
  const lonLat = texelLonLat(grid, address, i + fi - 0.5, j + fj - 0.5, options);
  if (grid.bounds && !insideBounds(lonLat[0], lonLat[1], grid.bounds)) { _position[0] = NaN; _position[1] = NaN; return _position; }
  const p = sourcePosition(grid, matrix, lonLat);
  _position[0] = p[0]; _position[1] = p[1];
  return _position;
}

function insideBounds(lon: number, lat: number, b: readonly number[]): boolean {
  if (lat < b[1] || lat > b[3]) return false;
  return b[0] <= b[2] ? lon >= b[0] && lon <= b[2] : lon >= b[0] || lon <= b[2];
}

/** Source pixel coordinates of a lon/lat; NaN where the source holds no data. Longitude wraps; latitude never does. */
export function sourcePosition(grid: ProjectedSourceGrid, matrix: SourceMatrix, [lon, lat]: readonly [number, number]): [number, number] {
  const y = projectLatitude(grid.projection, lat);
  if (!Number.isFinite(y)) return [NaN, NaN];
  let x = (lon - matrix.x0) / matrix.dx;
  const wrap = wrapPixels(matrix);
  if (wrap) x = ((x % wrap) + wrap) % wrap;
  const row = (matrix.y0 - y) / matrix.dy;
  if (row < 0 || row > matrix.rows * matrix.tileHeight) return [NaN, NaN];
  return [x, row];
}

/** A decoded source tile: RGBA8, row 0 at the top (north). `null` data means a declared gap (404/204): transparent. */
export interface DecodedSourceTile { width: number; height: number; data: Uint8Array | Uint8ClampedArray | null }

/**
 * Resample a plan into an RGBA8 cube tile, premultiplied bilinear with an
 * anisotropic box filter over the plan's sub-samples. Rows are written
 * bottom-up (`t = 0` on the file's bottom row, minimum face v), matching the
 * shader's page uploads. A sub-sample whose four neighbours are not all
 * available (missing/failed tile, outside bounds/projection) contributes
 * transparency, never another source's or day's pixels.
 */
export function resample(plan: ReprojectionPlan, tile: (col: number, row: number) => DecodedSourceTile | undefined): Uint8Array {
  const out = new Uint8Array(plan.span * plan.span * 4);
  resampleRows(plan, tile, out, 0, plan.span);
  return out;
}

/**
 * The same, in row chunks that yield to the event loop between them, so a
 * worker answers aborts and date changes within milliseconds instead of after
 * a whole tile. Rejects with AbortError as soon as `signal` aborts.
 */
export async function resampleYielding(plan: ReprojectionPlan, tile: (col: number, row: number) => DecodedSourceTile | undefined, signal: AbortSignal, rowsPerChunk = 24): Promise<Uint8Array> {
  const out = new Uint8Array(plan.span * plan.span * 4);
  const cache = new Map<number, DecodedSourceTile | 'empty' | null>();
  for (let j = 0; j < plan.span; j += rowsPerChunk) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    resampleRows(plan, tile, out, j, Math.min(plan.span, j + rowsPerChunk), cache);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return out;
}

function resampleRows(plan: ReprojectionPlan, tile: (col: number, row: number) => DecodedSourceTile | undefined, out: Uint8Array, rowStart: number, rowEnd: number,
  resolved = new Map<number, DecodedSourceTile | 'empty' | null>()): void {
  const { span, matrix, samplesX, samplesY } = plan;
  const wrap = wrapPixels(matrix);
  const pixelsX = matrix.cols * matrix.tileWidth, pixelsY = matrix.rows * matrix.tileHeight;
  const tw = matrix.tileWidth, th = matrix.tileHeight;
  // Tiles resolved once, row-major by (row, col) key. EMPTY: a declared gap or fully
  // transparent tile (zero alpha, still valid); null: missing or failed (invalid).
  const EMPTY = 'empty' as const;
  const tileAt = (col: number, row: number): DecodedSourceTile | typeof EMPTY | null => {
    const key = row * matrix.cols + col;
    let t = resolved.get(key);
    if (t === undefined) { const d = tile(col, row); t = !d ? null : !d.data ? EMPTY : d.width === tw && d.height === th ? d : scaled(d, tw, th); resolved.set(key, t); }
    return t;
  };
  let r = 0, gr = 0, b = 0, al = 0;
  // Accumulate one premultiplied pixel; false when it has no data.
  const read = (gx: number, gy: number, w: number): boolean => {
    if (gy < 0) gy = 0; else if (gy >= pixelsY) gy = pixelsY - 1;
    if (wrap) { if (gx < 0) gx += wrap; else if (gx >= wrap) gx -= wrap; } else if (gx < 0) gx = 0; else if (gx >= pixelsX) gx = pixelsX - 1;
    const col = (gx / tw) | 0, row = (gy / th) | 0, t = tileAt(col, row);
    if (!t) return false;
    if (t === EMPTY) return true; // contributes zero alpha
    const d = t.data!, o = ((gy - row * th) * tw + (gx - col * tw)) * 4, a = d[o + 3] * w;
    r += d[o] * a; gr += d[o + 1] * a; b += d[o + 2] * a; al += a;
    return true;
  };
  const per = samplesX * samplesY;
  for (let j = rowStart; j < rowEnd; j++) {
    const outRow = span - 1 - j;
    for (let i = 0; i < span; i++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let sj = 0; sj < samplesY; sj++) for (let si = 0; si < samplesX; si++) {
        const p = samplePosition(plan, i, j, (si + 0.5) / samplesX, (sj + 0.5) / samplesY, wrap);
        const x = p[0], y = p[1];
        if (!(x === x && y === y)) continue;
        const fx = x - 0.5, fy = y - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        r = gr = b = al = 0;
        // Fast path: all four neighbours inside one decoded tile.
        const col = Math.floor(x0 / tw), row = Math.floor(y0 / th);
        if (x0 >= 0 && y0 >= 0 && x0 + 1 < (col + 1) * tw && y0 + 1 < (row + 1) * th && y0 + 1 < pixelsY && (wrap ? x0 + 1 < wrap : x0 + 1 < pixelsX)) {
          const t = tileAt(col, row);
          if (!t || t === EMPTY) continue;
          const d = t.data!, lx0 = x0 - col * tw, ly0 = y0 - row * th, o = (ly0 * tw + lx0) * 4, o2 = o + tw * 4;
          const w00 = (1 - tx) * (1 - ty) * d[o + 3], w10 = tx * (1 - ty) * d[o + 7], w01 = (1 - tx) * ty * d[o2 + 3], w11 = tx * ty * d[o2 + 7];
          sr += d[o] * w00 + d[o + 4] * w10 + d[o2] * w01 + d[o2 + 4] * w11;
          sg += d[o + 1] * w00 + d[o + 5] * w10 + d[o2 + 1] * w01 + d[o2 + 5] * w11;
          sb += d[o + 2] * w00 + d[o + 6] * w10 + d[o2 + 2] * w01 + d[o2 + 6] * w11;
          sa += w00 + w10 + w01 + w11;
          continue;
        }
        if (read(x0, y0, (1 - tx) * (1 - ty)) && read(x0 + 1, y0, tx * (1 - ty)) && read(x0, y0 + 1, (1 - tx) * ty) && read(x0 + 1, y0 + 1, tx * ty)) {
          sr += r; sg += gr; sb += b; sa += al;
        }
      }
      if (sa > 0) {
        const o = (outRow * span + i) * 4;
        out[o] = Math.min(255, Math.round(sr / sa)); out[o + 1] = Math.min(255, Math.round(sg / sa)); out[o + 2] = Math.min(255, Math.round(sb / sa));
        out[o + 3] = Math.min(255, Math.round(sa / per));
      }
    }
  }
}

/** A served tile of another size, nearest-resampled to the declared size so indexing stays exact. */
function scaled(t: DecodedSourceTile, w: number, h: number): DecodedSourceTile {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(t.width - 1, Math.floor((x + 0.5) * t.width / w)), sy = Math.min(t.height - 1, Math.floor((y + 0.5) * t.height / h));
    data.set(t.data!.subarray((sy * t.width + sx) * 4, (sy * t.width + sx) * 4 + 4), (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}

/** Parent source tile one matrix coarser that holds a pixel region, for corrupt-tile fallback. */
export function parentSourceTile(grid: ProjectedSourceGrid, matrix: SourceMatrix, col: number, row: number): { matrix: SourceMatrix; col: number; row: number } | null {
  if (matrix.index <= grid.minMatrix) return null;
  const parent = grid.matrices[matrix.index - 1];
  // Centre of the child tile in projected degrees → parent tile.
  const x = matrix.x0 + (col + 0.5) * matrix.tileWidth * matrix.dx, y = matrix.y0 - (row + 0.5) * matrix.tileHeight * matrix.dy;
  const pc = Math.floor((x - parent.x0) / (parent.dx * parent.tileWidth)), pr = Math.floor((parent.y0 - y) / (parent.dy * parent.tileHeight));
  if (pc < 0 || pr < 0 || pc >= parent.cols || pr >= parent.rows) return null;
  return { matrix: parent, col: pc, row: pr };
}

/**
 * A failed source tile's pixels from its parent one matrix coarser: the
 * matching quarter (or other fraction), bilinearly upsampled to the child's
 * declared size. Marked degraded by the caller; never counted as native.
 */
export function upsampleFromParent(parent: DecodedSourceTile, parentMatrix: SourceMatrix, matrix: SourceMatrix, col: number, row: number): DecodedSourceTile {
  const w = matrix.tileWidth, h = matrix.tileHeight, data = new Uint8ClampedArray(w * h * 4);
  if (!parent.data) return { width: w, height: h, data: null };
  const pc = Math.floor((matrix.x0 + col * w * matrix.dx - parentMatrix.x0) / (parentMatrix.dx * parentMatrix.tileWidth));
  const pr = Math.floor((parentMatrix.y0 - (matrix.y0 - row * h * matrix.dy)) / (parentMatrix.dy * parentMatrix.tileHeight));
  const sx = parent.width / parentMatrix.tileWidth, sy = parent.height / parentMatrix.tileHeight;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    // Child pixel centre → parent pixel coordinates within the parent tile.
    const X = matrix.x0 + (col * w + i + 0.5) * matrix.dx, Y = matrix.y0 - (row * h + j + 0.5) * matrix.dy;
    const fx = ((X - parentMatrix.x0) / parentMatrix.dx - pc * parentMatrix.tileWidth) * sx - 0.5;
    const fy = ((parentMatrix.y0 - Y) / parentMatrix.dy - pr * parentMatrix.tileHeight) * sy - 0.5;
    const x0 = Math.max(0, Math.min(parent.width - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(parent.height - 1, Math.floor(fy)));
    const x1 = Math.min(parent.width - 1, x0 + 1), y1 = Math.min(parent.height - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
    const o = (j * w + i) * 4;
    for (let c = 0; c < 4; c++) {
      const v00 = parent.data[(y0 * parent.width + x0) * 4 + c], v10 = parent.data[(y0 * parent.width + x1) * 4 + c];
      const v01 = parent.data[(y1 * parent.width + x0) * 4 + c], v11 = parent.data[(y1 * parent.width + x1) * 4 + c];
      data[o + c] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    }
  }
  return { width: w, height: h, data };
}
