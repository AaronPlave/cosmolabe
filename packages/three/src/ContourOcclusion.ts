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
    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (!ray.intersectsSphere(this.sphere.copy(geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld))) return false;
    this.inverse.copy(mesh.matrixWorld).invert();
    this.ray.copy(ray).applyMatrix4(this.inverse);
    // Transform the actual ray segment, including non-uniform source scale.
    const localFar = ray.at(far, this.end).applyMatrix4(this.inverse).distanceTo(this.ray.origin);
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    if (!this.ray.intersectBox(box, this.hit)
      || (!box.containsPoint(this.ray.origin) && this.hit.distanceTo(this.ray.origin) > localFar)) return false;
    let tree = this.trees.get(geometry);
    if (!tree) {
      tree = new MeshBVH(geometry, { indirect: true });
      this.trees.set(geometry, tree);
    }
    return tree.raycastFirst(this.ray, mesh.material, 0, localFar) !== null;
  }
}
