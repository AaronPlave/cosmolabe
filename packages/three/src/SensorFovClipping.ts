import * as THREE from 'three';
import type { BodyMesh } from './BodyMesh.js';
import type { SensorFovClipper } from './SensorFrustum.js';
import { clipFovPerimeter, type FovPerimeterSample, type FovSurfaceCandidate } from './surface/FovClipper.js';
import type { PhysicalSurface, PhysicalSurfaceMetadata, SurfaceIntersection, SurfaceQueryOptions, SurfaceRay } from './surface/PhysicalSurface.js';
import { ReferenceEllipsoidSurface } from './surface/ReferenceEllipsoidSurface.js';
import { ResidentTerrainSurface } from './surface/ResidentTerrainSurface.js';

/**
 * Terrain can stand above the reference shape; inflate the rejection sphere by
 * this fraction of the largest radius when terrain is resident (Olympus Mons is
 * ~0.6% of Mars' radius).
 */
const TERRAIN_BOUNDING_MARGIN = 0.01;

/**
 * Per-frame cap on actual terrain triangle tests across all sensors. A query
 * may finish its current tile; once spent, uncached queries abort the sensor's
 * terrain pass and retry its entire perimeter against reference shapes. Shared
 * ray results remain usable without spending additional triangle budget.
 */
const TERRAIN_TRIANGLE_BUDGET = 100_000;

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/** Stands in for terrain once the frame's budget is spent: an explicit 'budget' miss of detail. */
class DeferredTerrain implements PhysicalSurface {
  constructor(readonly metadata: PhysicalSurfaceMetadata) {}
  intersectRay(): SurfaceIntersection { return { kind: 'unavailable', reason: 'budget', metadata: this.metadata }; }
}

const TERRAIN_BUDGET_EXCEEDED = Symbol('terrain-budget-exceeded');

/** Per-frame sharing: overlapping instruments often cast exactly the same rays. */
class CachedTerrain implements PhysicalSurface {
  readonly metadata: PhysicalSurfaceMetadata;
  private readonly rays = new Map<string, SurfaceIntersection>();
  constructor(private readonly surface: ResidentTerrainSurface, private readonly canQuery: () => boolean) {
    this.metadata = surface.metadata;
  }
  intersectRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection {
    const { xKm, yKm, zKm } = ray.origin;
    const key = `${xKm},${yKm},${zKm}|${ray.direction.join(',')}|${ray.nearKm}|${ray.farKm}|${options.maxMeshErrorKm}`;
    const cached = this.rays.get(key);
    if (cached) return cached;
    if (!this.canQuery()) throw TERRAIN_BUDGET_EXCEEDED;
    const result = this.surface.intersectRay(ray, options);
    if (this.rays.size < 4096) this.rays.set(key, result);
    return result;
  }
}

interface BodySurfaces {
  reference: ReferenceEllipsoidSurface;
  terrain?: ResidentTerrainSurface;
}

/**
 * Renderer-side owner of FOV clipping (issue #27): resolves each solid body's
 * physical surfaces and body-fixed frame at the current epoch and hands
 * `SensorFrustum` a clipper. `SensorFrustum` stays a rendering object; it never
 * sees body frames, terrain streaming or surface selection.
 *
 * Eligible surfaces are solid globes with measured radii: their reference
 * ellipsoid, preceded by resident streamed terrain where the body has it.
 * Atmospheres, rings, trajectories, labels and spacecraft models are not
 * physical terminators here, and neither is a body the user has hidden.
 * Irregular `Mesh` bodies (e.g. 67P) are not candidates yet: the clipper
 * supports any PhysicalSurface, but the viewer has no body-fixed CPU shape model
 * or BVH for them (tracked in #175).
 */
export class SensorFovClipping {
  private readonly surfaces = new Map<string, BodySurfaces>();
  private readonly cache = new Map<string, { key: string; samples: FovPerimeterSample[] }>();
  private candidates: FovSurfaceCandidate[] = [];
  /** Same bodies with terrain swapped for DeferredTerrain, used once the budget is spent. */
  private deferredCandidates: FovSurfaceCandidate[] = [];
  private terrainThisFrame: ResidentTerrainSurface[] = [];
  private frameKey = '';

