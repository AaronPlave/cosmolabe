/** Renderer-independent terrain datum and CPU sampling primitives. All lengths are km. */
export type VerticalDatum = 'ellipsoid' | 'reference-sphere' | 'areoid' | 'unknown';
export type HeightConvention = 'radial' | 'geodetic-normal';

export interface TerrainDatum {
  /** The physical reference shape; this is deliberately never a display radius. */
  referenceShape: { kind: 'sphere'; radiusKm: number } | { kind: 'ellipsoid'; radiiKm: readonly [number, number, number] };
  verticalDatum: VerticalDatum;
  heightConvention: HeightConvention;
}

export interface TerrainSourceMetadata {
  id: string;
  kind: 'quantized-mesh' | 'height-grid' | 'imagery' | 'unknown';
  url?: string;
  uncertaintyKm?: number;
}

export interface BodyFixedPosition { latDeg: number; lonDeg: number; heightKm?: number; }
export interface BodyFixedCartesian { xKm: number; yKm: number; zKm: number; }
export interface TerrainSample {
  position: BodyFixedPosition;
  elevationKm: number;
  /** Unit surface normal in the tile-local east/north/up frame at the sample. */
  normal?: readonly [number, number, number];
  datum: TerrainDatum;
  source: TerrainSourceMetadata;
  uncertaintyKm?: number;
}

/** Geographic bounds shared by every decoded CPU tile. */
interface TerrainTileBounds {
  id: string;
  westDeg: number;
  eastDeg: number;
  southDeg: number;
  northDeg: number;
  source?: TerrainSourceMetadata;
  uncertaintyKm?: number;
}

/** A decoded regular height raster. Rows run south→north and columns west→east. */
export interface TerrainHeightTile extends TerrainTileBounds {
  kind?: 'grid';
  width: number;
  height: number;
  elevationsKm: Float32Array | Float64Array;
}

/**
 * A decoded triangulated irregular network (TIN) — the representation
 * quantized-mesh actually uses. Vertices are scattered, NOT a U×V product, so
 * elevation comes from barycentric interpolation inside the containing triangle.
 */
export interface TerrainMeshTile extends TerrainTileBounds {
  kind: 'mesh';
  /** Tile-local normalized coordinates: u west→east, v south→north, both [0,1]. */
  u: Float32Array;
  v: Float32Array;
  /** Per-vertex elevation, already corrected onto the sampler's datum. */
  elevationsKm: Float32Array | Float64Array;
  /** Triangle corner indices; length is triangleCount * 3. */
  indices: Uint16Array | Uint32Array;
}

export type TerrainTile = TerrainHeightTile | TerrainMeshTile;

export interface TerrainSamplerDiagnostics {
  tileCount: number;
  sampleCount: number;
  lastSampleMicros: number;
  state: 'ready' | 'unloaded';
}

const DEG = Math.PI / 180;
const wrapLon = (lon: number) => ((lon + 180) % 360 + 360) % 360 - 180;

/** Convert geodetic body-fixed coordinates to conventional Z-up ECEF. */
export function geodeticToBodyFixed(position: BodyFixedPosition, datum: TerrainDatum): BodyFixedCartesian {
  const lat = position.latDeg * DEG, lon = position.lonDeg * DEG, h = position.heightKm ?? 0;
  if (datum.referenceShape.kind === 'sphere') {
    const r = datum.referenceShape.radiusKm + h;
    return { xKm: r * Math.cos(lat) * Math.cos(lon), yKm: r * Math.cos(lat) * Math.sin(lon), zKm: r * Math.sin(lat) };
  }
  const [a,, c] = datum.referenceShape.radiiKm;
  const e2 = 1 - (c * c) / (a * a);
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return { xKm: (n + h) * Math.cos(lat) * Math.cos(lon), yKm: (n + h) * Math.cos(lat) * Math.sin(lon), zKm: (n * (1 - e2) + h) * Math.sin(lat) };
}

