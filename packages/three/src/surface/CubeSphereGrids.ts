import { geodeticToBodyFixed, wrapLon, type TerrainDatum, type TerrainSample, type TerrainSourceMetadata } from '../TerrainSampler.js';
import { CpuMeshSurface } from './CpuMeshSurface.js';
import { fetchWithRetry } from '../fetchWithRetry.js';
import {
  CubeSphereSampler, cubeFaceBasis, cubeFaceToDirection, cubeTileId, directionToCubeFace,
  type CubeFace, type CubeFaceCoordinate, type CubeHeightTile, type CubeTileAddress,
} from './CubeSphere.js';
import {
  normalizedRay, type PhysicalSurface, type PhysicalSurfaceMetadata, type SurfaceHit, type SurfaceIntersection,
  type SurfaceQueryLoader, type SurfaceQueryOptions, type SurfaceRay, type SurfaceVector,
} from './PhysicalSurface.js';

/**
 * `cpu-grids.json` written by `scripts/terrain/dem.py cube-tile`: the CPU half
 * of the cube-sphere experiment (#149). Each tile's grid holds the same field
 * samples as its rendered .glb lattice, but is addressed, fetched and evicted
 * here, independently of which meshes the renderer streams or shows. A
 * simplified product (`renderedMesh` present) draws only a subset of those
 * samples as larger triangles, so its rendered and CPU surfaces differ.
 */
export interface CubeGridManifest {
  format: 'cosmolabe-cube-height-grid-1';
  datum: TerrainDatum;
  /** Payload values are radial offsets from this radius, not datum heights.
   * Required for ellipsoidal products; public samples are ellipsoid-normal heights. */
  geometry?: { kind: 'radial-lattice'; referenceRadiusKm: number };
  /** Emitted local float32 offsets versus the same CPU lattice, Euclidean km.
   * This is not a bound on error against the source field or true terrain. */
  renderedLatticeRoundingBoundKm?: number;
  source: TerrainSourceMetadata;
  grid: { width: number; height: number; uri: string; encoding?: string };
  /**
   * `[min, max]` of every stored radial offset in the product (km, padded outward): a
   * residency-independent bound, so a ray query can find terrain it has not
   * loaded yet.
   */
  heightRangeKm: [number, number];
  maxLevel: number;
  /**
   * `[face, level, x, y, uncertaintyKm, renderedDeviationKm?]`; the uncertainty is the builder's sampled
   * representation error. The sixth value, only with `renderedMesh`, bounds the radial distance between
   * the tile's rendered triangles and the full-lattice triangles CubeGridSurface intersects.
   */
  tiles: [CubeFace, number, number, number, number, number?][];
  /** Present when the .glb triangles are simplified rather than the grid's own lattice. */
  renderedMesh?: { simplification: string; cpuSurface: string; deviation: string };
}

export type CubeCoverageState = 'finest' | 'parent-fallback' | 'unloaded';
export interface CubeCoverage {
  /** `finest`: the deepest product tile is resident; `parent-fallback`: a coarser ancestor answers; `unloaded`: nothing does. */
  state: CubeCoverageState;
  /** Deepest level the product has at this point. */
  availableLevel: number;
  residentLevel: number | null;
  residentTileId: string | null;
}

export interface CubeGridSourceOptions {
  /** Levels up to this one load up front and are never evicted: the coarse parent fallback. Default 2. */
  residentLevel?: number;
  /** Finer tiles retained beyond the resident levels, least recently requested evicted first. Default 2048. */
  maxDetailTiles?: number;
  /** Grid requests in flight at once (`fromUrl`); the rest wait. Default 16. */
  maxConcurrentRequests?: number;
  /** A failed grid is requested again by a later query after this long, ms, doubling per failure up to 16×. Default 30 000. */
  retryFailedMs?: number;
}

export interface CubeGridSourceStats {
  residentTiles: number;
  detailTiles: number;
  requests: number;
  bytes: number;
  failed: number;
  inFlight: number;
}

