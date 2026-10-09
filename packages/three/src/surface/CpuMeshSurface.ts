import type { PhysicalSurface, PhysicalSurfaceMetadata, SurfaceAccuracy, SurfaceIntersection, SurfaceQueryOptions, SurfaceRay } from './PhysicalSurface.js';
import { normalizedRay } from './PhysicalSurface.js';

export interface CpuSurfaceMesh {
  /** Packed xyz in body-fixed km, with winding defining the outward normal. No skirts/caps. */
  positionsKm: Float64Array;
  indices: Uint16Array | Uint32Array;
}

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
    const ox = ray.origin.xKm, oy = ray.origin.yKm, oz = ray.origin.zKm;
    const dx = direction[0], dy = direction[1], dz = direction[2];
    let nearest = ray.farKm, triangleIndex = -1;
    let nx = 0, ny = 0, nz = 0;
    // Scalar Möller–Trumbore: no per-triangle allocation, so the scan stays
    // cheap enough for renderer consumers that cast many rays per frame.
    for (let t = 0; t < indices.length; t += 3) {
      const ia = indices[t] * 3, ib = indices[t + 1] * 3, ic = indices[t + 2] * 3;
      const ax = positionsKm[ia], ay = positionsKm[ia + 1], az = positionsKm[ia + 2];
      const e1x = positionsKm[ib] - ax, e1y = positionsKm[ib + 1] - ay, e1z = positionsKm[ib + 2] - az;
      const e2x = positionsKm[ic] - ax, e2y = positionsKm[ic + 1] - ay, e2z = positionsKm[ic + 2] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const determinant = e1x * px + e1y * py + e1z * pz;
      const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
      const nLength = Math.sqrt(cx * cx + cy * cy + cz * cz);
      // Relative parallel tolerance works for both kilometre bodies and metre-scale detail.
      if (nLength === 0 || Math.abs(determinant) <= 1e-14 * nLength) continue;
      const sx = ox - ax, sy = oy - ay, sz = oz - az;
      const u = (sx * px + sy * py + sz * pz) / determinant;
      if (u < -1e-12) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) / determinant;
      if (v < -1e-12 || u + v > 1 + 1e-12) continue;
      const distance = (e2x * qx + e2y * qy + e2z * qz) / determinant;
      if (distance < ray.nearKm || distance > nearest) continue;
      // Keep the first triangle on shared edges for deterministic provenance.
      if (triangleIndex >= 0 && distance === nearest) continue;
      nearest = distance;
      triangleIndex = t / 3;
      nx = cx / nLength; ny = cy / nLength; nz = cz / nLength;
    }
    const bound = this.accuracy.meshDeviationBoundKm;
    const detail = metadata.coverage === 'complete-product' && bound != null && bound <= options.maxMeshErrorKm ? 'sufficient' : 'coarse';
    if (triangleIndex < 0) return metadata.coverage === 'complete-product'
      ? { kind: 'miss', metadata, accuracy: this.accuracy, detail }
      : { kind: 'unavailable', reason: 'partial-coverage', metadata };
    return {
      kind: 'hit', position: { xKm: ox + nearest * dx, yKm: oy + nearest * dy, zKm: oz + nearest * dz },
      normal: [nx, ny, nz], distanceKm: nearest, triangleIndex, metadata, accuracy: this.accuracy,
      detail,
    };
  }
}