/** Convert conventional Z-up ECEF to geodetic body-fixed coordinates. */
export function bodyFixedToGeodetic(point: BodyFixedCartesian, datum: TerrainDatum): BodyFixedPosition {
  const lonDeg = Math.atan2(point.yKm, point.xKm) / DEG;
  const p = Math.hypot(point.xKm, point.yKm);
  if (datum.referenceShape.kind === 'sphere') {
    const r = Math.hypot(p, point.zKm);
    return { latDeg: Math.atan2(point.zKm, p) / DEG, lonDeg, heightKm: r - datum.referenceShape.radiusKm };
  }
  const [a,, c] = datum.referenceShape.radiiKm;
  const e2 = 1 - (c * c) / (a * a);
  let lat = Math.atan2(point.zKm, p * (1 - e2));
  for (let i = 0; i < 8; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(point.zKm + e2 * n * Math.sin(lat), p);
  }
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  // `p / cos(lat)` degenerates at the poles, where p → 0 and cos(lat) → 0 and
  // the quotient loses the entire radius. Switch to the z-axis form there.
  const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
  const heightKm = Math.abs(cosLat) > 1e-6
    ? p / cosLat - n
    : Math.abs(point.zKm) / Math.max(Math.abs(sinLat), 1e-12) - n * (1 - e2);
  return { latDeg: lat / DEG, lonDeg, heightKm };
}

/** Derived per-tile data kept alongside the caller's tile, computed once on insert. */
interface CachedTile {
  tile: TerrainTile;
  /** Wrapped west edge and positive eastward span, so longitude math is allocation-free. */
  westDeg: number;
  lonSpanDeg: number;
  latSpanDeg: number;
  /** Angular footprint; the smallest tile covering a point is the most detailed one. */
  areaDeg2: number;
  /** CSR triangle bins over the unit uv square. Mesh tiles only. */
  binsPerAxis: number;
  binStart: Uint32Array | null;
  binTris: Uint32Array | null;
}

const BIN_TARGET_TRIS = 8;
const MAX_BINS_PER_AXIS = 32;

export class TerrainSampler {
  private readonly tiles = new Map<string, CachedTile>();
  private _sampleCount = 0;
  private _lastSampleMicros = 0;

  constructor(readonly datum: TerrainDatum, readonly source: TerrainSourceMetadata, private readonly maxTiles = 256) {}

  addTile(tile: TerrainTile): void {
    const latSpanDeg = tile.northDeg - tile.southDeg;
    if (!(latSpanDeg > 0)) {
      throw new Error(`Terrain tile ${tile.id} has a non-positive latitude span`);
    }
    // A zero-width longitude span is degenerate and cannot be told apart from a
    // full-globe tile once wrapped, so require a global tile to span a real ±180.
    const rawLonSpan = tile.eastDeg - tile.westDeg;
    if (rawLonSpan === 0) {
      throw new Error(`Terrain tile ${tile.id} has a zero longitude span`);
    }
    const lonSpanDeg = rawLonSpan > 0 ? rawLonSpan : rawLonSpan + 360;
    if (!(lonSpanDeg > 0) || lonSpanDeg > 360) {
      throw new Error(`Terrain tile ${tile.id} has an invalid longitude span`);
    }

    const cached: CachedTile = {
      tile,
      westDeg: wrapLon(tile.westDeg),
      lonSpanDeg,
      latSpanDeg,
      areaDeg2: lonSpanDeg * latSpanDeg,
      binsPerAxis: 0,
      binStart: null,
      binTris: null,
    };

    if (tile.kind === 'mesh') {
      if (tile.u.length < 3 || tile.u.length !== tile.v.length || tile.u.length !== tile.elevationsKm.length) {
        throw new Error(`Terrain mesh tile ${tile.id} has mismatched vertex arrays`);
      }
      if (tile.indices.length < 3 || tile.indices.length % 3 !== 0) {
        throw new Error(`Terrain mesh tile ${tile.id} has a malformed index buffer`);
      }
      this.buildTriangleBins(cached, tile);
    } else if (tile.width < 2 || tile.height < 2 || tile.elevationsKm.length !== tile.width * tile.height) {
      throw new Error(`Terrain tile ${tile.id} is not a rectangular height grid`);
    }

    this.tiles.delete(tile.id);
    this.tiles.set(tile.id, cached);
    while (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value!);
  }

  removeTile(id: string): void { this.tiles.delete(id); }
  clear(): void { this.tiles.clear(); }

  sample(latDeg: number, lonDeg: number, deriveNormal = false): TerrainSample | null {
    const start = performance.now();
    const lon = wrapLon(lonDeg);
    const cached = this.findTile(latDeg, lon);
    let result: TerrainSample | null = null;
    if (cached) {
      const u = this.longitudeFraction(cached, lon);
      const v = Math.max(0, Math.min(1, (latDeg - cached.tile.southDeg) / cached.latSpanDeg));
      const elevationKm = cached.tile.kind === 'mesh'
        ? this.sampleMesh(cached, u, v)
        : this.sampleGrid(cached.tile, u, v);
      if (elevationKm != null) {
        const tile = cached.tile;
        result = {
          position: { latDeg, lonDeg: lon }, elevationKm,
          datum: this.datum, source: tile.source ?? this.source,
          uncertaintyKm: tile.uncertaintyKm ?? tile.source?.uncertaintyKm ?? this.source.uncertaintyKm,
        };
        if (deriveNormal) {
          const normal = this.deriveNormal(cached, latDeg, u, v);
          if (normal) result.normal = normal;
        }
      }
    }
    this._sampleCount++;
    this._lastSampleMicros = (performance.now() - start) * 1000;
    return result;
  }