type Address = Pick<CubeTileAddress, 'face' | 'level' | 'x' | 'y'>;
const ID_FIELDS = (id: string): Address => {
  const [face, level, x, y] = id.split('/');
  return { face: face as CubeFace, level: Number(level), x: Number(x), y: Number(y) };
};

/** Streams a cube product's CPU height grids into a CubeSphereSampler. */
export class CubeSphereGridSource {
  readonly sampler: CubeSphereSampler;
  /** Resolves once every resident-level tile is loaded (rejects if any failed). */
  readonly ready: Promise<void>;
  private readonly uncertaintyById = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Detail tiles in least-recently-requested order. */
  private readonly detail = new Map<string, true>();
  /** Failed grids, and when a query may request each again: failures stay recoverable. */
  private readonly failed = new Map<string, { count: number; retryAt: number }>();
  private readonly retryFailedMs: number;
  private readonly residentLevel: number;
  private readonly maxDetailTiles: number;
  private requests = 0;
  private bytes = 0;
  private disposed = false;
  private querySurface?: CubeGridSurface;
  /** Height range of every tile loaded so far, km: the ray query's search shell. */
  minHeightKm = Infinity;
  maxHeightKm = -Infinity;
  /** Called after any tile arrives or leaves; e.g. to invalidate derived caches. */
  onChange?: (id: string) => void;

