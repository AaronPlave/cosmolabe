import * as THREE from 'three';
import type { BodyMesh } from './BodyMesh.js';
import type { SensorFovClipper } from './SensorFrustum.js';
import { clipFovPerimeter, type FovPerimeterSample, type FovSurfaceCandidate } from './surface/FovClipper.js';
import { ReferenceEllipsoidSurface } from './surface/ReferenceEllipsoidSurface.js';
import { ResidentTerrainSurface } from './surface/ResidentTerrainSurface.js';

/**
 * Terrain can stand above the reference shape; inflate the rejection sphere by
 * this fraction of the largest radius when terrain is resident (Olympus Mons is
 * ~0.6% of Mars' radius).
 */
const TERRAIN_BOUNDING_MARGIN = 0.01;

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

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
 */
export class SensorFovClipping {
  private readonly surfaces = new Map<string, BodySurfaces>();
  private readonly cache = new Map<string, { key: string; samples: FovPerimeterSample[] }>();
  private candidates: FovSurfaceCandidate[] = [];
  private frameKey = '';

  /** Resolve candidate surfaces for this frame. Positions are origin-relative km. */
  begin(
    et: number,
    originAbsPos: readonly [number, number, number],
    bodyMeshes: Iterable<BodyMesh>,
    absolutePositionOf: (name: string, et: number) => [number, number, number],
  ): void {
    const candidates: FovSurfaceCandidate[] = [];
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
      candidates.push({
        id: body.name,
        centerKm: [abs[0] - originAbsPos[0], abs[1] - originAbsPos[1], abs[2] - originAbsPos[2]],
        bodyToWorld: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]],
        boundingRadiusKm: entry.reference.boundingRadiusKm * (hasTerrain ? 1 + TERRAIN_BOUNDING_MARGIN : 1),
        surfaces: hasTerrain ? [entry.terrain!, entry.reference] : [entry.reference],
      });
    }
    this.candidates = candidates;
    // Geometry depends only on epoch, origin and resident surface data — not on the viewer camera.
    this.frameKey = `${et}|${originAbsPos.join(',')}|${terrainRevision}|${candidates.map(c => c.id).join(',')}`;
  }

  /** A clipper for one sensor, excluding the sensor's own body. Memoized while the frame key holds. */
  clipperFor(sensorBodyName: string, pointingKey: string): SensorFovClipper {
    const candidates = this.candidates.filter(c => c.id !== sensorBodyName);
    return (originKm, directionAt, baseParams, maxRangeKm) => {
      const key = `${this.frameKey}|${pointingKey}|${originKm.join(',')}|${maxRangeKm}|${baseParams.length}`;
      const cached = this.cache.get(sensorBodyName);
      if (cached?.key === key) return cached.samples;
      const samples = clipFovPerimeter(originKm, directionAt, baseParams, candidates, { maxRangeKm });
      this.cache.set(sensorBodyName, { key, samples });
      return samples;
    };
  }

  dispose(): void {
    this.surfaces.clear();
    this.cache.clear();
    this.candidates = [];
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
