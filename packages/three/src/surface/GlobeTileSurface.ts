import { TerrainSampler, geodeticToBodyFixed, type TerrainTile } from '../TerrainSampler.js';
import { CpuMeshSurface } from './CpuMeshSurface.js';
import { normalizedRay, type PhysicalSurface, type PhysicalSurfaceMetadata, type SurfaceIntersection, type SurfaceQueryOptions, type SurfaceRay } from './PhysicalSurface.js';

/**
 * Integration proof over one decoded sampler tile. Its coverage is deliberately partial:
 * a tileset loader must certify nearest-hit coverage before general navigation uses it.
 * Tile replacement/eviction invalidates the derived CPU snapshot; renderer visibility does not.
 */
export class GlobeTileSurface implements PhysicalSurface {
  readonly metadata: PhysicalSurfaceMetadata;
  private tile: TerrainTile | undefined;
  private intersector: CpuMeshSurface | undefined;
  constructor(
    readonly sampler: TerrainSampler,
    readonly tileId: string,
    bodyId: string,
    frame: string,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('Invalid CPU globe budget');
    this.metadata = { bodyId, frame, source: sampler.source, shape: { kind: 'globe', datum: sampler.datum }, coverage: 'partial-product' };
  }

  sampleElevation(latDeg: number, lonDeg: number) { return this.sampler.sample(latDeg, lonDeg, true); }

  intersectRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection {
    normalizedRay(ray, options);
    const tile = this.sampler.getTile(this.tileId);
    if (tile !== this.tile) { this.tile = tile; this.intersector = undefined; }
    if (!tile) return { kind: 'unavailable', reason: 'not-resident', metadata: this.metadata };
    const datum = this.sampler.datum;
    // Existing converters implement spheres and geodetic oblate ellipsoids only.
    // Do not reinterpret radial oblate/areoid/unknown metadata as geodetic height.
    if ((datum.verticalDatum !== 'reference-sphere' && datum.verticalDatum !== 'ellipsoid')
      || (datum.referenceShape.kind === 'ellipsoid' && (datum.heightConvention !== 'geodetic-normal'
        || datum.referenceShape.radiiKm[0] !== datum.referenceShape.radiiKm[1]))) {
      return { kind: 'unavailable', reason: 'unsupported-datum', metadata: this.metadata };
    }
    const vertexCount = tile.kind === 'mesh' ? tile.u.length : tile.width * tile.height;
    const indexCount = tile.kind === 'mesh' ? tile.indices.length : (tile.width - 1) * (tile.height - 1) * 6;
    if (vertexCount * 24 + indexCount * 4 > this.maxBytes) {
      return { kind: 'unavailable', reason: 'budget', metadata: this.metadata };
    }
    if (!this.intersector) {
      const positionsKm = new Float64Array(vertexCount * 3);
      const rawSpan = tile.eastDeg - tile.westDeg;
      const span = rawSpan > 0 ? rawSpan : rawSpan + 360;
      for (let i = 0; i < vertexCount; i++) {
        const u = tile.kind === 'mesh' ? tile.u[i] : (i % tile.width) / (tile.width - 1);
        const v = tile.kind === 'mesh' ? tile.v[i] : Math.floor(i / tile.width) / (tile.height - 1);
        const p = geodeticToBodyFixed({ latDeg: tile.southDeg + v * (tile.northDeg - tile.southDeg), lonDeg: tile.westDeg + u * span, heightKm: tile.elevationsKm[i] }, datum);
        positionsKm.set([p.xKm, p.yKm, p.zKm], i * 3);
      }
      const indices = new Uint32Array(indexCount);
      if (tile.kind === 'mesh') indices.set(tile.indices);
      else {
        let k = 0;
        for (let y = 0; y < tile.height - 1; y++) for (let x = 0; x < tile.width - 1; x++) {
          const a = y * tile.width + x, b = a + 1, c = a + tile.width, d = c + 1;
          indices.set([a, b, c, b, d, c], k); k += 6;
        }
      }
      this.intersector = new CpuMeshSurface(
        { ...this.metadata, source: tile.source ?? this.sampler.source }, { positionsKm, indices },
        { meshDeviationBoundKm: null, sourceUncertaintyKm: tile.uncertaintyKm ?? tile.source?.uncertaintyKm ?? this.sampler.source.uncertaintyKm }, this.maxBytes,
      );
    }
    const result = this.intersector.intersectRay(ray, options);
    return result.kind === 'hit' ? { ...result, tileId: this.tileId } : result;
  }
}