  constructor(
    readonly manifest: CubeGridManifest,
    private readonly fetchGrid: (uri: string) => Promise<ArrayBuffer>,
    options: CubeGridSourceOptions = {},
  ) {
    if (manifest.format !== 'cosmolabe-cube-height-grid-1') throw new Error(`Unsupported cube grid format ${String(manifest.format)}`);
    const { width, height } = manifest.grid;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) throw new Error('Malformed cube grid dimensions');
    const range = manifest.heightRangeKm;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1]) throw new Error('Malformed cube grid height range');
    this.sampler = new CubeSphereSampler(manifest.datum, manifest.source, manifest.geometry ? 'radial-offset' : 'datum-height');
    const geometry = manifest.geometry;
    if ((geometry && (geometry.kind !== 'radial-lattice' || !Number.isFinite(geometry.referenceRadiusKm) || geometry.referenceRadiusKm <= 0))
      || (manifest.datum.referenceShape.kind === 'ellipsoid' && !geometry)) throw new Error('Ellipsoidal cube grids require explicit radial-lattice geometry');
    for (const [face, level, x, y, uncertaintyKm] of manifest.tiles) this.uncertaintyById.set(cubeTileId({ face, level, x, y }), uncertaintyKm);
    this.residentLevel = options.residentLevel ?? 2;
    this.retryFailedMs = options.retryFailedMs ?? 30_000;
    this.maxDetailTiles = options.maxDetailTiles ?? 2048;
    const resident = manifest.tiles.filter(t => t[1] <= this.residentLevel).map(([face, level, x, y]) => cubeTileId({ face, level, x, y }));
    this.ready = Promise.all(resident.map(id => this.load(id))).then(() => {
      if (resident.some(id => this.failed.has(id))) throw new Error('Cube grid resident levels failed to load');
    });
  }

  /** Fetch the manifest, then grids relative to it. */
  static async fromUrl(url: string, options: CubeGridSourceOptions & { fetch?: typeof fetch; retryBaseMs?: number; signal?: AbortSignal } = {}): Promise<CubeSphereGridSource> {
    const fetchImpl = options.fetch ?? fetch;
    const get = (u: string) => fetchWithRetry(u, {}, { fetchImpl, baseMs: options.retryBaseMs });
    // Without the manifest no grid can ever load, so it waits out an outage (as the tileset does).
    const response = await fetchWithRetry(url, { signal: options.signal }, { fetchImpl, baseMs: options.retryBaseMs, tries: Infinity });
    if (!response.ok) throw new Error(`Cube grid manifest ${url}: HTTP ${response.status}`);
    const manifest = await response.json() as CubeGridManifest;
    // A ray or pick can ask for hundreds of grids at once; unbounded, a browser on a
    // slower link refuses them (net::ERR_INSUFFICIENT_RESOURCES) and they stay failed.
    const limit = options.maxConcurrentRequests ?? 16, waiting: (() => void)[] = [];
    let active = 0;
    return new CubeSphereGridSource(manifest, async (uri) => {
      if (active < limit) active++; else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        const grid = await get(new URL(uri, new URL(url, globalThis.location?.href)).href);
        if (!grid.ok) throw new Error(`Cube grid ${uri}: HTTP ${grid.status}`);
        return await grid.arrayBuffer();
      } finally {
        const next = waiting.shift(); // hand the slot over
        if (next) next(); else active--;
      }
    }, options);
  }

  get stats(): CubeGridSourceStats {
    return { residentTiles: this.sampler.tileCount - this.detail.size, detailTiles: this.detail.size,
      requests: this.requests, bytes: this.bytes, failed: this.failed.size, inFlight: this.inFlight.size };
  }

  /** Deepest product tile containing a face coordinate (the product is REPLACE-complete, so one exists at level 0). */
  availableAt(coordinate: CubeFaceCoordinate): Address {
    for (let level = this.manifest.maxLevel; level >= 0; level--) {
      const address = addressAt(coordinate, level);
      if (this.uncertaintyById.has(cubeTileId(address))) return address;
    }
    return addressAt(coordinate, 0);
  }

  coverage(latDeg: number, lonDeg: number): CubeCoverage {
    const coordinate = this.sampler.faceCoordinate(latDeg, lonDeg);
    const available = this.availableAt(coordinate);
    const resident = this.sampler.finestResident(coordinate)?.tile;
    return {
      state: !resident ? 'unloaded' : resident.level >= available.level ? 'finest' : 'parent-fallback',
      availableLevel: available.level,
      residentLevel: resident?.level ?? null,
      residentTileId: resident ? cubeTileId(resident) : null,
    };
  }

  /** CPU sample from resident grids, requesting detail independently of rendering.
   * Null preserves genuinely unavailable resident coverage. */
  sample(latDeg: number, lonDeg: number): TerrainSample | null {
    void this.request(latDeg, lonDeg);
    if (this.manifest.geometry) {
      this.querySurface ??= new CubeGridSurface(this, '', 'body-fixed');
      return this.querySurface.sampleElevation(latDeg, lonDeg);
    }
    return this.sampler.sample(latDeg, lonDeg);
  }

  /** Load the product's tile chain at a point, down to its deepest level. */
  request(latDeg: number, lonDeg: number): Promise<void> {
    return this.requestCoordinate(this.sampler.faceCoordinate(latDeg, lonDeg));
  }

  requestCoordinate(coordinate: CubeFaceCoordinate): Promise<void> {
    const deepest = this.availableAt(coordinate).level;
    const loads: Promise<void>[] = [];
    // Intermediate levels too, so a coarse parent answers while the deepest tile is in flight;
    // resident levels as well, in case one failed at startup.
    const now = performance.now();
    for (let level = 0; level <= deepest; level++) {
      const address = addressAt(coordinate, level), id = cubeTileId(address);
      if (this.detail.has(id)) { this.detail.delete(id); this.detail.set(id, true); continue; }
      if (this.sampler.getTile(address) || (this.failed.get(id)?.retryAt ?? 0) > now) continue;
      loads.push(this.load(id));
    }
    return Promise.all(loads).then(() => undefined);
  }

  dispose(): void { this.disposed = true; }

  private load(id: string): Promise<void> {
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const address = ID_FIELDS(id);
    const { width, height, uri } = this.manifest.grid;
    const path = uri.replace('{face}', address.face).replace('{level}', String(address.level))
      .replace('{x}', String(address.x)).replace('{y}', String(address.y));
    this.requests++;
    const job = this.fetchGrid(path).then((buffer) => {
      if (this.disposed) return;
      if (buffer.byteLength !== width * height * 4) throw new Error(`Cube grid ${id}: expected ${width * height * 4} bytes, got ${buffer.byteLength}`);
      const view = new DataView(buffer);
      const elevationsKm = new Float64Array(width * height);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < elevationsKm.length; i++) {
        const km = view.getFloat32(i * 4, true) / 1000;
        if (!Number.isFinite(km)) throw new Error(`Cube grid ${id}: non-finite radial offset`);
        elevationsKm[i] = km;
        if (km < lo) lo = km;
        if (km > hi) hi = km;
      }
      this.bytes += buffer.byteLength;
      this.minHeightKm = Math.min(this.minHeightKm, lo);
      this.maxHeightKm = Math.max(this.maxHeightKm, hi);
      this.sampler.addTile({ ...address, width, height, elevationsKm, source: this.manifest.source, uncertaintyKm: this.uncertaintyById.get(id) });
      if (address.level > this.residentLevel) {
        this.detail.set(id, true);
        while (this.detail.size > this.maxDetailTiles) {
          const evicted = this.detail.keys().next().value!;
          this.detail.delete(evicted);
          this.sampler.removeTile(ID_FIELDS(evicted));
          this.querySurface?.invalidate(evicted);
          this.onChange?.(evicted);
        }
      }
      this.failed.delete(id);
      this.querySurface?.invalidate(id);
      this.onChange?.(id);
    }).catch((error: unknown) => {
      const count = (this.failed.get(id)?.count ?? 0) + 1;
      this.failed.set(id, { count, retryAt: performance.now() + this.retryFailedMs * 2 ** Math.min(count - 1, 4) });
      console.warn(`[Cosmolabe:Terrain] cube grid ${id} failed`, error);
    }).finally(() => { this.inFlight.delete(id); });
    this.inFlight.set(id, job);
    return job;
  }
}

