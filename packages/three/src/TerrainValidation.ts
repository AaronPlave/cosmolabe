/**
 * Renderer-independent terrain validation: numerical seam, pyramid,
 * registration, blend-boundary and control-point reports over decoded terrain
 * tiles. Nothing here imports Three.js or reads rendered meshes — every number
 * comes from the same decoded data and `TerrainSampler` the viewer queries, so
 * a report describes what the runtime actually samples. All lengths are km;
 * formatting into metres is the caller's business.
 *
 * Used by `scripts/validate-terrain.mjs` (offline, small-area) and by the
 * seam-error debug view in `TerrainManager` (online, over cached tiles).
 */
import {
  TerrainSampler,
  datumRadiusAtLat,
  type TerrainDatum,
  type TerrainSample,
  type TerrainSourceMetadata,
  type TerrainTile,
} from './TerrainSampler.js';
import { decodeQuantizedMesh, toTerrainMeshTile } from './internal/quantized-mesh.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Summary of a set of signed differences. An empty set reports NaN, never 0:
 * "nothing compared" must not read as "perfect agreement".
 */
export interface DifferenceStats {
  count: number;
  meanKm: number;
  rmsKm: number;
  /** Nearest-rank 95th percentile of |difference|. */
  p95AbsKm: number;
  maxAbsKm: number;
}

export function summarizeDifferences(values: ArrayLike<number>): DifferenceStats {
  const n = values.length;
  if (n === 0) return { count: 0, meanKm: NaN, rmsKm: NaN, p95AbsKm: NaN, maxAbsKm: NaN };
  let sum = 0, sumSq = 0;
  const abs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum += v;
    sumSq += v * v;
    abs[i] = Math.abs(v);
  }
  abs.sort();
  return {
    count: n,
    meanKm: sum / n,
    rmsKm: Math.sqrt(sumSq / n),
    p95AbsKm: abs[Math.max(0, Math.ceil(0.95 * n) - 1)],
    maxAbsKm: abs[n - 1],
  };
}

/** Planar bias between two surfaces: difference ≈ offset + slopeEast·east + slopeNorth·north. */
export interface PlanarFit {
  /** Fitted difference at the centroid of the compared points. */
  offsetKm: number;
  /** Dimensionless (km per km of ground). */
  slopeEast: number;
  slopeNorth: number;
  /** Tilt of the fitted plane, degrees. */
  tiltDeg: number;
  /** What is left after removing the plane — the part a registration cannot absorb. */
  residual: DifferenceStats;
}

/**
 * Least-squares plane through `value` over local east/north coordinates. With
 * fewer than three points, or collinear ones, the slopes are unidentifiable and
 * report NaN; the offset falls back to the mean.
 */
export function fitPlane(points: ReadonlyArray<{ eastKm: number; northKm: number; valueKm: number }>): PlanarFit {
  const n = points.length;
  let me = 0, mn = 0, mv = 0;
  for (const p of points) { me += p.eastKm; mn += p.northKm; mv += p.valueKm; }
  if (n === 0) {
    return { offsetKm: NaN, slopeEast: NaN, slopeNorth: NaN, tiltDeg: NaN, residual: summarizeDifferences([]) };
  }
  me /= n; mn /= n; mv /= n;
  // Centred normal equations: the offset decouples and only a 2×2 remains.
  let see = 0, snn = 0, sen = 0, sev = 0, snv = 0;
  for (const p of points) {
    const e = p.eastKm - me, nn = p.northKm - mn, v = p.valueKm - mv;
    see += e * e; snn += nn * nn; sen += e * nn; sev += e * v; snv += nn * v;
  }
  const det = see * snn - sen * sen;
  const scale = Math.max(see * snn, 1e-300);
  let slopeEast = NaN, slopeNorth = NaN;
  if (n >= 3 && Math.abs(det) > 1e-12 * scale) {
    slopeEast = (sev * snn - snv * sen) / det;
    slopeNorth = (snv * see - sev * sen) / det;
  }
  const residuals = points.map((p) => Number.isNaN(slopeEast)
    ? p.valueKm - mv
    : p.valueKm - mv - slopeEast * (p.eastKm - me) - slopeNorth * (p.northKm - mn));
  return {
    offsetKm: mv,
    slopeEast,
    slopeNorth,
    tiltDeg: Math.atan(Math.hypot(slopeEast, slopeNorth)) / DEG,
    residual: summarizeDifferences(residuals),
  };
}

// ---------------------------------------------------------------------------
// Geographic tiling (quantized-mesh EPSG:4326 TMS: 2×1 tiles at level 0, y from the south)
// ---------------------------------------------------------------------------