  /** Resolve candidate surfaces for this frame. Positions are origin-relative km. */
  begin(
    et: number,
    originAbsPos: readonly [number, number, number],
    bodyMeshes: Iterable<BodyMesh>,
    absolutePositionOf: (name: string, et: number) => [number, number, number],
  ): void {
    const candidates: FovSurfaceCandidate[] = [];
    const deferred: FovSurfaceCandidate[] = [];
    const terrainThisFrame: ResidentTerrainSurface[] = [];
    let terrainRevision = 0;
    for (const bm of bodyMeshes) {
      const body = bm.body;
      // A body the user hid is not drawn, so it must not carve the FOV in empty space.
      if (!bm.visible || body.geometryType !== 'Globe' || !body.radii) continue;
      const abs = absolutePositionOf(body.name, et);
      if (!abs.every(Number.isFinite)) continue;
      const entry = this.surfacesFor(bm);
      if (!entry) continue;
      const sampler = bm.terrainSampler;
      if (sampler && entry.terrain?.sampler !== sampler) entry.terrain = new ResidentTerrainSurface(sampler, body.name, entry.reference.metadata.frame);
      if (!sampler) entry.terrain = undefined;
      const hasTerrain = !!sampler && sampler.diagnostics.tileCount > 0;
      if (sampler) terrainRevision += sampler.revision;

      bm.bodyToWorldQuaternion(_q);
      const e = _m.makeRotationFromQuaternion(_q).elements; // column-major
      const terrain = hasTerrain
        ? new CachedTerrain(entry.terrain!, () => this.terrainTrianglesThisFrame() < TERRAIN_TRIANGLE_BUDGET)
        : null;
      const candidate: FovSurfaceCandidate = {
        id: body.name,
        centerKm: [abs[0] - originAbsPos[0], abs[1] - originAbsPos[1], abs[2] - originAbsPos[2]],
        bodyToWorld: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]],
        boundingRadiusKm: entry.reference.boundingRadiusKm * (hasTerrain ? 1 + TERRAIN_BOUNDING_MARGIN : 1),
        surfaces: terrain ? [terrain, entry.reference] : [entry.reference],
      };
      candidates.push(candidate);
      if (hasTerrain) {
        entry.terrain!.trianglesTested = 0;
        terrainThisFrame.push(entry.terrain!);
        deferred.push({ ...candidate, surfaces: [new DeferredTerrain(entry.terrain!.metadata), entry.reference] });
      } else {
        deferred.push(candidate);
      }
    }
    this.candidates = candidates;
    this.deferredCandidates = deferred;
    this.terrainThisFrame = terrainThisFrame;
    // Geometry depends only on epoch, origin and resident surface data — not on the viewer camera.
    this.frameKey = `${et}|${originAbsPos.join(',')}|${terrainRevision}|${candidates.map(c => c.id).join(',')}`;
  }

  /** A clipper for one sensor, excluding the sensor's own body. Memoized while the frame key holds. */
  clipperFor(sensorBodyName: string, pointingKey: string): SensorFovClipper {
    return (originKm, directionAt, baseParams, maxRangeKm) => {
      const key = `${this.frameKey}|${pointingKey}|${originKm.join(',')}|${maxRangeKm}|${baseParams.length}`;
      const cached = this.cache.get(sensorBodyName);
      if (cached?.key === key) return cached.samples;
      const pool = this.candidates.filter(c => c.id !== sensorBodyName);
      try {
        const samples = clipFovPerimeter(originKm, directionAt, baseParams, pool, { maxRangeKm });
        this.cache.set(sensorBodyName, { key, samples });
        return samples;
      } catch (error) {
        if (error !== TERRAIN_BUDGET_EXCEEDED) throw error;
      }
      // Discard the partial pass: one perimeter must never mix budget fallback
      // with terrain. Cached rays can still serve later overlapping instruments.
      this.cache.delete(sensorBodyName);
      const samples = clipFovPerimeter(originKm, directionAt, baseParams,
        this.deferredCandidates.filter(c => c.id !== sensorBodyName), { maxRangeKm });
      return samples;
    };
  }

  /** Terrain triangles tested since `begin`, across all bodies. */
  terrainTrianglesThisFrame(): number {
    let n = 0;
    for (const t of this.terrainThisFrame) n += t.trianglesTested;
    return n;
  }

  dispose(): void {
    this.surfaces.clear();
    this.cache.clear();
    this.candidates = [];
    this.deferredCandidates = [];
    this.terrainThisFrame = [];
  }

  private surfacesFor(bm: BodyMesh): BodySurfaces | null {
    const name = bm.body.name;
    let entry = this.surfaces.get(name);
    if (!entry) {
      try {
        entry = { reference: new ReferenceEllipsoidSurface(name, `${name}:body-fixed`, bm.body.radii!) };
      } catch {
        return null; // degenerate radii: not a physical surface
      }
      this.surfaces.set(name, entry);
    }
    return entry;
  }
}