function addressAt(coordinate: CubeFaceCoordinate, level: number): Address {
  const count = 2 ** level;
  const index = (value: number) => Math.min(count - 1, Math.floor((value + 1) * 0.5 * count));
  return { face: coordinate.face, level, x: index(coordinate.u), y: index(coordinate.v) };
}

// Point sampling uses one half-open address; ray intersections also need the
// other closed footprints at a tile edge, including incident cube faces.
const COORDINATE_ROUNDOFF = 32 * Number.EPSILON;
function touchingCoordinates(coordinate: CubeFaceCoordinate, maxLevel: number): CubeFaceCoordinate[] {
  const direction = cubeFaceToDirection(coordinate.face, coordinate.u, coordinate.v);
  const dot = (a: readonly number[]) => a[0] * direction[0] + a[1] * direction[1] + a[2] * direction[2];
  const result: CubeFaceCoordinate[] = [];
  const count = 2 ** maxLevel;
  const sides = (value: number) => {
    const grid = (value + 1) * count / 2;
    return Math.abs(grid - Math.round(grid)) <= COORDINATE_ROUNDOFF * count
      ? [...new Set([Math.max(-1, value - COORDINATE_ROUNDOFF * 2), Math.min(1, value + COORDINATE_ROUNDOFF * 2)])]
      : [value];
  };
  for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const) {
    const [n, uAxis, vAxis] = cubeFaceBasis(face), scale = dot(n);
    if (scale <= 0) continue;
    const u = dot(uAxis) / scale, v = dot(vAxis) / scale;
    if (Math.abs(u) > 1 + COORDINATE_ROUNDOFF || Math.abs(v) > 1 + COORDINATE_ROUNDOFF) continue;
    for (const a of sides(Math.max(-1, Math.min(1, u)))) for (const b of sides(Math.max(-1, Math.min(1, v)))) result.push({ face, u: a, v: b });
  }
  return result;
}