export interface TileKey { z: number; x: number; y: number; }
export interface GeoBounds { westDeg: number; southDeg: number; eastDeg: number; northDeg: number; }

export const tileKeyId = (k: TileKey): string => `${k.z}/${k.x}/${k.y}`;

/** Read a `z/x/y` key out of a tile id, URI or path (`…/12/2048/1024.terrain?v=2`). */
export function parseTileKey(value: string): TileKey | null {
  const m = /(?:^|[^\d])(\d+)\/(\d+)\/(\d+)(?:\.terrain)?(?:[?#].*)?$/.exec(value);
  return m ? { z: +m[1], x: +m[2], y: +m[3] } : null;
}

export function geographicTileBounds(k: TileKey): GeoBounds {
  const span = 180 / 2 ** k.z;
  return {
    westDeg: -180 + k.x * span,
    eastDeg: -180 + (k.x + 1) * span,
    southDeg: -90 + k.y * span,
    northDeg: -90 + (k.y + 1) * span,
  };
}

/** Every tile at level `z` intersecting `bounds`. A west > east box crosses the antimeridian. */
export function geographicTilesCovering(bounds: GeoBounds, z: number): TileKey[] {
  const span = 180 / 2 ** z;
  const nx = 2 ** (z + 1), ny = 2 ** z;
  const yIndex = (lat: number) => Math.max(0, Math.min(ny - 1, Math.floor((lat + 90) / span)));
  const xIndex = (lon: number) => Math.max(0, Math.min(nx - 1, Math.floor((lon + 180) / span)));
  const y0 = yIndex(bounds.southDeg), y1 = yIndex(bounds.northDeg - 1e-12);
  const xs: number[] = [];
  const pushRange = (w: number, e: number) => { for (let x = xIndex(w); x <= xIndex(e - 1e-12); x++) xs.push(x); };
  if (bounds.westDeg <= bounds.eastDeg) pushRange(bounds.westDeg, bounds.eastDeg);
  else { pushRange(bounds.westDeg, 180); pushRange(-180, bounds.eastDeg); }
  const out: TileKey[] = [];
  for (let y = y0; y <= y1; y++) for (const x of xs) out.push({ z, x, y });
  return out;
}

export const tileParent = (k: TileKey): TileKey | null =>
  k.z === 0 ? null : { z: k.z - 1, x: k.x >> 1, y: k.y >> 1 };

export const tileChildren = (k: TileKey): TileKey[] => [0, 1].flatMap((dy) =>
  [0, 1].map((dx) => ({ z: k.z + 1, x: k.x * 2 + dx, y: k.y * 2 + dy })));

/** The same-level neighbour to the east (wrapping the antimeridian) or north (none past the pole row). */
export function tileNeighbor(k: TileKey, direction: 'east' | 'north'): TileKey | null {
  if (direction === 'east') return { z: k.z, x: (k.x + 1) % 2 ** (k.z + 1), y: k.y };
  return k.y + 1 < 2 ** k.z ? { z: k.z, x: k.x, y: k.y + 1 } : null;
}

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------

/** Anything that answers a CPU height query: a whole sampler, one tile, or one source layer. */
export interface TerrainLayer {
  readonly id: string;
  sample(latDeg: number, lonDeg: number): TerrainSample | null;
}

/** The datum only affects normals, which reports never derive; elevations are datum-free here. */
const UNIT_DATUM: TerrainDatum = { referenceShape: { kind: 'sphere', radiusKm: 1 }, verticalDatum: 'unknown', heightConvention: 'radial' };
const UNKNOWN_SOURCE: TerrainSourceMetadata = { id: 'validation', kind: 'unknown' };

/** A layer that answers from exactly one tile — so a comparison can't be served by its neighbour. */
export function singleTileLayer(tile: TerrainTile): TerrainLayer {
  const sampler = new TerrainSampler(UNIT_DATUM, tile.source ?? UNKNOWN_SOURCE, 1);
  sampler.addTile(tile);
  return { id: tile.id, sample: (lat, lon) => sampler.sample(lat, lon) };
}

/** Wrap a sampler (or anything with `sample(lat, lon)`) as a named layer. */
export function samplerLayer(id: string, sampler: { sample(latDeg: number, lonDeg: number): TerrainSample | null }): TerrainLayer {
  return { id, sample: (lat, lon) => sampler.sample(lat, lon) };
}

const lonDelta = (a: number, b: number) => ((a - b + 540) % 360 + 360) % 360 - 180;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/**
 * Keep sample points a hair inside a tile so the sampler's inclusive bounds
 * test never flips on float rounding at an edge. 1e-7 of a tile is far below
 * any vertex spacing, so it changes no reported height.
 */
const INSET = 1e-7;

// ---------------------------------------------------------------------------
// Same-LOD shared edges
// ---------------------------------------------------------------------------

export interface EdgeReport {
  /** West or south tile. */
  a: string;
  /** East or north tile. */
  b: string;
  direction: 'east' | 'north';
  samples: number;
  /** Positions either tile could not answer (a TIN hole at the edge). */
  missing: number;
  /** b − a along the shared edge. */
  stats: DifferenceStats;
}

/**
 * Height disagreement along the edge two same-level tiles share. A continuous
 * pyramid has equivalent samples on both sides, so anything here is a crack
 * the renderer has to hide with skirts. Returns null when the tiles do not
 * share an edge.
 */
export function sharedEdgeReport(first: TerrainTile, second: TerrainTile, options: { samples?: number } = {}): EdgeReport | null {
  const n = Math.max(2, options.samples ?? 65);
  const tolDeg = 1e-9 * 360;
  const sharesEast = (a: TerrainTile, b: TerrainTile) =>
    near(lonDelta(a.eastDeg, b.westDeg), 0, tolDeg) && near(a.southDeg, b.southDeg, tolDeg) && near(a.northDeg, b.northDeg, tolDeg);
  const sharesNorth = (a: TerrainTile, b: TerrainTile) =>
    near(a.northDeg, b.southDeg, tolDeg) && near(lonDelta(a.westDeg, b.westDeg), 0, tolDeg) && near(lonDelta(a.eastDeg, b.eastDeg), 0, tolDeg);

  let a: TerrainTile, b: TerrainTile, direction: 'east' | 'north';
  if (sharesEast(first, second)) { a = first; b = second; direction = 'east'; }
  else if (sharesEast(second, first)) { a = second; b = first; direction = 'east'; }
  else if (sharesNorth(first, second)) { a = first; b = second; direction = 'north'; }
  else if (sharesNorth(second, first)) { a = second; b = first; direction = 'north'; }
  else return null;

  const la = singleTileLayer(a), lb = singleTileLayer(b);
  const diffs: number[] = [];
  let missing = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let ha: TerrainSample | null, hb: TerrainSample | null;
    if (direction === 'east') {
      const latSpan = a.northDeg - a.southDeg;
      const lat = a.southDeg + Math.min(1 - INSET, Math.max(INSET, t)) * latSpan;
      const lonSpanA = (a.eastDeg - a.westDeg + 360) % 360 || 360;
      const lonSpanB = (b.eastDeg - b.westDeg + 360) % 360 || 360;
      ha = la.sample(lat, a.eastDeg - INSET * lonSpanA);
      hb = lb.sample(lat, b.westDeg + INSET * lonSpanB);
    } else {
      const lonSpan = (a.eastDeg - a.westDeg + 360) % 360 || 360;
      const lon = a.westDeg + Math.min(1 - INSET, Math.max(INSET, t)) * lonSpan;
      ha = la.sample(a.northDeg - INSET * (a.northDeg - a.southDeg), lon);
      hb = lb.sample(b.southDeg + INSET * (b.northDeg - b.southDeg), lon);
    }
    if (!ha || !hb) { missing++; continue; }
    diffs.push(hb.elevationKm - ha.elevationKm);
  }
  return { a: a.id, b: b.id, direction, samples: n, missing, stats: summarizeDifferences(diffs) };
}

export interface KeyedTile { key: TileKey; tile: TerrainTile; }

export interface LevelStats { level: number; comparisons: number; stats: DifferenceStats; }

export interface SeamReport {
  edges: number;
  /** Edge sample positions, and how many of them either side could not answer. */
  samples: number;
  missing: number;
  overall: DifferenceStats;
  byLevel: LevelStats[];
  /** Worst edges by max |difference|, most severe first. */
  worst: EdgeReport[];
}

/** Every same-level shared edge among `tiles`, aggregated per level. */
export function seamReport(tiles: Iterable<KeyedTile>, options: { samples?: number; worst?: number } = {}): SeamReport {
  const byId = new Map<string, KeyedTile>();
  for (const t of tiles) byId.set(tileKeyId(t.key), t);
  const reports: Array<{ level: number; report: EdgeReport }> = [];
  // Looking only east and north visits each shared edge exactly once. The
  // tile is passed first so that at level 0, where the two tiles share both
  // the 0° and ±180° edges, each direction reports its own edge.
  for (const { key, tile } of byId.values()) {
    for (const dir of ['east', 'north'] as const) {
      const nk = tileNeighbor(key, dir);
      const neighbor = nk && byId.get(tileKeyId(nk));
      if (!neighbor) continue;
      const report = sharedEdgeReport(tile, neighbor.tile, options);
      if (report) reports.push({ level: key.z, report });
    }
  }
  return aggregate(reports, options.worst ?? 10, (r) => r.stats, (byLevel, overall, worst) => ({
    edges: reports.length,
    samples: reports.reduce((a, r) => a + r.report.samples, 0),
    missing: reports.reduce((a, r) => a + r.report.missing, 0),
    overall, byLevel, worst,
  }));
}

// ---------------------------------------------------------------------------
// Parent/child pyramid consistency
// ---------------------------------------------------------------------------

export interface ParentChildReport {
  parent: string;
  child: string;
  samples: number;
  missing: number;
  /** child − parent at the child's dyadic grid positions. */
  stats: DifferenceStats;
}

/**
 * Compare a child tile with its parent at equivalent dyadic positions: the
 * child's (2^k + 1)² grid, which lands on the parent's own half-, quarter-, …
 * cell positions. The difference is the detail the child adds plus any
 * level-to-level bias; a bias is what makes LOD swaps visibly pop.
 */
export function parentChildReport(parent: TerrainTile, child: TerrainTile, options: { gridSize?: number } = {}): ParentChildReport {
  const n = Math.max(2, options.gridSize ?? 17);
  const lp = singleTileLayer(parent), lc = singleTileLayer(child);
  const lonSpan = (child.eastDeg - child.westDeg + 360) % 360 || 360;
  const latSpan = child.northDeg - child.southDeg;
  const diffs: number[] = [];
  let missing = 0;
  for (let j = 0; j < n; j++) {
    const v = Math.min(1 - INSET, Math.max(INSET, j / (n - 1)));
    for (let i = 0; i < n; i++) {
      const u = Math.min(1 - INSET, Math.max(INSET, i / (n - 1)));
      const lat = child.southDeg + v * latSpan, lon = child.westDeg + u * lonSpan;
      const hc = lc.sample(lat, lon), hp = lp.sample(lat, lon);
      if (!hc || !hp) { missing++; continue; }
      diffs.push(hc.elevationKm - hp.elevationKm);
    }
  }
  return { parent: parent.id, child: child.id, samples: n * n, missing, stats: summarizeDifferences(diffs) };
}

export interface PyramidReport {
  pairs: number;
  samples: number;
  missing: number;
  overall: DifferenceStats;
  /** Keyed by the child's level. */
  byLevel: LevelStats[];
  worst: ParentChildReport[];
}

/** Every parent/child pair present in `tiles`, aggregated by child level. */
export function pyramidReport(tiles: Iterable<KeyedTile>, options: { gridSize?: number; worst?: number } = {}): PyramidReport {
  const byId = new Map<string, KeyedTile>();
  for (const t of tiles) byId.set(tileKeyId(t.key), t);
  const reports: Array<{ level: number; report: ParentChildReport }> = [];
  for (const { key, tile } of byId.values()) {
    const pk = tileParent(key);
    const parent = pk && byId.get(tileKeyId(pk));
    if (parent) reports.push({ level: key.z, report: parentChildReport(parent.tile, tile, options) });
  }
  return aggregate(reports, options.worst ?? 10, (r) => r.stats, (byLevel, overall, worst) => ({
    pairs: reports.length,
    samples: reports.reduce((a, r) => a + r.report.samples, 0),
    missing: reports.reduce((a, r) => a + r.report.missing, 0),
    overall, byLevel, worst,
  }));
}

/**
 * Pool per-comparison statistics. Exact pooling of mean/RMS/max is possible
 * from the summaries; p95 is not, so the pooled p95 is the count-weighted
 * worst p95 — conservative, and labelled as such in the docs.
 */
function aggregate<R, Out>(
  items: Array<{ level: number; report: R }>,
  worstCount: number,
  statsOf: (r: R) => DifferenceStats,
  build: (byLevel: LevelStats[], overall: DifferenceStats, worst: R[]) => Out,
): Out {
  const pool = (list: R[]): DifferenceStats => {
    let count = 0, sum = 0, sumSq = 0, maxAbs = 0, p95 = 0;
    for (const r of list) {
      const s = statsOf(r);
      if (!s.count) continue;
      count += s.count;
      sum += s.meanKm * s.count;
      sumSq += s.rmsKm * s.rmsKm * s.count;
      maxAbs = Math.max(maxAbs, s.maxAbsKm);
      p95 = Math.max(p95, s.p95AbsKm);
    }
    if (!count) return summarizeDifferences([]);
    return { count, meanKm: sum / count, rmsKm: Math.sqrt(sumSq / count), p95AbsKm: p95, maxAbsKm: maxAbs };
  };
  const levels = [...new Set(items.map((i) => i.level))].sort((a, b) => a - b);
  const byLevel = levels.map((level) => {
    const list = items.filter((i) => i.level === level).map((i) => i.report);
    return { level, comparisons: list.length, stats: pool(list) };
  });
  const all = items.map((i) => i.report);
  const worst = [...all]
    .filter((r) => statsOf(r).count > 0)
    .sort((x, y) => statsOf(y).maxAbsKm - statsOf(x).maxAbsKm)
    .slice(0, worstCount);
  return build(byLevel, pool(all), worst);
}

// ---------------------------------------------------------------------------
// Regional registration between two layers
// ---------------------------------------------------------------------------

export interface RegistrationReport {
  reference: string;
  candidate: string;
  bounds: GeoBounds;
  samples: number;
  missing: number;
  /** candidate − reference, raw. */
  difference: DifferenceStats;
  /** Fitted planar bias; `plane.residual` is the difference once that bias is removed. */
  plane: PlanarFit;
}

/**
 * Compare `candidate` against `reference` on a regular grid over `bounds`,
 * and fit the planar bias between them in local east/north km. This is the
 * number a fusion step must disclose and remove before computing a residual.
 */
export function registrationReport(
  reference: TerrainLayer,
  candidate: TerrainLayer,
  bounds: GeoBounds,
  datum: TerrainDatum,
  options: { gridSize?: number } = {},
): RegistrationReport {
  const n = Math.max(2, options.gridSize ?? 33);
  const lonSpan = (bounds.eastDeg - bounds.westDeg + 360) % 360 || 360;
  const lat0 = (bounds.southDeg + bounds.northDeg) / 2;
  const radius = datumRadiusAtLat(datum, lat0);
  const points: Array<{ eastKm: number; northKm: number; valueKm: number }> = [];
  let missing = 0;
  for (let j = 0; j < n; j++) {
    const lat = bounds.southDeg + (j / (n - 1)) * (bounds.northDeg - bounds.southDeg);
    for (let i = 0; i < n; i++) {
      const dLon = (i / (n - 1)) * lonSpan;
      const lon = bounds.westDeg + dLon;
      const r = reference.sample(lat, lon), c = candidate.sample(lat, lon);
      if (!r || !c) { missing++; continue; }
      points.push({
        eastKm: radius * Math.cos(lat0 * DEG) * (dLon - lonSpan / 2) * DEG,
        northKm: radius * (lat - lat0) * DEG,
        valueKm: c.elevationKm - r.elevationKm,
      });
    }
  }
  return {
    reference: reference.id,
    candidate: candidate.id,
    bounds,
    samples: n * n,
    missing,
    difference: summarizeDifferences(points.map((p) => p.valueKm)),
    plane: fitPlane(points),
  };
}

// ---------------------------------------------------------------------------
// Blend / coverage boundary continuity
// ---------------------------------------------------------------------------

export interface BoundaryContinuityReport {
  layer: string;
  boundary: GeoBounds;
  transects: number;
  spacingKm: number;
  bandKm: number;
  /** Second differences h[i+1] − 2h[i] + h[i−1] within `bandKm` of the boundary. */
  boundaryCurvature: DifferenceStats;
  /** The same away from the boundary — the terrain's own roughness at this spacing. */
  backgroundCurvature: DifferenceStats;
  /**
   * boundary RMS ÷ background RMS. ≈1 means the boundary is invisible in the
   * height field; a hard source boundary shows as a spike well above 1.
   */
  ratio: number;
}

/**
 * Walk transects across each edge of a coverage boundary and compare height
 * curvature at the boundary with curvature away from it. A residual tapered to
 * zero leaves the boundary statistically indistinguishable from background; a
 * hard source switch or an untapered residual does not.
 */
export function boundaryContinuityReport(
  layer: TerrainLayer,
  boundary: GeoBounds,
  datum: TerrainDatum,
  options: { transectsPerEdge?: number; spacingKm?: number; halfLengthKm?: number; bandKm?: number } = {},
): BoundaryContinuityReport {
  const perEdge = Math.max(1, options.transectsPerEdge ?? 8);
  const spacingKm = options.spacingKm ?? 0.05;
  const halfLengthKm = options.halfLengthKm ?? spacingKm * 40;
  // One spacing either side: exactly the second differences whose stencil
  // straddles the crossing. A wider band dilutes a one-sample step with
  // background roughness.
  const bandKm = options.bandKm ?? spacingKm;
  const steps = Math.max(3, Math.round(halfLengthKm / spacingKm));
  const lonSpan = (boundary.eastDeg - boundary.westDeg + 360) % 360 || 360;
  const near: number[] = [], far: number[] = [];
  let transects = 0;

  const walk = (lat0: number, lon0: number, alongLat: boolean) => {
    const radius = datumRadiusAtLat(datum, lat0);
    const degPerKm = alongLat ? 1 / (radius * DEG) : 1 / (radius * Math.cos(lat0 * DEG) * DEG);
    const heights: Array<number | null> = [];
    for (let s = -steps; s <= steps; s++) {
      const d = s * spacingKm * degPerKm;
      const sample = alongLat ? layer.sample(lat0 + d, lon0) : layer.sample(lat0, lon0 + d);
      heights.push(sample ? sample.elevationKm : null);
    }
    transects++;
    for (let i = 1; i < heights.length - 1; i++) {
      const h0 = heights[i - 1], h1 = heights[i], h2 = heights[i + 1];
      if (h0 == null || h1 == null || h2 == null) continue;
      const curvature = h2 - 2 * h1 + h0;
      (Math.abs(i - steps) * spacingKm <= bandKm ? near : far).push(curvature);
    }
  };

  for (let k = 0; k < perEdge; k++) {
    const t = (k + 0.5) / perEdge;
    const lat = boundary.southDeg + t * (boundary.northDeg - boundary.southDeg);
    const lon = boundary.westDeg + t * lonSpan;
    walk(lat, boundary.westDeg, false);
    walk(lat, boundary.eastDeg, false);
    walk(boundary.southDeg, lon, true);
    walk(boundary.northDeg, lon, true);
  }
  const boundaryCurvature = summarizeDifferences(near);
  const backgroundCurvature = summarizeDifferences(far);
  return {
    layer: layer.id,
    boundary,
    transects,
    spacingKm,
    bandKm,
    boundaryCurvature,
    backgroundCurvature,
    ratio: boundaryCurvature.rmsKm / backgroundCurvature.rmsKm,
  };
}

// ---------------------------------------------------------------------------
// Mission control points
// ---------------------------------------------------------------------------

export interface ControlPoint {
  id: string;
  latDeg: number;
  lonDeg: number;
  /** Independently known surface elevation, when there is one. */
  expectedElevationKm?: number;
  /** What `expectedElevationKm` is measured against — stated, never assumed equal to the layer's datum. */
  expectedDatum?: string;
  /** Where the point and its expected value come from. */
  source?: string;
}

export interface ControlPointLayerValue {
  elevationKm: number | null;
  /** elevation − expected, when both exist. */
  deltaKm: number | null;
  sourceId?: string;
  tileId?: string;
  uncertaintyKm?: number;
}

export interface ControlPointReport {
  layers: string[];
  results: Array<{ point: ControlPoint; values: Record<string, ControlPointLayerValue> }>;
  /** Per layer: how many points it answered, and delta-vs-expected statistics. */
  byLayer: Record<string, { sampled: number; missing: number; delta: DifferenceStats }>;
}

/**
 * Sample each control point in every layer (e.g. canonical, detail, fused) and
 * report value, provenance and disagreement with the point's expected value.
 */
export function controlPointReport(points: readonly ControlPoint[], layers: readonly TerrainLayer[]): ControlPointReport {
  const results = points.map((point) => {
    const values: Record<string, ControlPointLayerValue> = {};
    for (const layer of layers) {
      const s = layer.sample(point.latDeg, point.lonDeg);
      values[layer.id] = {
        elevationKm: s ? s.elevationKm : null,
        deltaKm: s && point.expectedElevationKm != null ? s.elevationKm - point.expectedElevationKm : null,
        sourceId: s?.source.id,
        tileId: s?.tileId,
        uncertaintyKm: s?.uncertaintyKm,
      };
    }
    return { point, values };
  });
  const byLayer: ControlPointReport['byLayer'] = {};
  for (const layer of layers) {
    const vals = results.map((r) => r.values[layer.id]);
    byLayer[layer.id] = {
      sampled: vals.filter((v) => v.elevationKm != null).length,
      missing: vals.filter((v) => v.elevationKm == null).length,
      delta: summarizeDifferences(vals.flatMap((v) => (v.deltaKm == null ? [] : [v.deltaKm]))),
    };
  }
  return { layers: layers.map((l) => l.id), results, byLayer };
}

// ---------------------------------------------------------------------------
// Sampling cost
// ---------------------------------------------------------------------------

export interface SamplingCostRow { tile: string; vertices: number; triangles: number; microsPerSample: number; }

/**
 * Time CPU queries per tile. The point of the table is the shape, not the
 * absolute numbers: cost is bounded per tile (triangles are binned once, so a
 * query tests a handful of triangles however dense the tile) and has no
 * relationship at all to what the renderer is drawing — the sampler never
 * walks rendered geometry.
 */
export function samplingCostReport(tiles: Iterable<TerrainTile>, samplesPerTile = 2000): SamplingCostRow[] {
  const list = [...tiles];
  const run = (tile: TerrainTile, count: number) => {
    const sampler = new TerrainSampler(UNIT_DATUM, UNKNOWN_SOURCE, 1);
    sampler.addTile(tile);
    const lonSpan = (tile.eastDeg - tile.westDeg + 360) % 360 || 360;
    // Deterministic low-discrepancy points, so runs are comparable.
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      const u = (i * 0.6180339887498949) % 1, v = (i * 0.7548776662466927) % 1;
      sampler.sample(tile.southDeg + v * (tile.northDeg - tile.southDeg), tile.westDeg + u * lonSpan);
    }
    return ((performance.now() - start) * 1000) / count;
  };
  // Warm the JIT on every tile first, or whichever tile runs first pays for it.
  for (const tile of list) run(tile, Math.min(200, samplesPerTile));
  const rows: SamplingCostRow[] = [];
  for (const tile of list) {
    const micros = run(tile, samplesPerTile);
    rows.push({
      tile: tile.id,
      vertices: tile.kind === 'mesh' ? tile.u.length : tile.width * tile.height,
      triangles: tile.kind === 'mesh' ? tile.indices.length / 3 : 2 * (tile.width - 1) * (tile.height - 1),
      microsPerSample: micros,
    });
  }
  return rows.sort((a, b) => a.vertices - b.vertices);
}

