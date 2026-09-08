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
  normal?: readonly [number, number, number];
  datum: TerrainDatum;
  source: TerrainSourceMetadata;
  uncertaintyKm?: number;
}

/** A decoded CPU height tile. Rows run south→north and columns west→east. */
export interface TerrainHeightTile {
  id: string;
  westDeg: number;
  eastDeg: number;
  southDeg: number;
  northDeg: number;
  width: number;
  height: number;
  elevationsKm: Float32Array | Float64Array;
  source?: TerrainSourceMetadata;
  uncertaintyKm?: number;
}

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
  return { latDeg: lat / DEG, lonDeg, heightKm: p / Math.cos(lat) - n };
}

/**
 * Bounded CPU terrain cache. It has no Three.js dependency: renderers feed it
 * decoded height grids as tiles load, while collision, picks and UI share the
 * same deterministic bilinear query.
 */
export class TerrainSampler {
  private readonly tiles = new Map<string, TerrainHeightTile>();
  private _sampleCount = 0;
  private _lastSampleMicros = 0;

  constructor(readonly datum: TerrainDatum, readonly source: TerrainSourceMetadata, private readonly maxTiles = 256) {}

  addTile(tile: TerrainHeightTile): void {
    if (tile.width < 2 || tile.height < 2 || tile.elevationsKm.length !== tile.width * tile.height) {
      throw new Error(`Terrain tile ${tile.id} is not a rectangular height grid`);
    }
    this.tiles.delete(tile.id);
    this.tiles.set(tile.id, tile);
    while (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value!);
  }

  removeTile(id: string): void { this.tiles.delete(id); }
  clear(): void { this.tiles.clear(); }

  sample(latDeg: number, lonDeg: number, deriveNormal = false): TerrainSample | null {
    const start = performance.now();
    const lon = wrapLon(lonDeg);
    const tile = this.findTile(latDeg, lon);
    let result: TerrainSample | null = null;
    if (tile) {
      const u = this.longitudeFraction(tile, lon);
      const v = Math.max(0, Math.min(1, (latDeg - tile.southDeg) / (tile.northDeg - tile.southDeg)));
      const x = u * (tile.width - 1), y = v * (tile.height - 1);
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const x1 = Math.min(tile.width - 1, x0 + 1), y1 = Math.min(tile.height - 1, y0 + 1);
      const tx = x - x0, ty = y - y0;
      const at = (ix: number, iy: number) => tile.elevationsKm[iy * tile.width + ix];
      const a = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
      const b = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
      result = {
        position: { latDeg, lonDeg: lon }, elevationKm: a * (1 - ty) + b * ty,
        datum: this.datum, source: tile.source ?? this.source,
        uncertaintyKm: tile.uncertaintyKm ?? tile.source?.uncertaintyKm ?? this.source.uncertaintyKm,
      };
      if (deriveNormal) result.normal = this.deriveNormal(tile, latDeg, lon, at);
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

  private findTile(lat: number, lon: number): TerrainHeightTile | undefined {
    // Last inserted wins, so a detailed regional tile naturally overrides overview data.
    return [...this.tiles.values()].reverse().find(t => lat >= t.southDeg && lat <= t.northDeg && this.longitudeFraction(t, lon) >= 0 && this.longitudeFraction(t, lon) <= 1);
  }

  private longitudeFraction(tile: TerrainHeightTile, lon: number): number {
    const west = wrapLon(tile.westDeg), east = wrapLon(tile.eastDeg);
    const span = (east - west + 360) % 360 || 360;
    return ((lon - west + 360) % 360) / span;
  }

  private deriveNormal(tile: TerrainHeightTile, lat: number, lon: number, at: (x: number, y: number) => number): readonly [number, number, number] {
    const u = this.longitudeFraction(tile, lon) * (tile.width - 1);
    const v = Math.max(0, Math.min(tile.height - 1, (lat - tile.southDeg) / (tile.northDeg - tile.southDeg) * (tile.height - 1)));
    const x = Math.round(u), y = Math.round(v);
    const dhLon = at(Math.min(tile.width - 1, x + 1), y) - at(Math.max(0, x - 1), y);
    const dhLat = at(x, Math.min(tile.height - 1, y + 1)) - at(x, Math.max(0, y - 1));
    const radius = this.radiusAtLat(lat);
    const eastScale = Math.max(radius * Math.cos(lat * DEG) * ((tile.eastDeg - tile.westDeg) * DEG / (tile.width - 1)) * 2, 1e-9);
    const northScale = Math.max(radius * ((tile.northDeg - tile.southDeg) * DEG / (tile.height - 1)) * 2, 1e-9);
    const ex = -dhLon / eastScale, ny = -dhLat / northScale;
    const length = Math.hypot(ex, ny, 1);
    return [ex / length, ny / length, 1 / length];
  }

  private radiusAtLat(latDeg: number): number {
    if (this.datum.referenceShape.kind === 'sphere') return this.datum.referenceShape.radiusKm;
    const [a,, c] = this.datum.referenceShape.radiiKm;
    const lat = latDeg * DEG;
    return (a * c) / Math.sqrt(c * c * Math.cos(lat) ** 2 + a * a * Math.sin(lat) ** 2);
  }
}
