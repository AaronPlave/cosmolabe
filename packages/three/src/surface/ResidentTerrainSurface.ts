import { bodyFixedToGeodetic, type BodyFixedCartesian, type TerrainSampler } from '../TerrainSampler.js';
import { GlobeTileSurface } from './GlobeTileSurface.js';
import { normalizedRay, type PhysicalSurface, type PhysicalSurfaceMetadata, type SurfaceHit, type SurfaceIntersection, type SurfaceQueryOptions, type SurfaceRay } from './PhysicalSurface.js';
import { ReferenceEllipsoidSurface } from './ReferenceEllipsoidSurface.js';

/** Observers below this height above the datum also probe the tiles under themselves. */
const NEAR_SURFACE_KM = 50;

/**
 * Bounded ray query over whatever decoded terrain tiles a sampler currently holds.
 *
 * Not a general nearest-hit oracle: it probes only the tiles that cover where
 * the ray crosses the datum (and, for a near-surface observer, the ground below
 * it), finest first, through the shared per-tile `GlobeTileSurface` path. That
 * keeps per-ray cost to a handful of tiles instead of a scan of every resident
 * triangle, which the linear CPU proof cannot afford. Coverage is always
 * 'partial-product', so every answer is 'coarse' or 'unavailable' — callers
 * that need a guaranteed nearest hit must wait for a certified tileset/BVH.
 */
export class ResidentTerrainSurface implements PhysicalSurface {
  readonly metadata: PhysicalSurfaceMetadata;
  private readonly datumShape: ReferenceEllipsoidSurface;
  private readonly tileSurfaces = new Map<string, GlobeTileSurface>();
  /**
   * Triangles handed to the per-tile linear intersector so far. Callers that
   * run in the render loop reset and read it to bound per-frame cost.
   */
  trianglesTested = 0;

  constructor(
    readonly sampler: TerrainSampler,
    readonly bodyId: string,
    readonly frame: string,
    /** Upper bound on tiles intersected per ray. */
    private readonly maxTilesPerRay = 8,
  ) {
    const shape = sampler.datum.referenceShape;
    const radii: [number, number, number] = shape.kind === 'sphere'
      ? [shape.radiusKm, shape.radiusKm, shape.radiusKm]
      : [shape.radiiKm[0], shape.radiiKm[1], shape.radiiKm[2]];
    this.datumShape = new ReferenceEllipsoidSurface(bodyId, frame, radii);
    this.metadata = { bodyId, frame, source: sampler.source, shape: { kind: 'globe', datum: sampler.datum }, coverage: 'partial-product' };
  }

  intersectRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection {
    const direction = normalizedRay(ray, options);
    const probes: BodyFixedCartesian[] = [];
    const datumHit = this.datumShape.intersectRay({ ...ray, nearKm: 0, farKm: Math.max(ray.farKm, 0) }, options);
    if (datumHit.kind === 'hit') probes.push(datumHit.position);
    const originHeight = bodyFixedToGeodetic(ray.origin, this.sampler.datum).heightKm ?? Infinity;
    if (originHeight < NEAR_SURFACE_KM) probes.push(ray.origin);
    if (!probes.length) return { kind: 'unavailable', reason: 'partial-coverage', metadata: this.metadata };

    let nearest: SurfaceHit | undefined;
    let queried = 0;
    const seen = new Set<string>();
    for (const probe of probes) {
      const { latDeg, lonDeg } = bodyFixedToGeodetic(probe, this.sampler.datum);
      for (const id of this.tilesCovering(latDeg, lonDeg)) {
        if (seen.has(id)) continue;
        if (queried++ >= this.maxTilesPerRay) break;
        seen.add(id);
        const tile = this.sampler.getTile(id);
        if (tile) this.trianglesTested += tile.kind === 'mesh' ? tile.indices.length / 3 : (tile.width - 1) * (tile.height - 1) * 2;
        const result = this.tileSurface(id).intersectRay({ ...ray, direction }, options);
        if (result.kind !== 'hit') continue;
        if (!nearest || result.distanceKm < nearest.distanceKm) nearest = result;
        break; // finest covering tile answered for this probe
      }
    }
    this.pruneTileSurfaces();
    return nearest ?? { kind: 'unavailable', reason: queried ? 'partial-coverage' : 'not-resident', metadata: this.metadata };
  }

  /** Resident tile ids covering a point, finest (smallest footprint) first. */
  private tilesCovering(latDeg: number, lonDeg: number): string[] {
    const found: { id: string; area: number }[] = [];
    for (const id of this.sampler.tileIds()) {
      const tile = this.sampler.getTile(id);
      if (!tile || latDeg < tile.southDeg || latDeg > tile.northDeg) continue;
      const raw = tile.eastDeg - tile.westDeg;
      const span = raw > 0 ? raw : raw + 360;
      const offset = (((lonDeg - tile.westDeg) % 360) + 360) % 360;
      if (offset > span) continue;
      found.push({ id, area: span * (tile.northDeg - tile.southDeg) });
    }
    return found.sort((a, b) => a.area - b.area).map(f => f.id);
  }

  private tileSurface(id: string): GlobeTileSurface {
    let surface = this.tileSurfaces.get(id);
    if (!surface) {
      surface = new GlobeTileSurface(this.sampler, id, this.bodyId, this.frame);
      this.tileSurfaces.set(id, surface);
    }
    return surface;
  }

  /** Drop CPU snapshots for tiles the sampler has evicted. */
  private pruneTileSurfaces(): void {
    if (this.tileSurfaces.size <= this.maxTilesPerRay * 4) return;
    for (const id of this.tileSurfaces.keys()) if (!this.sampler.getTile(id)) this.tileSurfaces.delete(id);
  }
}