// ---------------------------------------------------------------------------
// Quantized-mesh tileset access (fetch injected, so it runs in Node, browser or tests)
// ---------------------------------------------------------------------------

export interface QuantizedMeshLayerJson {
  tiles: string[];
  version?: string;
  scheme?: string;
  projection?: string;
  maxzoom?: number;
  available?: Array<Array<{ startX: number; startY: number; endX: number; endY: number }>>;
}

export interface QuantizedMeshTilesetOptions {
  id: string;
  layer: QuantizedMeshLayerJson;
  /** Fetch a tile path relative to the tileset root; null means the tile does not exist. */
  fetchTile: (path: string) => Promise<ArrayBuffer | null>;
  /** The tileset's `referenceRadiusOffsetKm`, applied exactly as the viewer applies it. */
  heightOffsetKm?: number;
  source?: TerrainSourceMetadata;
  /**
   * Budget of unique tiles this tileset may fetch over its whole life — region,
   * registration, boundary and control-point loads alike. A batch that would
   * exceed it is refused before any of its requests start. Default 256.
   */
  maxTiles?: number;
}

/** Read-only access to a quantized-mesh-1.0 tileset for small-area validation. */
export class QuantizedMeshTileset {
  readonly id: string;
  readonly source: TerrainSourceMetadata;
  private readonly cache = new Map<string, Promise<KeyedTile | null>>();
  private readonly loaded = new Map<string, KeyedTile>();
  /** Tiles layer.json lists but the server did not return. */
  private readonly missing = new Set<string>();
  readonly maxTiles: number;

