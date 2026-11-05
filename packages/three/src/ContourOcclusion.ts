import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** Private acceleration for annotation LOS. Indirect BVHs preserve source
 * plate/index order; neither geometry.boundsTree nor mesh.raycast is changed,
 * so picking, measurements and the terrain renderer keep their own behavior. */
export class ContourOcclusion {
  private readonly trees = new WeakMap<THREE.BufferGeometry, MeshBVH>();
  private readonly sphere = new THREE.Sphere();
  private readonly inverse = new THREE.Matrix4();
  private readonly ray = new THREE.Ray();
  private readonly end = new THREE.Vector3();
  private readonly hit = new THREE.Vector3();

  intersects(mesh: THREE.Mesh, ray: THREE.Ray, far: number): boolean {
    return this.firstHit(mesh, ray, far) !== null;
  }

  /** Distance along `ray` (world units) to the mesh's first triangle within `far`, or null. */
  firstHit(mesh: THREE.Mesh, ray: THREE.Ray, far: number): number | null {
    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (!ray.intersectsSphere(this.sphere.copy(geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld))) return null;
    this.inverse.copy(mesh.matrixWorld).invert();
    this.ray.copy(ray).applyMatrix4(this.inverse);
    // Transform the actual ray segment, including non-uniform source scale.
    const localFar = ray.at(far, this.end).applyMatrix4(this.inverse).distanceTo(this.ray.origin);
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    if (!this.ray.intersectBox(box, this.hit)
      || (!box.containsPoint(this.ray.origin) && this.hit.distanceTo(this.ray.origin) > localFar)) return null;
    let tree = this.trees.get(geometry);
    if (!tree) {
      tree = new MeshBVH(geometry, { indirect: true });
      this.trees.set(geometry, tree);
    }
    const hit = tree.raycastFirst(this.ray, mesh.material, 0, localFar);
    // Back to world units: the local ray's scale need not be the world's.
    return hit ? hit.point.applyMatrix4(mesh.matrixWorld).distanceTo(ray.origin) : null;
  }
}
