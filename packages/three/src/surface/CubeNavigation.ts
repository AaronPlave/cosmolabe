import * as THREE from 'three';

export interface NearSurfaceDetail {
  /** Body-fixed metres. */
  eye: THREE.Vector3;
  radiusM: number;
  maxErrorM: number;
}

/** A physical neighbourhood refines independently of view direction/FOV.
 * Outside it, the ordinary screen-space traversal remains authoritative.
 * The bounding-volume distance includes adjacent tiles at a tile/face edge.
 */
export function needsNearSurfaceDetail(
  volume: { distanceToPoint(p: THREE.Vector3): number } | undefined,
  geometricError: number,
  detail: NearSurfaceDetail | null,
): boolean {
  return !!detail && !!volume && geometricError > detail.maxErrorM &&
    volume.distanceToPoint(detail.eye) <= detail.radiusM;
}

/** Intersect the currently selected cube GLBs, excluding their skirts/caps.
 * Scenes are in the cube root's body-fixed metre frame. Include source meshes
 * hidden by imagery blocks: imagery clips/drapes the same physical triangles.
 * The source scene list must exclude cached inactive tiles.
 */
export function renderedCubeRadius(
  scenes: Iterable<THREE.Object3D>, root: THREE.Object3D, direction: THREE.Vector3, outerRadiusM: number,
): number | null {
  const d = direction.clone().normalize();
  if (!Number.isFinite(outerRadiusM) || outerRadiusM <= 0 || d.lengthSq() === 0) return null;
  const bodyRay = new THREE.Ray(d.clone().multiplyScalar(outerRadiusM), d.clone().negate());
  const matrix = new THREE.Matrix4(), inverse = new THREE.Matrix4();
  const localRay = new THREE.Ray();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
  let radius: number | null = null;
  for (const scene of scenes) scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || mesh.name.startsWith('cube-imagery-block ')) return;
    const geometry = mesh.geometry, index = geometry.index;
    const count = geometry.userData.surfaceTriangles;
    if (!index || !Number.isSafeInteger(count) || count <= 0 || count*3 > index.count) return;
    matrix.identity();
    let node: THREE.Object3D | null = mesh;
    while (node && node !== root) {
      if (node.matrixAutoUpdate) node.updateMatrix();
      matrix.premultiply(node.matrix);
      node = node.parent;
    }
    if (node !== root || matrix.determinant() === 0) return;
    localRay.copy(bodyRay).applyMatrix4(inverse.copy(matrix).invert());
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox || !localRay.intersectsBox(geometry.boundingBox)) return;
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < count*3; i += 3) {
      a.fromBufferAttribute(positions, index.getX(i));
      b.fromBufferAttribute(positions, index.getX(i+1));
      c.fromBufferAttribute(positions, index.getX(i+2));
      if (!localRay.intersectTriangle(a, b, c, false, hit)) continue;
      hit.applyMatrix4(matrix);
      const r = hit.dot(d);
      if (r >= 0 && r <= outerRadiusM && (radius === null || r > radius)) radius = r;
    }
  });
  return radius;
}