  constructor(private readonly options: QuantizedMeshTilesetOptions) {
    const { layer } = options;
    if (layer.projection && layer.projection !== 'EPSG:4326') {
      throw new Error(`${options.id}: only EPSG:4326 quantized-mesh tilesets are supported (got ${layer.projection})`);
    }
    if (layer.scheme && layer.scheme !== 'tms') {
      throw new Error(`${options.id}: only the tms tile scheme is supported (got ${layer.scheme})`);
    }
    this.id = options.id;
    this.source = options.source ?? { id: options.id, kind: 'quantized-mesh' };
    this.maxTiles = options.maxTiles ?? 256;
  }

  /** Unique tiles requested so far (fetched, in flight, or missing), counted against `maxTiles`. */
  get requestedTiles(): number { return this.cache.size; }

  /**
   * Admit a batch against the shared budget before any of it is requested.
   * Only available, not-yet-requested tiles count: an unavailable tile is
   * never fetched, and a repeated one is served from the memo.
   */
  private reserve(keys: Iterable<TileKey>, what: string): void {
    const fresh = new Set<string>();
    for (const k of keys) {
      const id = tileKeyId(k);
      if (this.isAvailable(k) && !this.cache.has(id)) fresh.add(id);
    }
    if (this.cache.size + fresh.size > this.maxTiles) {
      throw new Error(`${this.id}: ${what} needs ${fresh.size} more tiles on top of ${this.cache.size} already requested (limit ${this.maxTiles}); shrink the bounds, levels or point set, or raise the limit`);
    }
  }

