import type { PhysicalSurface, PhysicalSurfaceMetadata, SurfaceAccuracy, SurfaceIntersection, SurfaceQueryOptions, SurfaceRay } from './PhysicalSurface.js';
import { normalizedRay } from './PhysicalSurface.js';

export interface CpuSurfaceMesh {
  /** Packed xyz in body-fixed km, with winding defining the outward normal. No skirts/caps. */
  positionsKm: Float64Array;
  indices: Uint16Array | Uint32Array;
}

/** Triangles stay in source order; group bounds cheaply reject unrelated tile patches. */
const TRIANGLES_PER_GROUP = 4;

/** Bounded proof intersector; large mission meshes still require a source BVH. */
export class CpuMeshSurface implements PhysicalSurface {
  private readonly mesh: CpuSurfaceMesh | null;
  readonly retainedBytes: number;
  private readonly groupBounds: Float64Array;
  /** Actual triangle tests in the last query, excluding groups rejected by bounds. */
  trianglesTested = 0;
  constructor(
    readonly metadata: PhysicalSurfaceMetadata,
    mesh: CpuSurfaceMesh,
    readonly accuracy: SurfaceAccuracy,
    maxBytes = 8 * 1024 * 1024,
    private readonly rejectGroups = false,
  ) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('Invalid CPU mesh budget');
    if (accuracy.meshDeviationBoundKm != null && (!Number.isFinite(accuracy.meshDeviationBoundKm) || accuracy.meshDeviationBoundKm < 0)) {
      throw new Error('Invalid mesh deviation bound');
    }
    const groupCount = rejectGroups ? Math.ceil(mesh.indices.length / (3 * TRIANGLES_PER_GROUP)) : 0;
    const bytes = mesh.positionsKm.byteLength + mesh.indices.byteLength + groupCount * 6 * 8;
    this.retainedBytes = bytes <= maxBytes ? bytes : 0;
    this.mesh = bytes <= maxBytes ? { positionsKm: mesh.positionsKm.slice(), indices: mesh.indices.slice() } : null;
    this.groupBounds = new Float64Array(this.mesh ? groupCount * 6 : 0);
    if (!this.mesh) return;
    const { positionsKm, indices } = this.mesh;
    if (positionsKm.length < 9 || positionsKm.length % 3 !== 0 || indices.length < 3 || indices.length % 3 !== 0
      || !positionsKm.every(Number.isFinite) || indices.some(i => i >= positionsKm.length / 3)) {
      throw new Error('Malformed CPU surface mesh');
    }
    for (let group = 0; group < groupCount; group++) {
      const b = group * 6;
      this.groupBounds.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], b);
      const end = Math.min(indices.length, (group + 1) * TRIANGLES_PER_GROUP * 3);
      for (let i = group * TRIANGLES_PER_GROUP * 3; i < end; i++) {
        for (let axis = 0; axis < 3; axis++) {
          const v = positionsKm[indices[i] * 3 + axis];
          this.groupBounds[b + axis] = Math.min(this.groupBounds[b + axis], v);
          this.groupBounds[b + 3 + axis] = Math.max(this.groupBounds[b + 3 + axis], v);
        }
      }
    }
  }

  intersectRay(ray: SurfaceRay, options: SurfaceQueryOptions): SurfaceIntersection {
    this.trianglesTested = 0;
    const direction = normalizedRay(ray, options);
    const metadata = this.metadata;
    if (!this.mesh) return { kind: 'unavailable', reason: 'budget', metadata };
    const { positionsKm, indices } = this.mesh;
    const ox = ray.origin.xKm, oy = ray.origin.yKm, oz = ray.origin.zKm;
    const dx = direction[0], dy = direction[1], dz = direction[2];
    const originScale = Math.max(Math.abs(ox), Math.abs(oy), Math.abs(oz));
    let nearest = ray.farKm, triangleIndex = -1;
    let nx = 0, ny = 0, nz = 0;
    // Scalar Möller–Trumbore: no per-triangle allocation, so the scan stays
    // cheap enough for renderer consumers that cast many rays per frame.
    const groupCount = this.rejectGroups ? this.groupBounds.length / 6 : 1;
    for (let group = 0; group < groupCount; group++) {
      if (this.rejectGroups) {
        const b = group * 6;
        let near = ray.nearKm, far = nearest;
        for (let axis = 0; axis < 3 && near <= far; axis++) {
          const origin = axis === 0 ? ox : axis === 1 ? oy : oz;
          const dir = direction[axis];
          const lo = this.groupBounds[b + axis], hi = this.groupBounds[b + 3 + axis];
          // Match the intersector's body-coordinate roundoff allowance at shared
          // edges; the broad phase must not reject a hit accepted below.
          const extent = Math.max(this.groupBounds[b + 3] - this.groupBounds[b],
            this.groupBounds[b + 4] - this.groupBounds[b + 1], this.groupBounds[b + 5] - this.groupBounds[b + 2]);
          const pad = Math.max(128 * Number.EPSILON * Math.max(originScale, Math.abs(lo), Math.abs(hi), extent), 4e-12 * extent);
          if (dir === 0) { if (origin < lo - pad || origin > hi + pad) far = -Infinity; }
          else {
            const a = (lo - pad - origin) / dir, z = (hi + pad - origin) / dir;
            near = Math.max(near, Math.min(a, z));
            far = Math.min(far, Math.max(a, z));
          }
        }
        if (near > far) continue;
      }
      const end = this.rejectGroups ? Math.min(indices.length, (group + 1) * TRIANGLES_PER_GROUP * 3) : indices.length;
      for (let t = group * TRIANGLES_PER_GROUP * 3; t < end; t += 3) {
        this.trianglesTested++;
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
        // Body-fixed coordinates can be millions of times larger than a cell.
        // Subtraction then loses more than a fixed barycentric epsilon at shared
        // edges/vertices. Propagate that floating-point scale through the triangle
        // and ray determinant; this admits roundoff, not a physical seam skirt.
        const e1Bound = Math.abs(e1x) + Math.abs(e1y) + Math.abs(e1z);
        const e2Bound = Math.abs(e2x) + Math.abs(e2y) + Math.abs(e2z);
        const roundoffKm = 32 * Number.EPSILON * Math.max(originScale, Math.abs(ax), Math.abs(ay), Math.abs(az), e1Bound, e2Bound);
        const uTolerance = Math.max(1e-12, roundoffKm * e2Bound / Math.abs(determinant));
        const vTolerance = Math.max(1e-12, roundoffKm * e1Bound / Math.abs(determinant));
        const u = (sx * px + sy * py + sz * pz) / determinant;
        if (u < -uTolerance) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) / determinant;
        if (v < -vTolerance || u + v > 1 + uTolerance + vTolerance) continue;
        const distance = (e2x * qx + e2y * qy + e2z * qz) / determinant;
        if (distance < ray.nearKm || distance > nearest) continue;
        // Keep the first triangle on shared edges for deterministic provenance.
        if (triangleIndex >= 0 && distance === nearest) continue;
        nearest = distance;
        triangleIndex = t / 3;
        nx = cx / nLength; ny = cy / nLength; nz = cz / nLength;
      }
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
