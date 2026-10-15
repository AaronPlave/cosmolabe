import type { PhysicalSurface, PhysicalSurfaceMetadata, SurfaceAccuracy, SurfaceIntersection, SurfaceQueryOptions, SurfaceRay, SurfaceVector } from './PhysicalSurface.js';
import { normalizedRay } from './PhysicalSurface.js';

export interface CpuSurfaceMesh {
  /** Packed xyz in body-fixed km, with winding defining the outward normal. No skirts/caps. */
  positionsKm: Float64Array;
  indices: Uint16Array | Uint32Array;
}
const sub = (a: SurfaceVector, b: SurfaceVector): SurfaceVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: SurfaceVector, b: SurfaceVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: SurfaceVector, b: SurfaceVector): SurfaceVector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Bounded proof intersector. Linear CPU triangle scan; large mission meshes require a source BVH. */
export class CpuMeshSurface implements PhysicalSurface {
  private readonly mesh: CpuSurfaceMesh | null;
  readonly retainedBytes: number;
  constructor(
    readonly metadata: PhysicalSurfaceMetadata,
    mesh: CpuSurfaceMesh,
    readonly accuracy: SurfaceAccuracy,
    maxBytes = 8 * 1024 * 1024,
  ) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('Invalid CPU mesh budget');
    if (accuracy.meshDeviationBoundKm != null && (!Number.isFinite(accuracy.meshDeviationBoundKm) || accuracy.meshDeviationBoundKm < 0)) {
      throw new Error('Invalid mesh deviation bound');
    }
    const bytes = mesh.positionsKm.byteLength + mesh.indices.byteLength;
    this.retainedBytes = bytes <= maxBytes ? bytes : 0;
    this.mesh = bytes <= maxBytes ? { positionsKm: mesh.positionsKm.slice(), indices: mesh.indices.slice() } : null;
    if (!this.mesh) return;
    const { positionsKm, indices } = this.mesh;
    if (positionsKm.length < 9 || positionsKm.length % 3 !== 0 || indices.length < 3 || indices.length % 3 !== 0
      || !positionsKm.every(Number.isFinite) || indices.some(i => i >= positionsKm.length / 3)) {
      throw new Error('Malformed CPU surface mesh');
    }
  }

  intersectRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection {
    const direction = normalizedRay(ray, options);
    const metadata = this.metadata;
    if (!this.mesh) return { kind: 'unavailable', reason: 'budget', metadata };
    const { positionsKm, indices } = this.mesh;
    const origin: SurfaceVector = [ray.origin.xKm, ray.origin.yKm, ray.origin.zKm];
    const vertex = (i: number): SurfaceVector => [positionsKm[i * 3], positionsKm[i * 3 + 1], positionsKm[i * 3 + 2]];
    let nearest = ray.farKm, triangleIndex = -1;
    let normal: SurfaceVector = [0, 0, 0];
    for (let t = 0; t < indices.length; t += 3) {
      const a = vertex(indices[t]);
      const e1 = sub(vertex(indices[t + 1]), a), e2 = sub(vertex(indices[t + 2]), a);
      const n = cross(e1, e2), nLength = Math.hypot(...n);
      const p = cross(direction, e2), determinant = dot(e1, p);
      // Relative parallel tolerance works for both kilometre bodies and metre-scale detail.
      if (nLength === 0 || Math.abs(determinant) <= 1e-14 * nLength) continue;
      const offset = sub(origin, a), q = cross(offset, e1);
      const u = dot(offset, p) / determinant, v = dot(direction, q) / determinant;
      if (u < -1e-12 || v < -1e-12 || u + v > 1 + 1e-12) continue;
      const distance = dot(e2, q) / determinant;
      if (distance < ray.nearKm || distance > nearest) continue;
      // Keep the first triangle on shared edges for deterministic provenance.
      if (triangleIndex >= 0 && distance === nearest) continue;
      nearest = distance;
      triangleIndex = t / 3;
      normal = n.map(value => value / nLength) as [number, number, number];
    }
    const bound = this.accuracy.meshDeviationBoundKm;
    const detail = metadata.coverage === 'complete-product' && bound != null && bound <= options.maxMeshErrorKm ? 'sufficient' : 'coarse';
    if (triangleIndex < 0) return metadata.coverage === 'complete-product'
      ? { kind: 'miss', metadata, accuracy: this.accuracy, detail }
      : { kind: 'unavailable', reason: 'partial-coverage', metadata };
    return {
      kind: 'hit', position: { xKm: origin[0] + nearest * direction[0], yKm: origin[1] + nearest * direction[1], zKm: origin[2] + nearest * direction[2] },
      normal, distanceKm: nearest, triangleIndex, metadata, accuracy: this.accuracy,
      detail,
    };
  }
}