  sampleBodyFixed(position: BodyFixedPosition, deriveNormal = false): TerrainSample | null {
    return this.sample(position.latDeg, position.lonDeg, deriveNormal);
  }

  sampleBodyFixedCartesian(point: BodyFixedCartesian, deriveNormal = false): TerrainSample | null {
    const position = bodyFixedToGeodetic(point, this.datum);
    return this.sample(position.latDeg, position.lonDeg, deriveNormal);
  }

  get diagnostics(): TerrainSamplerDiagnostics {
    return { tileCount: this.tiles.size, sampleCount: this._sampleCount, lastSampleMicros: this._lastSampleMicros, state: this.tiles.size ? 'ready' : 'unloaded' };
  }

  /** Physical datum radius at latitude, independent of any renderer display scale. */
  referenceRadiusAt(latDeg: number): number { return this.radiusAtLat(latDeg); }

  /**
   * Pick the most detailed tile covering the point. Overlapping tiles are
   * resolved by angular footprint — within one quadtree-tiled source a smaller
   * footprint is strictly a deeper level — rather than by insertion order,
   * which says nothing about detail. Ties keep the most recent insert.
   */
  private findTile(lat: number, lon: number): CachedTile | undefined {
    let best: CachedTile | undefined;
    let bestArea = Infinity;
    for (const cached of this.tiles.values()) {
      if (lat < cached.tile.southDeg || lat > cached.tile.northDeg) continue;
      const f = this.longitudeFraction(cached, lon);
      if (f < 0 || f > 1) continue;
      if (cached.areaDeg2 <= bestArea) { bestArea = cached.areaDeg2; best = cached; }
    }
    return best;
  }

  /** Fraction across the tile west→east. Outside [0,1] means the tile does not cover `lon`. */
  private longitudeFraction(cached: CachedTile, lon: number): number {
    return ((lon - cached.westDeg + 360) % 360) / cached.lonSpanDeg;
  }

