import * as THREE from 'three';
import type { BodyMesh } from './BodyMesh.js';
import type { SurfaceHitSource } from './SceneHit.js';
import { surfaceTintHeightAtHit } from './SurfaceAppearance.js';
import { isDrawnCubeImagerySource } from './CubeImageryLayer.js';

export interface SurfaceRayHit {
  worldPoint: THREE.Vector3;
  /** From the ray's origin, scene units. */
  distance: number;
  bm: BodyMesh;
  source: SurfaceHitSource;
  normal: THREE.Vector3 | null;
  /** On a cube-sphere skirt (#149): the wall under a mixed-LOD gap, not the surface. */
  renderedSkirt: boolean;
  tintHeightKm?: number;
  intersection: THREE.Intersection;
  /** Visual site geometry can block an annotation but cannot certify a geographic anchor. */
  annotationBlocker: boolean;
}

const _normalMatrix = new THREE.Matrix3();
export function surfaceNormalWorld(hit: THREE.Intersection): THREE.Vector3 | null {
  if (!hit.face) return null;
  return hit.face.normal.clone().applyMatrix3(_normalMatrix.getNormalMatrix(hit.object.matrixWorld)).normalize();
}

/** Visible authoritative geometry only. CPU grids and visual-only site reconstructions
 * do not certify attachment. Hidden cache entries are excluded; imagery draw sources
 * retain the same exception as picking. Annotation callers may include visual-only
 * blockers explicitly; those hits never authorize placement. Never changes geometry
 * or raycaster state. Overlay transforms must already be restored to world space. */
export function castRenderedSurfaces(raycaster: THREE.Raycaster, bodies: readonly BodyMesh[], scaleFactor: number, options: { visualBlockers?: boolean } = {}): SurfaceRayHit | null {
    // Broad phase. Terrain tiles and surface overlays can be hundreds of
    // meshes, and this runs at hover rate while probing; a body whose
    // true-scale surface the ray cannot reach skips them all. The globe mesh
    // is one object (and may be enlarged to a minimum on-screen size), so it
    // is always left to the raycaster's own bounding test.
    const reachable = new Set<BodyMesh>();
    const center = new THREE.Vector3();
    const reach = new THREE.Sphere();
    for (const bm of bodies) {
      if (!bm.visible || (!bm.terrainTileGroup && bm.getSurfaceOverlays().length === 0)) continue;
      bm.getWorldPosition(center);
      // Room for relief above the datum (Olympus Mons is ~22 km) and overlay offsets.
      const radiusKm = bm.displayRadius * 1.01 + 30;
      if (raycaster.ray.intersectsSphere(reach.set(center, radiusKm * scaleFactor))) reachable.add(bm);
    }

    // Main scene: globe spheres, authoritative DSKs and terrain tiles. The raycaster
    // ignores ancestor visibility, so a hidden body is skipped here.
    const mainTargets: THREE.Object3D[] = [];
    const visualOwners = new Map<THREE.Object3D, BodyMesh>();
    for (const bm of bodies) {
      if (!bm.visible) continue;
      if (bm.mesh.visible) mainTargets.push(bm.mesh);
      mainTargets.push(...bm.getDskMeshes());
      const tg = bm.terrainTileGroup;
      if (tg && tg.visible && reachable.has(bm)) mainTargets.push(tg);
      if (options.visualBlockers && reachable.has(bm)) for (const overlay of bm.getSurfaceOverlays()) {
        if (overlay.group.visible) { mainTargets.push(overlay.group); visualOwners.set(overlay.group, bm); }
      }
    }
    const visible = (hit: THREE.Intersection) => {
      for (let object: THREE.Object3D | null = hit.object; object; object = object.parent) if (!object.visible && !isDrawnCubeImagerySource(object)) return false;
      return true;
    };
    // Three raycasts cached hidden meshes too. A point pick must follow the
    // currently visible LOD rather than a nearer, inactive cached tile.
    const mainHits = raycaster.intersectObjects(mainTargets, true).filter(visible);

    // Pick the closest hit
    let bestWorldPoint: THREE.Vector3 | null = null;
    let bestBm: BodyMesh | null = null;
    let bestDist = Infinity;
    let tintHeightKm: number | undefined;
    let renderedSkirt = false;
    let source: SurfaceHitSource = 'ellipsoid';
    let bestNormal: THREE.Vector3 | null = null;
    let intersection: THREE.Intersection | null = null;
    let annotationBlocker = false;

    if (mainHits.length > 0) {
      const hit = mainHits[0];
      if (hit.distance < bestDist) {
        intersection = hit;
        bestDist = hit.distance;
        bestWorldPoint = hit.point.clone();
        tintHeightKm = surfaceTintHeightAtHit(hit);
        const surfaceTriangles = (hit.object as THREE.Mesh).geometry?.userData?.surfaceTriangles;
        renderedSkirt = typeof surfaceTriangles === 'number' && hit.faceIndex != null && hit.faceIndex >= surfaceTriangles;
        bestNormal = surfaceNormalWorld(hit);
        if (hit.object.userData.dskSurface) source = 'dsk';
        for (const bm of bodies) {
          let obj: THREE.Object3D | null = hit.object;
          const terrain = bm.terrainTileGroup;
          while (obj) {
            if (terrain && obj === terrain) source = 'terrain';
            if (visualOwners.get(obj) === bm) { bestBm = bm; annotationBlocker = true; source = 'surface-overlay'; break; }
            if (obj === bm) { bestBm = bm; break; }
            obj = obj.parent;
          }
          if (bestBm) break;
        }
      }
    }

    if (!bestWorldPoint || !bestBm) return null;
    return { worldPoint: bestWorldPoint, distance: bestDist, bm: bestBm, source, normal: bestNormal, renderedSkirt, tintHeightKm, intersection: intersection!, annotationBlocker };
}
