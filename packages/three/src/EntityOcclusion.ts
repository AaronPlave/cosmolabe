import * as THREE from 'three';
import type { BodyMesh } from './BodyMesh.js';
import { ContourOcclusion } from './ContourOcclusion.js';

const ANCHOR_HEIGHT_TOLERANCE_KM = 0.003;
const MIN_GRAZING_SINE = 0.03;

type OccluderTest = (body: BodyMesh, ray: THREE.Ray, distance: number) => boolean | null;

/** Analytic limb fade for bodies without a triangle test for this anchor. */
export class AnchorOcclusion {
  private readonly ray = new THREE.Ray();
  private readonly toOccluder = new THREE.Vector3();

  fade(
    eye: THREE.Vector3, point: THREE.Vector3, distance: number, bodies: readonly BodyMesh[],
    owner?: BodyMesh, test?: OccluderTest,
  ): number {
    const ray = this.ray;
    ray.origin.copy(eye);
    ray.direction.subVectors(point, eye);
    if (!distance) return 1;
    ray.direction.divideScalar(distance);

    let fade = 1;
    for (const body of bodies) {
      if (body === owner || !body.present) continue;
      const hidden = test ? test(body, ray, distance) : body.dskOccludes(eye, point);
      if (hidden !== null) {
        if (hidden) return 0;
        continue;
      }

      // Large analytic occluders get a smooth fade near the limb.
      if (body.displayRadius < 50) continue;
      const radius = body.displayRadius * body.scaleFactor;
      if (radius < 1e-6) continue;
      const offset = this.toOccluder.subVectors(body.position, eye);
      const distSq = offset.lengthSq();
      if (distSq <= radius * radius) continue;
      const along = offset.dot(ray.direction);
      const closestSq = Math.max(0, distSq - along * along);
      if (closestSq >= radius * radius) continue;
      const halfChord = Math.sqrt(radius * radius - closestSq);
      if (along + halfChord <= 0 || along - halfChord >= distance) continue;
      const depth = radius - Math.sqrt(closestSq);
      const t = Math.max(0, 1 - depth / (radius * 0.04));
      fade = Math.min(fade, t * t * (3 - 2 * t));
    }
    return fade;
  }
}

interface Visibility {
  frame: number;
  value: number;
  target: number;
  sample: number;
}

/** A frame's line of sight to each entity's real scene position. */
export class EntityOcclusion {
  private readonly analytic = new AnchorOcclusion();
  private readonly triangles = new ContourOcclusion();
  private readonly radial = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly surfaces = new Map<BodyMesh, THREE.Mesh[]>();
  private readonly plates = new Map<BodyMesh, THREE.Mesh[]>();
  private readonly states = new WeakMap<BodyMesh, Visibility>();
  private frame = 0;

  constructor(private readonly drawnSurfaceMeshes: (body: BodyMesh) => THREE.Mesh[]) {}

  beginFrame(): void {
    this.frame++;
    this.surfaces.clear();
    this.plates.clear();
  }

  visibility(owner: BodyMesh, camera: THREE.PerspectiveCamera, bodies: readonly BodyMesh[]): number {
    const prev = this.states.get(owner);
    if (prev?.frame === this.frame) return prev.value;

    // The label sprite is offset on screen, but visibility belongs to the anchor.
    if (!owner.present || this.view.copy(owner.position).applyMatrix4(camera.matrixWorldInverse).z >= -camera.near) {
      this.states.delete(owner);
      return 0;
    }

    const distance = camera.position.distanceTo(owner.position);
    const raw = this.analytic.fade(camera.position, owner.position, distance, bodies, owner, (body, ray, range) => {
      if (!body.visible) return false;
      const isParent = body.body.name === owner.body.parentName;
      const streamed = body.terrainTileGroup?.visible;
      const drawGlobe = isParent && body.body.geometryType === 'Globe' && body.mesh.visible;
      const drawSurface = !!streamed || drawGlobe;
      const meshes = this.meshes(body, drawSurface);
      // While terrain streams, a missing tile is a gap in the drawn surface.
      // The reference globe has been hidden and cannot fill that gap.
      if (!drawSurface && meshes.length === 0) return null;

      // End a few metres above the anchor along the local radial normal. This
      // covers floating-point error and a landmark resting on a triangle. Cap
      // the grazing allowance so the ray still sees intervening relief.
      const radial = this.radial.subVectors(owner.position, body.position).normalize();
      const sine = Math.max(MIN_GRAZING_SINE, Math.abs(radial.dot(ray.direction)));
      const far = range - ANCHOR_HEIGHT_TOLERANCE_KM * body.scaleFactor / sine;
      return far > 0 && meshes.some(mesh => this.triangles.intersects(mesh, ray, far));
    });

    // Ignore a single frame of disagreement at a tile boundary. Both
    // annotations then ease toward the same verdict.
    const continuous = prev?.frame === this.frame - 1;
    let target = raw;
    if (continuous && raw !== prev.target && (raw === 0 || raw === 1) && raw !== prev.sample) {
      target = prev.target;
    }
    const value = continuous ? prev.value + (target - prev.value) * 0.25 : target;
    this.states.set(owner, { frame: this.frame, value, target, sample: raw });
    return value;
  }

  private meshes(body: BodyMesh, drawSurface: boolean): THREE.Mesh[] {
    const cache = drawSurface ? this.surfaces : this.plates;
    let meshes = cache.get(body);
    if (!meshes) {
      meshes = drawSurface ? [...this.drawnSurfaceMeshes(body), ...body.getDskMeshes()] : body.getDskMeshes();
      for (const mesh of meshes) mesh.updateWorldMatrix(true, false);
      cache.set(body, meshes);
    }
    return meshes;
  }
}