  private sampleGrid(tile: TerrainHeightTile, u: number, v: number): number {
    const x = u * (tile.width - 1), y = v * (tile.height - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(tile.width - 1, x0 + 1), y1 = Math.min(tile.height - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;
    const at = (ix: number, iy: number) => tile.elevationsKm[iy * tile.width + ix];
    const a = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
    const b = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
    return a * (1 - ty) + b * ty;
  }

  /**
   * Barycentric lookup in the TIN. Returns null when the point falls in a hole
   * in the triangulation, which is a real answer — the tile has no surface there.
   */
  private sampleMesh(cached: CachedTile, u: number, v: number): number | null {
    const tile = cached.tile as TerrainMeshTile;
    const { indices, u: tu, v: tv, elevationsKm } = tile;
    const n = cached.binsPerAxis;
    const binStart = cached.binStart!, binTris = cached.binTris!;
    const bx = Math.max(0, Math.min(n - 1, Math.floor(u * n)));
    const by = Math.max(0, Math.min(n - 1, Math.floor(v * n)));

    // Exact containment first; if the point lands in a crack between triangles
    // (or just outside the hull at a tile edge) fall back to the nearest
    // triangle in the 3×3 bin neighbourhood, scored by least-negative barycentric.
    let bestScore = -Infinity;
    let bestHeight: number | null = null;
    for (let dy = 0; dy <= 2; dy++) {
      const yy = by + dy - 1;
      if (yy < 0 || yy >= n) continue;
      for (let dx = 0; dx <= 2; dx++) {
        const xx = bx + dx - 1;
        if (xx < 0 || xx >= n) continue;
        const bin = yy * n + xx;
        for (let k = binStart[bin]; k < binStart[bin + 1]; k++) {
          const t = binTris[k] * 3;
          const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
          const u0 = tu[i0], v0 = tv[i0], u1 = tu[i1], v1 = tv[i1], u2 = tu[i2], v2 = tv[i2];
          const det = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
          if (Math.abs(det) < 1e-14) continue;
          const a = ((v1 - v2) * (u - u2) + (u2 - u1) * (v - v2)) / det;
          const b = ((v2 - v0) * (u - u2) + (u0 - u2) * (v - v2)) / det;
          const c = 1 - a - b;
          const score = Math.min(a, b, c);
          if (score > bestScore) {
            bestScore = score;
            bestHeight = a * elevationsKm[i0] + b * elevationsKm[i1] + c * elevationsKm[i2];
            if (score >= 0) return bestHeight;
          }
        }
      }
    }
    // Accept a near miss (numerical edge case), reject a genuine hole.
    return bestScore > -1e-3 ? bestHeight : null;
  }

  /** Bucket triangles into a uniform CSR grid over the unit uv square. */
  private buildTriangleBins(cached: CachedTile, tile: TerrainMeshTile): void {
    const triCount = tile.indices.length / 3;
    const n = Math.max(1, Math.min(MAX_BINS_PER_AXIS, Math.ceil(Math.sqrt(triCount / BIN_TARGET_TRIS))));
    const binCount = n * n;
    const counts = new Uint32Array(binCount + 1);
    const { indices, u, v } = tile;

    const bounds = (t: number) => {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      const x0 = Math.max(0, Math.min(n - 1, Math.floor(Math.min(u[i0], u[i1], u[i2]) * n)));
      const x1 = Math.max(0, Math.min(n - 1, Math.floor(Math.max(u[i0], u[i1], u[i2]) * n)));
      const y0 = Math.max(0, Math.min(n - 1, Math.floor(Math.min(v[i0], v[i1], v[i2]) * n)));
      const y1 = Math.max(0, Math.min(n - 1, Math.floor(Math.max(v[i0], v[i1], v[i2]) * n)));
      return [x0, x1, y0, y1] as const;
    };

    for (let t = 0; t < triCount; t++) {
      const [x0, x1, y0, y1] = bounds(t);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) counts[y * n + x + 1]++;
    }
    for (let i = 0; i < binCount; i++) counts[i + 1] += counts[i];
    const binTris = new Uint32Array(counts[binCount]);
    const cursor = counts.slice(0, binCount);
    for (let t = 0; t < triCount; t++) {
      const [x0, x1, y0, y1] = bounds(t);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) binTris[cursor[y * n + x]++] = t;
    }

    cached.binsPerAxis = n;
    cached.binStart = counts;
    cached.binTris = binTris;
  }

  /**
   * Unit normal in the tile-local east/north/up frame: +x east, +y north,
   * +z away from the body centre. Derived from the local height slope, so it
   * describes the terrain surface, not the datum.
   */
  private deriveNormal(cached: CachedTile, latDeg: number, u: number, v: number): readonly [number, number, number] | null {
    const radius = this.radiusAtLat(latDeg);
    const eastKmPerU = Math.max(radius * Math.cos(latDeg * DEG) * cached.lonSpanDeg * DEG, 1e-9);
    const northKmPerV = Math.max(radius * cached.latSpanDeg * DEG, 1e-9);
    // Central difference in normalized tile space, one cell wide on either side.
    const stepU = cached.tile.kind === 'mesh' ? 1 / 64 : 1 / (cached.tile.width - 1);
    const stepV = cached.tile.kind === 'mesh' ? 1 / 64 : 1 / (cached.tile.height - 1);
    const h = (uu: number, vv: number) => {
      const cu = Math.max(0, Math.min(1, uu)), cv = Math.max(0, Math.min(1, vv));
      return cached.tile.kind === 'mesh' ? this.sampleMesh(cached, cu, cv) : this.sampleGrid(cached.tile, cu, cv);
    };
    const hE = h(u + stepU, v), hW = h(u - stepU, v), hN = h(u, v + stepV), hS = h(u, v - stepV);
    if (hE == null || hW == null || hN == null || hS == null) return null;
    const dhEast = (hE - hW) / (Math.min(1, u + stepU) - Math.max(0, u - stepU)) / eastKmPerU;
    const dhNorth = (hN - hS) / (Math.min(1, v + stepV) - Math.max(0, v - stepV)) / northKmPerV;
    const length = Math.hypot(dhEast, dhNorth, 1);
    return [-dhEast / length, -dhNorth / length, 1 / length];
  }

  private radiusAtLat(latDeg: number): number {
    if (this.datum.referenceShape.kind === 'sphere') return this.datum.referenceShape.radiusKm;
    const [a,, c] = this.datum.referenceShape.radiiKm;
    const lat = latDeg * DEG;
    return (a * c) / Math.sqrt(c * c * Math.cos(lat) ** 2 + a * a * Math.sin(lat) ** 2);
  }
}
