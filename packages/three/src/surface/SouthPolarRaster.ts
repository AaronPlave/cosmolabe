import * as THREE from 'three';
import type { SurfacePoint, SurfaceRasterDefinition } from '@cosmolabe/core';

export interface PolarRasterManifest {
  format: 'cosmolabe-south-polar-raster-1';
  frame: string;
  radiusKm: number;
  polarLimitDeg: number;
  grid: { westM: number; northM: number; stepM: number; width: number; height: number };
  displayStride: number;
  tileSize: number;
  nativeTiles: string[];
  source: { product: string; url: string; reference: string; originalResolutionM: number };
  features?: Record<string, { name: string; gid: number; area_km2: number; source_name: string }>;
  files: Record<string, string>;
}

export function southPolarGridPosition(x: number, y: number, z: number, m: PolarRasterManifest): [number, number] | null {
  const length = Math.hypot(x, y, z);
  if (!length || z / length > Math.sin(m.polarLimitDeg * Math.PI / 180)) return null;
  // x toward longitude zero; projected north is toward longitude zero.
  const scale = 2000 * m.radiusKm / (length - z);
  const { westM, northM, stepM, width, height } = m.grid;
  const column = Math.floor((y * scale - westM) / stepM);
  const row = Math.floor((northM - x * scale) / stepM);
  return column >= 0 && column < width && row >= 0 && row < height ? [column, row] : null;
}

async function fetchBytes(url: URL, signal: AbortSignal, maxBytes: number, compressed = false): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Could not load ${url.pathname} (HTTP ${response.status})`);
  const stream = compressed ? response.body.pipeThrough(new DecompressionStream('gzip')) : response.body;
  const reader = stream.getReader();
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return bytes.subarray(0, size);
      if (value.byteLength > maxBytes - size) throw new Error('Science product exceeds its declared size');
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel();
  }
}

export class SouthPolarRaster {
  readonly url: URL;
  readonly controller = new AbortController();
  manifest: PolarRasterManifest | null = null;
  texture: THREE.DataTexture | null = null;
  status: 'loading' | 'ready' | 'error' = 'loading';
  error = '';
  opacity: number;
  private readonly native = new Map<string, Promise<Float32Array>>();
  private tileKeys = new Set<string>();

  constructor(readonly definition: SurfaceRasterDefinition) {
    this.url = new URL(definition.source);
    this.opacity = THREE.MathUtils.clamp(definition.opacity, 0, 1);
  }

  async load(): Promise<void> {
    try {
      const bytes = await fetchBytes(this.url, this.controller.signal, 2 * 1024 * 1024);
      const m = JSON.parse(new TextDecoder().decode(bytes)) as PolarRasterManifest;
      const { width, height, stepM, westM, northM } = m.grid ?? {};
      const dimensions = [width, height, m.displayStride, m.tileSize];
      const numeric = [stepM, westM, northM, m.polarLimitDeg];
      if (m.format !== 'cosmolabe-south-polar-raster-1' || m.frame !== 'MOON_ME_DE421' || m.radiusKm !== 1737.4 ||
        !dimensions.every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768) || m.tileSize > 512 ||
        !numeric.every(Number.isFinite) || stepM <= 0 || m.polarLimitDeg <= -90 || m.polarLimitDeg >= -70 ||
        !Array.isArray(m.nativeTiles) || !m.nativeTiles.every(key => /^\d+\/\d+$/.test(key)) || !m.source || !m.files) {
        throw new Error('Invalid or unsupported south polar science grid');
      }
      const w = Math.ceil(width / m.displayStride), h = Math.ceil(height / m.displayStride);
      if (Math.max(w, h) > 4096) throw new Error('Science overview exceeds 4096 texels per side');
      const values = await this.readGrid('overview.f32.gz', w * h);
      this.controller.signal.throwIfAborted();
      this.manifest = m;
      this.tileKeys = new Set(m.nativeTiles);
      // Polygon IDs fit in one unsigned channel; temperatures retain Float32.
      this.texture = m.features
        ? new THREE.DataTexture(Uint16Array.from(values), w, h, THREE.RedIntegerFormat, THREE.UnsignedShortType)
        : new THREE.DataTexture(values, w, h, THREE.RedFormat, THREE.FloatType);
      this.texture.needsUpdate = true;
      this.status = 'ready';
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.error = error instanceof Error ? error.message : String(error);
        this.status = 'error';
      }
    }
  }

  async sample(point: Pick<SurfacePoint, 'bodyName' | 'frame' | 'bodyFixedPositionKm'>): Promise<number | null> {
    const m = this.manifest;
    if (!m || point.bodyName !== this.definition.body || point.frame !== m.frame) return null;
    const position = southPolarGridPosition(...point.bodyFixedPositionKm, m);
    if (!position) return null;
    const [col, row] = position;
    const size = m.tileSize;
    const x = Math.floor(col / size), y = Math.floor(row / size);
    const key = `${x}/${y}`;
    if (!this.tileKeys.has(key)) return null;
    const w = Math.min(size, m.grid.width - x * size), h = Math.min(size, m.grid.height - y * size);
    let tile = this.native.get(key);
    if (!tile) {
      tile = this.readGrid(`native/${key}.f32.gz`, w * h);
      this.native.set(key, tile);
      if (this.native.size > 8) this.native.delete(this.native.keys().next().value!);
    }
    try {
      const value = (await tile)[(row % size) * w + col % size];
      return Number.isFinite(value) ? value : null;
    } catch (error) {
      if (this.native.get(key) === tile) this.native.delete(key);
      throw error;
    }
  }

  async featureText(id: number): Promise<string> {
    if (!this.manifest?.features?.[id]) throw new Error('Unknown shadow region');
    const bytes = await fetchBytes(new URL(`features/${id}.geojson.gz`, this.url), this.controller.signal, 2 * 1024 * 1024, true);
    return new TextDecoder().decode(bytes);
  }

  dispose(): void {
    this.controller.abort();
    this.texture?.dispose();
    this.texture = null;
    this.native.clear();
  }

  private async readGrid(path: string, count: number): Promise<Float32Array<ArrayBuffer>> {
    const bytes = await fetchBytes(new URL(path, this.url), this.controller.signal, count * 4, true);
    if (bytes.byteLength !== count * 4) throw new Error('Science grid has an unexpected byte count');
    const buffer = bytes.buffer;
    if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
      const view = new DataView(buffer);
      for (let offset = 0; offset < bytes.byteLength; offset += 4) view.setFloat32(offset, view.getFloat32(offset, true));
    }
    return new Float32Array(buffer);
  }
}