/** Whether a real triangle hit lies on this tile's closed outer footprint. */
function onTileBoundary(position: SurfaceHit['position'], tile: CubeHeightTile): boolean {
  const [n, uAxis, vAxis] = cubeFaceBasis(tile.face);
  const dot = (a: readonly number[]) => a[0] * position.xKm + a[1] * position.yKm + a[2] * position.zKm;
  const scale = dot(n), u = dot(uAxis) / scale, v = dot(vAxis) / scale;
  const count = 2 ** tile.level;
  return [u - (-1 + 2 * tile.x / count), u - (-1 + 2 * (tile.x + 1) / count),
    v - (-1 + 2 * tile.y / count), v - (-1 + 2 * (tile.y + 1) / count)].some(delta => Math.abs(delta) <= COORDINATE_ROUNDOFF);
}

/**
 * Cartesian triangles of one resident grid, exactly as the builder emits the
 * tile's .glb: vertex (i, j) at dyadic face coordinates, reference radius plus
 * stored radial offset along its geocentric direction, diagonal v00→v11.
 * For ellipsoidal products the payload's reference radius is distinct from
 * the public geodetic datum: the varying offsets encode the physical shape.
 */
export function cubeTileMesh(tile: CubeHeightTile, radiusKm: number): { positionsKm: Float64Array; indices: Uint32Array } {
  const { width: w, height: h } = tile;
  const positionsKm = new Float64Array(w * h * 3);
  const nu = (w - 1) * 2 ** tile.level, nv = (h - 1) * 2 ** tile.level;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const u = (2 * ((w - 1) * tile.x + i) - nu) / nu, v = (2 * ((h - 1) * tile.y + j) - nv) / nv;
    const d = cubeFaceToDirection(tile.face, u, v), r = radiusKm + tile.elevationsKm[j * w + i];
    positionsKm.set([d[0] * r, d[1] * r, d[2] * r], (j * w + i) * 3);
  }
  const indices = new Uint32Array((w - 1) * (h - 1) * 6);
  let k = 0;
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
    const a = j * w + i;
    indices.set([a, a + 1, a + w + 1, a, a + w + 1, a + w], k); k += 6;
  }
  return { positionsKm, indices };
}

/**
 * #148 ray-query port over whatever cube grids are resident: the smallest
 * Cartesian intersection the experiment needs for picking and camera clearance.
 * It marches the ray segment inside the shell of loaded heights in order (see
 * `march`) and intersects each finest resident tile it meets as the exact
 * triangles of its grid's full lattice (the .glb's own triangles, unless the product is simplified:
 * then they differ by up to the manifest's per-tile `renderedDeviationKm`).
 * Closed incident footprints retain real outer-edge support from ancestors
 * when no finest-owned triangle intersects. Point-sampling's half-open address
 * must not erase those boundaries. Coverage is declared partial: a hit is a provisional
 * nearest hit (coarse), and no hit is `unavailable`, never a miss — the march can
 * clip a tile corner, and unloaded detail could occlude.
 *
 * It is also the #148 `SurfaceQueryLoader` for itself: `ensureRayCoverage`
 * marches the same segment over the product's *available* tiles and loads the
 * finest along it, so `requestSurfaceIntersection(surface, ray, options, signal,
 * surface)` is one bounded load attempt, then a requery.
 */
export class CubeGridSurface implements PhysicalSurface, SurfaceQueryLoader {
  readonly metadata: PhysicalSurfaceMetadata;
  private readonly meshes = new Map<string, { tile: CubeHeightTile; surface: CpuMeshSurface }>();
  private readonly radiusKm: number;

  constructor(
    private readonly source: CubeSphereGridSource, bodyId: string, frame: string,
    private readonly maxTilesPerRay = 64, private readonly maxSteps = 8192,
  ) {
    const shape = source.manifest.datum.referenceShape;
    this.radiusKm = source.manifest.geometry?.referenceRadiusKm ?? (shape.kind === 'sphere' ? shape.radiusKm : NaN);
    if (!Number.isFinite(this.radiusKm)) throw new Error('CubeGridSurface requires an explicit radial lattice');
    this.metadata = { bodyId, frame, source: source.manifest.source, shape: { kind: 'globe', datum: source.manifest.datum }, coverage: 'partial-product' };
  }

