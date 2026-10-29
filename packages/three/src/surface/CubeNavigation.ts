import * as THREE from 'three';
import { cubeFaceBasis, cubeFaceToDirection, type CubeFaceCoordinate, type CubeHeightTile } from './CubeSphere.js';

/** Exact intersection of a strictly interior radial lattice cell. Its four
 * vertices and diagonal are identical to cubeTileMesh; cell/tile/face edges
 * return null so the general query retains its closed-boundary ownership rule.
 */
export function radialCellRadius(tile: CubeHeightTile, localU: number, localV: number,
  direction: THREE.Vector3, referenceRadiusKm: number, outerRadiusKm: number): number | null {
  const x = localU * (tile.width - 1), y = localV * (tile.height - 1), i = Math.floor(x), j = Math.floor(y);
  if (![x, y].every(Number.isFinite) || i < 0 || j < 0 || i >= tile.width - 1 || j >= tile.height - 1 ||
    Math.min(x-i, 1-(x-i), y-j, 1-(y-j)) <= 1e-7) return null;
  const vertex = (a: number, b: number) => {
    const nu = (tile.width - 1) * 2 ** tile.level, nv = (tile.height - 1) * 2 ** tile.level;
    const u = (2 * ((tile.width - 1) * tile.x + a) - nu) / nu, v = (2 * ((tile.height - 1) * tile.y + b) - nv) / nv;
    const d = cubeFaceToDirection(tile.face, u, v), radius = referenceRadiusKm + tile.elevationsKm[b * tile.width + a];
    return new THREE.Vector3(d[0]*radius, d[1]*radius, d[2]*radius);
  };
  const vertices = [vertex(i,j), vertex(i+1,j), vertex(i+1,j+1), vertex(i,j+1)];
  const d = direction.clone().normalize(), ray = new THREE.Ray(d.clone().multiplyScalar(outerRadiusKm), d.clone().negate()), hit = new THREE.Vector3();
  let radius: number | null = null;
  for (const [a,b,c] of [[0,1,2], [0,2,3]]) if (ray.intersectTriangle(vertices[a],vertices[b],vertices[c],false,hit)) {
    const r = hit.dot(d);
    if (Number.isFinite(r) && r >= 0 && r <= outerRadiusKm && (radius === null || r > radius)) radius = r;
  }
  return radius;
}

/** A radial ray has a constant cube coordinate throughout the height shell.
 * Request its closed incident footprints directly, including both sides of
 * dyadic tile edges and all incident cube faces. An oblique ray still needs
 * the general surface march; this helper is only for body-centred navigation.
 */
export function radialCubeCoordinates(direction: THREE.Vector3, maxLevel: number): CubeFaceCoordinate[] {
  const result: CubeFaceCoordinate[] = [], count = 2 ** maxLevel, roundoff = 32 * Number.EPSILON;
  const seen = new Set<string>();
  const sides = (value: number) => Math.abs((value + 1) * count / 2 - Math.round((value + 1) * count / 2)) <= roundoff * count
    ? [...new Set([Math.max(-1, value - roundoff * 2), Math.min(1, value + roundoff * 2)])] : [value];
  const dot = (axis: readonly number[]) => direction.x * axis[0] + direction.y * axis[1] + direction.z * axis[2];
  for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const) {
    const [n, uAxis, vAxis] = cubeFaceBasis(face), scale = dot(n);
    if (scale <= 0) continue;
    const u = dot(uAxis) / scale, v = dot(vAxis) / scale;
    if (Math.abs(u) > 1 + roundoff || Math.abs(v) > 1 + roundoff) continue;
    for (const a of sides(Math.max(-1, Math.min(1, u)))) for (const b of sides(Math.max(-1, Math.min(1, v)))) {
      const key = `${face}/${Math.min(count - 1, Math.floor((a + 1) * count / 2))}/${Math.min(count - 1, Math.floor((b + 1) * count / 2))}`;
      if (!seen.has(key)) { seen.add(key); result.push({ face, u: a, v: b }); }
    }
  }
  return result;
}

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