  get maxLevel(): number {
    return this.options.layer.available ? this.options.layer.available.length - 1 : (this.options.layer.maxzoom ?? 0);
  }

  /** True when layer.json lists the tile, or lists no availability at all. */
  isAvailable(k: TileKey): boolean {
    const available = this.options.layer.available;
    if (!available) return k.z <= this.maxLevel;
    const ranges = available[k.z];
    return !!ranges && ranges.some((r) => k.x >= r.startX && k.x <= r.endX && k.y >= r.startY && k.y <= r.endY);
  }

  /** The tile containing a point at level z. */
  keyAt(latDeg: number, lonDeg: number, z: number): TileKey {
    const lon = ((lonDeg + 180) % 360 + 360) % 360 - 180;
    return geographicTilesCovering({ westDeg: lon, eastDeg: lon + 1e-9, southDeg: latDeg, northDeg: latDeg + 1e-9 }, z)[0];
  }

  /** Deepest available level at a point, capped at `limit`. */
  deepestLevelAt(latDeg: number, lonDeg: number, limit = this.maxLevel): number {
    for (let z = Math.min(limit, this.maxLevel); z > 0; z--) {
      if (this.isAvailable(this.keyAt(latDeg, lonDeg, z))) return z;
    }
    return 0;
  }

  tilePath(k: TileKey): string {
    return this.options.layer.tiles[0]
      .replace('{z}', String(k.z)).replace('{x}', String(k.x)).replace('{y}', String(k.y))
      .replace('{version}', this.options.layer.version ?? '1.0.0');
  }