  /** Forget a derived mesh when its grid changes or leaves. */
  invalidate(id: string): void { this.meshes.delete(id); }

  sampleElevation(latDeg: number, lonDeg: number): TerrainSample | null {
    if (!this.source.manifest.geometry) return this.source.sampler.sample(latDeg, lonDeg);
    // Validate coordinates and canonicalize poles/longitude before constructing a
    // normal ray. Intersect the Cartesian lattice, including its chord sag;
    // interpolating radial payload values would mislabel them as normal heights.
    this.source.sampler.faceCoordinate(latDeg, lonDeg);
    lonDeg = Math.abs(latDeg) === 90 ? 0 : wrapLon(lonDeg);
    const datum = this.source.manifest.datum;
    const shape = datum.referenceShape;
    const minRadius = shape.kind === 'sphere' ? shape.radiusKm : Math.min(...shape.radiiKm);
    const maxRadius = shape.kind === 'sphere' ? shape.radiusKm : Math.max(...shape.radiiKm);
    const [lo, hi] = this.source.manifest.heightRangeKm;
    const extent = maxRadius - minRadius + Math.max(Math.abs(lo), Math.abs(hi))
      + maxRadius - this.latticeInnerRadiusKm(lo) + 1;
    const zero = geodeticToBodyFixed({ latDeg, lonDeg }, datum);
    const above = geodeticToBodyFixed({ latDeg, lonDeg, heightKm: extent }, datum);
    for (const p of [zero, above]) {
      if (Math.abs(latDeg) === 90) { p.xKm = 0; p.yKm = 0; }
      else if (lonDeg === 0 || lonDeg === -180) p.yKm = 0;
      else if (Math.abs(lonDeg) === 90) p.xKm = 0;
    }
    const direction: SurfaceVector = [(zero.xKm - above.xKm) / extent, (zero.yKm - above.yKm) / extent, (zero.zKm - above.zKm) / extent];
    const ray: SurfaceRay = { origin: above, direction, nearKm: 0, farKm: 2 * extent };
    void this.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, new AbortController().signal);
    const hit = this.intersectRay(ray, { maxMeshErrorKm: 0 });
    if (hit.kind !== 'hit') return null;
    return { position: { latDeg, lonDeg: wrapLon(lonDeg) }, elevationKm: extent - hit.distanceKm,
      datum, source: hit.metadata.source, tileId: hit.tileId };
  }

  /**
   * The ray's interval inside the shell of the product's heights, or null when
   * it never enters it. The shell is the manifest's whole-product range (widened
   * by anything loaded beyond it), never just what is resident: coverage
   * loading must find terrain above or below every grid loaded so far.
   */
  private segment(ray: SurfaceRay, d: SurfaceVector): [number, number] | null {
    const [productMin, productMax] = this.source.manifest.heightRangeKm;
    const minHeightKm = Math.min(productMin, this.source.minHeightKm), maxHeightKm = Math.max(productMax, this.source.maxHeightKm);
    const o = [ray.origin.xKm, ray.origin.yKm, ray.origin.zKm];
    const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2], oo = o[0] * o[0] + o[1] * o[1] + o[2] * o[2];
    const roots = (r: number) => { const disc = b * b - (oo - r * r); return disc < 0 ? null : [-b - Math.sqrt(disc), -b + Math.sqrt(disc)]; };
    const outer = roots(this.radiusKm + maxHeightKm + 1e-6), inner = roots(this.latticeInnerRadiusKm(minHeightKm) - 1e-6);
    if (!outer) return null;
    const t0 = Math.max(ray.nearKm, outer[0]);
    const t1 = Math.min(ray.farKm, inner && inner[0] >= t0 ? inner[0] : outer[1]);
    return t1 < t0 ? null : [t0, t1];
  }

  /**
   * Flat triangles sag below their vertices by the chord: a level-0 cell's
   * diagonal (the widest) bounds how far below the lowest vertex sphere they reach.
   */
  private latticeInnerRadiusKm(minHeightKm: number): number {
    const halfDiagonal = Math.atan(Math.SQRT2 / (this.source.manifest.grid.width - 1));
    return (this.radiusKm + minHeightKm) * Math.cos(halfDiagonal);
  }

  /**
   * Radius, km, of a sphere no rendered surface triangle of this product dips
   * inside: the lowest product height less the widest cell's chord sag, and less
   * the largest simplified-mesh deviation when the .glb triangles are not the
   * lattice (a tile without one makes the bound useless: 0). A conservative
   * horizon occluder for the draw cull.
   */
  get renderedInnerRadiusKm(): number {
    // An ellipsoid-normal datum does not certify a sphere below the emitted
    // terrain. Keep frustum culling and disable the horizon test for now.
    if (this.source.manifest.datum.referenceShape.kind !== 'sphere') return 0;
    const { heightRangeKm, tiles, renderedMesh } = this.source.manifest;
    const deviationKm = renderedMesh ? tiles.reduce((m, t) => Math.max(m, t[5] ?? Infinity), 0) : 0;
    return Math.max(0, this.latticeInnerRadiusKm(Math.min(heightRangeKm[0], this.source.minHeightKm)) - deviationKm);
  }

  private point(ray: SurfaceRay, d: SurfaceVector, t: number): CubeFaceCoordinate {
    return directionToCubeFace([ray.origin.xKm + t * d[0], ray.origin.yKm + t * d[1], ray.origin.zKm + t * d[2]]);
  }

  /** An eighth of a level's face-centre tile width; gnomonic tiles shrink to about a third of it at corners. */
  private stepKm(level: number): number { return this.radiusKm * 2 / 2 ** level / 8; }

  /**
   * Tiles met along [t0, t1], in order: steps of an eighth of the current tile,
   * and wherever consecutive samples change tile, 15 more samples between them,
   * so a ray that crosses a sliver of a third tile (near a corner, or nearly
   * along a tile edge) still meets it. Yields null where `tileAt` has nothing.
   */
  private *march(ray: SurfaceRay, d: SurfaceVector, t0: number, t1: number,
    tileAt: (coordinate: CubeFaceCoordinate) => { id: string; level: number } | null,
  ): Generator<{ id: string; level: number; t: number } | null> {
    let previous: string | null = null, tPrevious = t0;
    for (let t = t0, step = 0; step < this.maxSteps; step++) {
      const here = tileAt(this.point(ray, d, t));
      if (!here) { yield null; return; }
      if (previous !== null && here.id !== previous) {
        for (let k = 1; k < 16; k++) {
          const tk = tPrevious + (t - tPrevious) * k / 16, between = tileAt(this.point(ray, d, tk));
          if (between && between.id !== previous && between.id !== here.id) yield { ...between, t: tk };
        }
      }
      yield { ...here, t };
      if (t >= t1) return;
      previous = here.id; tPrevious = t;
      t = Math.min(t1, t + this.stepKm(here.level));
    }
  }

  async ensureRayCoverage(ray: SurfaceRay, options: SurfaceQueryOptions, signal: AbortSignal): Promise<void> {
    const d = normalizedRay(ray, options);
    const segment = this.segment(ray, d);
    if (!segment) return;
    const loads: Promise<void>[] = [];
    const seen = new Set<string>();
    for (const step of this.march(ray, d, ...segment, (c) => { const a = this.source.availableAt(c); return { id: cubeTileId(a), level: a.level }; })) {
      signal.throwIfAborted();
      if (!step || seen.size >= this.maxTilesPerRay) break;
      for (const coordinate of touchingCoordinates(this.point(ray, d, step.t), this.source.manifest.maxLevel)) {
        const id = cubeTileId(this.source.availableAt(coordinate));
        if (seen.has(id)) continue;
        if (seen.size >= this.maxTilesPerRay) break;
        seen.add(id); loads.push(this.source.requestCoordinate(coordinate));
      }
    }
    await Promise.all(loads);
  }

  intersectRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection {
    const d = normalizedRay(ray, options);
    if (!Number.isFinite(this.source.minHeightKm)) return { kind: 'unavailable', reason: 'not-resident', metadata: this.metadata };
    const segment = this.segment(ray, d);
    if (!segment) return { kind: 'unavailable', reason: 'partial-coverage', metadata: this.metadata };
    const [t0, t1] = segment;
    const result: { best: SurfaceHit | null; boundary: SurfaceHit | null } = { best: null, boundary: null };
    const ancestors = new Map<string, CubeHeightTile>();
    const tiles = new Map<string, CubeHeightTile>();
    const discover = (c: CubeFaceCoordinate) => {
      for (const coordinate of touchingCoordinates(c, this.source.manifest.maxLevel)) {
        const tile = this.source.sampler.finestResident(coordinate)?.tile;
        if (!tile) continue;
        tiles.set(cubeTileId(tile), tile);
        // An ancestor's boundary is still a real lattice edge even when both
        // adjacent finest footprints have different source LOD heights.
        for (let level = tile.level - 1; level >= 0; level--) {
          const ancestor = this.source.sampler.getTile(addressAt(coordinate, level));
          if (ancestor) ancestors.set(cubeTileId(ancestor), ancestor);
        }
      }
    };
    const resident = (c: CubeFaceCoordinate) => {
      discover(c);
      const tile = this.source.sampler.finestResident(c)?.tile;
      return tile ? { id: cubeTileId(tile), level: tile.level } : null;
    };
    const tried = new Set<string>();
    const intersect = (id: string, tile: CubeHeightTile) => {
      if (tried.has(id) || tried.size >= this.maxTilesPerRay) return;
      tried.add(id);
      const mesh = this.mesh(id, tile);
      for (let near = t0, attempt = 0; attempt < 64; attempt++) {
        const hit = mesh.intersectRay({ ...ray, nearKm: near, farKm: result.best ? result.best.distanceKm : t1 }, options);
        if (hit.kind !== 'hit') break;
        const p = hit.position, coordinate = directionToCubeFace([p.xKm, p.yKm, p.zKm]);
        const owner = this.source.sampler.finestResident(coordinate)?.tile;
        discover(coordinate);
        if (!owner || owner.level <= tile.level) {
          result.best = { ...hit, tileId: id }; break;
        }
        // Never use a superseded interior. A closed outer boundary retains
        // actual triangle support if the finer lattices have no intersection.
        // Prefer a finest-owned hit whenever one exists, even over this edge.
        if (onTileBoundary(p, tile) && onTileBoundary(p, owner)
          && (!result.boundary || hit.distanceKm < result.boundary.distanceKm)) result.boundary = { ...hit, tileId: id };
        near = hit.distanceKm + 1e-9;
      }
    };
    for (const step of this.march(ray, d, t0, t1, resident)) {
      if (!step) return { kind: 'unavailable', reason: 'not-resident', metadata: this.metadata };
      if (result.best && step.t > result.best.distanceKm) break;
      // Map iteration also visits owners discovered at a rejected hit, so the
      // handoff does not depend on the march happening to sample that tile.
      for (const [id, tile] of tiles) intersect(id, tile);
    }
    if (!result.best) {
      for (const [id, tile] of ancestors) {
        intersect(id, tile);
        for (const [ownerId, owner] of tiles) intersect(ownerId, owner);
      }
    }
    return result.best ?? result.boundary ?? { kind: 'unavailable', reason: 'partial-coverage', metadata: this.metadata };
  }

  private mesh(id: string, tile: CubeHeightTile): CpuMeshSurface {
    let entry = this.meshes.get(id);
    if (!entry || entry.tile !== tile) {
      // The grid's uncertainty is a sampled representation error, neither a
      // validated mesh bound nor source uncertainty, so both stay unknown here.
      entry = { tile, surface: new CpuMeshSurface({ ...this.metadata, source: tile.source ?? this.metadata.source },
        cubeTileMesh(tile, this.radiusKm), { meshDeviationBoundKm: null }) };
      this.meshes.set(id, entry);
    }
    return entry.surface;
  }
}
