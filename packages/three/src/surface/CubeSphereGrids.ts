import type { TerrainDatum, TerrainSample, TerrainSourceMetadata } from '../TerrainSampler.js';
import { CpuMeshSurface } from './CpuMeshSurface.js';
import {
  CubeSphereSampler, cubeFaceToDirection, cubeTileId, directionToCubeFace,
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
  source: TerrainSourceMetadata;
  grid: { width: number; height: number; uri: string };
  /**
   * `[min, max]` of every height in the product (km, padded outward): a
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
  private readonly failedIds = new Set<string>();
  private readonly residentLevel: number;
  private readonly maxDetailTiles: number;
  private requests = 0;
  private bytes = 0;
  private disposed = false;
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
    this.sampler = new CubeSphereSampler(manifest.datum, manifest.source);
    for (const [face, level, x, y, uncertaintyKm] of manifest.tiles) this.uncertaintyById.set(cubeTileId({ face, level, x, y }), uncertaintyKm);
    this.residentLevel = options.residentLevel ?? 2;
    this.maxDetailTiles = options.maxDetailTiles ?? 2048;
    const resident = manifest.tiles.filter(t => t[1] <= this.residentLevel).map(([face, level, x, y]) => cubeTileId({ face, level, x, y }));
    this.ready = Promise.all(resident.map(id => this.load(id))).then(() => {
      if (resident.some(id => this.failedIds.has(id))) throw new Error('Cube grid resident levels failed to load');
    });
  }

  /** Fetch the manifest, then grids relative to it. */
  static async fromUrl(url: string, options: CubeGridSourceOptions & { fetch?: typeof fetch } = {}): Promise<CubeSphereGridSource> {
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Cube grid manifest ${url}: HTTP ${response.status}`);
    const manifest = await response.json() as CubeGridManifest;
    return new CubeSphereGridSource(manifest, async (uri) => {
      const grid = await fetchImpl(new URL(uri, new URL(url, globalThis.location?.href)).href);
      if (!grid.ok) throw new Error(`Cube grid ${uri}: HTTP ${grid.status}`);
      return grid.arrayBuffer();
    }, options);
  }

  get stats(): CubeGridSourceStats {
    return { residentTiles: this.sampler.tileCount - this.detail.size, detailTiles: this.detail.size,
      requests: this.requests, bytes: this.bytes, failed: this.failedIds.size, inFlight: this.inFlight.size };
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

  /** CPU sample from whatever is resident now, and a request for the finest tile there. Null only when nothing is resident. */
  sample(latDeg: number, lonDeg: number): TerrainSample | null {
    void this.request(latDeg, lonDeg);
    return this.sampler.sample(latDeg, lonDeg);
  }

  /** Load the product's tile chain at a point, down to its deepest level. */
  request(latDeg: number, lonDeg: number): Promise<void> {
    return this.requestCoordinate(this.sampler.faceCoordinate(latDeg, lonDeg));
  }

  requestCoordinate(coordinate: CubeFaceCoordinate): Promise<void> {
    const deepest = this.availableAt(coordinate).level;
    const loads: Promise<void>[] = [];
    // Intermediate levels too, so a coarse parent answers while the deepest tile is in flight.
    for (let level = this.residentLevel + 1; level <= deepest; level++) {
      const id = cubeTileId(addressAt(coordinate, level));
      if (this.detail.has(id)) { this.detail.delete(id); this.detail.set(id, true); continue; }
      if (!this.failedIds.has(id)) loads.push(this.load(id));
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
      const elevationsKm = new Float32Array(width * height);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < elevationsKm.length; i++) {
        const km = view.getFloat32(i * 4, true) / 1000;
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
          this.onChange?.(evicted);
        }
      }
      this.onChange?.(id);
    }).catch((error: unknown) => {
      this.failedIds.add(id);
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

/**
 * Cartesian triangles of one resident grid, exactly as the builder emits the
 * tile's .glb: vertex (i, j) at dyadic face coordinates, radius datum + height
 * along its geocentric direction, and the lattice diagonal v00→v11. Spheres only:
 * the builder writes radial heights on a reference sphere.
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
 * then they differ by up to the manifest's per-tile `renderedDeviationKm`), stopping once past the nearest hit. Coverage is declared partial: a hit is a provisional
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
    if (shape.kind !== 'sphere') throw new Error('CubeGridSurface: the builder emits radial heights on a sphere only');
    this.radiusKm = shape.radiusKm;
    this.metadata = { bodyId, frame, source: source.manifest.source, shape: { kind: 'globe', datum: source.manifest.datum }, coverage: 'partial-product' };
  }

  /** Forget a derived mesh when its grid changes or leaves. */
  invalidate(id: string): void { this.meshes.delete(id); }

  sampleElevation(latDeg: number, lonDeg: number): TerrainSample | null { return this.source.sampler.sample(latDeg, lonDeg); }

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
    // Flat triangles sag below their vertices by the chord: a level-0 cell's
    // diagonal (the widest) bounds how far below the lowest vertex sphere they reach.
    const halfDiagonal = Math.atan(Math.SQRT2 / (this.source.manifest.grid.width - 1));
    const outer = roots(this.radiusKm + maxHeightKm + 1e-6), inner = roots((this.radiusKm + minHeightKm) * Math.cos(halfDiagonal) - 1e-6);
    if (!outer) return null;
    const t0 = Math.max(ray.nearKm, outer[0]);
    const t1 = Math.min(ray.farKm, inner && inner[0] >= t0 ? inner[0] : outer[1]);
    return t1 < t0 ? null : [t0, t1];
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
      if (!seen.has(step.id)) { seen.add(step.id); loads.push(this.source.requestCoordinate(this.point(ray, d, step.t))); }
    }
    await Promise.all(loads);
  }

  intersectRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection {
    const d = normalizedRay(ray, options);
    if (!Number.isFinite(this.source.minHeightKm)) return { kind: 'unavailable', reason: 'not-resident', metadata: this.metadata };
    const segment = this.segment(ray, d);
    if (!segment) return { kind: 'unavailable', reason: 'partial-coverage', metadata: this.metadata };
    const [t0, t1] = segment;
    let best: SurfaceHit | null = null;
    const tiles = new Map<string, CubeHeightTile>();
    const resident = (c: CubeFaceCoordinate) => {
      const tile = this.source.sampler.finestResident(c)?.tile;
      if (!tile) return null;
      const id = cubeTileId(tile);
      tiles.set(id, tile);
      return { id, level: tile.level };
    };
    const tried = new Set<string>();
    for (const step of this.march(ray, d, t0, t1, resident)) {
      if (!step) return { kind: 'unavailable', reason: 'not-resident', metadata: this.metadata };
      if (best && step.t > best.distanceKm) break;
      if (tried.has(step.id)) continue;
      if (tried.size >= this.maxTilesPerRay) break;
      tried.add(step.id);
      const tile = tiles.get(step.id)!, mesh = this.mesh(step.id, tile);
      // A tile answers only where no finer resident tile owns the surface: a
      // parent's mesh still spans its children's ground. A superseded hit is
      // skipped and the search continues along the same mesh, and on to the
      // finer tiles the march meets.
      for (let near = t0, attempt = 0; attempt < 64; attempt++) {
        const hit = mesh.intersectRay({ ...ray, nearKm: near, farKm: best ? best.distanceKm : t1 }, options);
        if (hit.kind !== 'hit') break;
        const p = hit.position, owner = this.source.sampler.finestResident(directionToCubeFace([p.xKm, p.yKm, p.zKm]))?.tile;
        if (!owner || owner.level <= tile.level) { best = { ...hit, tileId: step.id }; break; }
        near = hit.distanceKm + 1e-9;
      }
    }
    return best ?? { kind: 'unavailable', reason: 'partial-coverage', metadata: this.metadata };
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