  /** Load and decode one tile, memoized and counted against `maxTiles`. Null when it is unavailable or missing. */
  load(k: TileKey): Promise<KeyedTile | null> {
    const id = tileKeyId(k);
    let pending = this.cache.get(id);
    if (!pending) {
      this.reserve([k], `tile ${id}`);
      pending = this.isAvailable(k)
        ? this.options.fetchTile(this.tilePath(k)).then((buffer) => {
          if (!buffer) { this.missing.add(id); return null; }
          const tile = toTerrainMeshTile(decodeQuantizedMesh(buffer), {
            id: `${this.id}:${id}`, ...geographicTileBounds(k), source: this.source,
          }, this.options.heightOffsetKm ?? 0);
          const keyed = { key: k, tile };
          this.loaded.set(id, keyed);
          return keyed;
        })
        : Promise.resolve(null);
      this.cache.set(id, pending);
    }
    return pending;
  }

  /** Every tile decoded so far, in load order. */
  loadedTiles(): KeyedTile[] { return [...this.loaded.values()]; }

  /** Ids of tiles layer.json lists but the server did not return — data a report silently lacks. */
  missingTiles(): string[] { return [...this.missing]; }

  /** Load every available tile of `bounds` at each level, within the shared tile budget. */
  async loadRegion(bounds: GeoBounds, levels: readonly number[]): Promise<KeyedTile[]> {
    const keys = levels.flatMap((z) => geographicTilesCovering(bounds, z)).filter((k) => this.isAvailable(k));
    this.reserve(keys, 'region');
    const loaded = await Promise.all(keys.map((k) => this.load(k)));
    return loaded.filter((t): t is KeyedTile => t != null);
  }

  /**
   * A layer answering from the deepest tile at or below `maxLevel` for each
   * point — "canonical" with a low cap, "detail" uncapped. Loads what the
   * points need, then samples synchronously.
   */
  async layerForPoints(layerId: string, points: ReadonlyArray<{ latDeg: number; lonDeg: number }>, maxLevel = this.maxLevel): Promise<TerrainLayer> {
    const keys = new Map<string, TileKey>();
    for (const p of points) {
      const k = this.keyAt(p.latDeg, p.lonDeg, this.deepestLevelAt(p.latDeg, p.lonDeg, maxLevel));
      keys.set(tileKeyId(k), k);
    }
    this.reserve(keys.values(), `layer "${layerId}"`);
    const tiles = (await Promise.all([...keys.values()].map((k) => this.load(k)))).filter((t): t is KeyedTile => t != null);
    const sampler = new TerrainSampler(UNIT_DATUM, this.source, Math.max(1, tiles.length));
    for (const t of tiles) sampler.addTile(t.tile);
    return samplerLayer(layerId, sampler);
  }
}
