/**
 * Fusion debug fields (#135): the coarse base / residual / weight / coverage
 * grid `scripts/terrain/dem.py` writes next to a fused pyramid as
 * `fusion-fields.bin`, described by `terrain-product.json` → `debugFields`.
 * Diagnostic only — heights never come from here.
 */
import { geographicTileBounds, type GeoBounds, type TileKey } from './TerrainValidation.js';

export interface FusionFieldsGrid {
  /** [west, south, east, north] degrees. */
  bounds: [number, number, number, number];
  width: number;
  height: number;
}

interface FieldEntry { name: string; type: 'float32' | 'uint8'; offset: number; scale?: number; }

export interface DebugFieldsDescription {
  path: string;
  byteLength: number;
  byteOrder: 'little-endian';
  grid: FusionFieldsGrid & { rowOrder: 'north-to-south' };
  fields: FieldEntry[];
}

/** Mean/extreme field values over a tile footprint; `null` where the footprint misses the grid. */
export interface FusionTileStats {
  meanResidualM: number;
  meanWeight: number;
  /** Any cell with 0 < coverage < 1: the footprint touches the detail DEM's edge. */
  touchesCoverageEdge: boolean;
  /** Any cell with 0 < weight < 1: the footprint touches the taper band. */
  touchesBlend: boolean;
  /** Every cell in the footprint is fully detail (weight 1). */
  allDetail: boolean;
}

export class FusionFields {
  /** Largest |residual| on the grid (m); the diverging scale for the residual view. */
  readonly maxAbsResidualM: number;
  private readonly cache = new Map<string, FusionTileStats | null>();

  constructor(
    readonly grid: FusionFieldsGrid,
    readonly baseM: Float32Array,
    readonly residualM: Float32Array,
    /** 0..1 */
    readonly weight: Float32Array,
    /** 0..1 */
    readonly coverage: Float32Array,
  ) {
    let m = 0;
    for (let i = 0; i < residualM.length; i++) m = Math.max(m, Math.abs(residualM[i]));
    this.maxAbsResidualM = m;
  }

  /** Decode `fusion-fields.bin` using the layout in `terrain-product.json`. */
  static parse(desc: DebugFieldsDescription, buffer: ArrayBuffer): FusionFields {
    const { width, height } = desc.grid;
    const n = width * height;
    if (desc.byteOrder !== 'little-endian' || desc.grid.rowOrder !== 'north-to-south') {
      throw new Error('fusion fields: unsupported layout');
    }
    if (buffer.byteLength < desc.byteLength) throw new Error('fusion fields: file shorter than declared');
    const read = (name: string): Float32Array => {
      const f = desc.fields.find((e) => e.name === name);
      if (!f) throw new Error(`fusion fields: missing field "${name}"`);
      if (f.type === 'float32') {
        const out = new Float32Array(n);
        const view = new DataView(buffer, f.offset, n * 4);
        for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
        return out;
      }
      const raw = new Uint8Array(buffer, f.offset, n);
      const scale = f.scale ?? 1 / 255;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = raw[i] * scale;
      return out;
    };
    return new FusionFields(
      { bounds: desc.grid.bounds, width, height },
      read('baseM'), read('residualM'), read('weight'), read('coverage'),
    );
  }

  /** Summary over a tile's footprint (memoized per key); `null` when it misses the grid. */
  tileStats(key: TileKey): FusionTileStats | null {
    const id = `${key.z}/${key.x}/${key.y}`;
    if (this.cache.has(id)) return this.cache.get(id)!;
    const stats = this.boundsStats(geographicTileBounds(key));
    this.cache.set(id, stats);
    return stats;
  }

  boundsStats(b: GeoBounds): FusionTileStats | null {
    const [w, s, e, n] = this.grid.bounds;
    const { width, height } = this.grid;
    if (b.eastDeg <= w || b.westDeg >= e || b.northDeg <= s || b.southDeg >= n) return null;
    const cw = (e - w) / width, ch = (n - s) / height;
    const x0 = Math.max(0, Math.floor((b.westDeg - w) / cw));
    const x1 = Math.min(width - 1, Math.ceil((b.eastDeg - w) / cw) - 1);
    const y0 = Math.max(0, Math.floor((n - b.northDeg) / ch));
    const y1 = Math.min(height - 1, Math.ceil((n - b.southDeg) / ch) - 1);
    let count = 0, sumR = 0, sumW = 0, edge = false, blend = false, all = true;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        const wt = this.weight[i], c = this.coverage[i];
        count++;
        sumR += this.residualM[i];
        sumW += wt;
        if (c > 0 && c < 1) edge = true;
        if (wt > 0 && wt < 1) blend = true;
        if (wt < 1) all = false;
      }
    }
    if (!count) return null;
    return { meanResidualM: sumR / count, meanWeight: sumW / count, touchesCoverageEdge: edge, touchesBlend: blend, allDetail: all };
  }
}
