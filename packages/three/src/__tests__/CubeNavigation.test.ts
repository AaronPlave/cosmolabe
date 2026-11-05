import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { needsNearSurfaceDetail, radialCellRadius, radialCubeCoordinates, renderedCubeRadius } from '../surface/CubeNavigation.js';
import { cubeFaceToDirection, type CubeHeightTile } from '../surface/CubeSphere.js';
import { cubeTileMesh } from '../surface/CubeSphereGrids.js';

function tile(root: THREE.Group, radius: number, skirtRadius = radius+50): THREE.Group {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    radius,-5,-5, radius,5,-5, radius,0,5,
    skirtRadius,-5,-5, skirtRadius,5,-5, skirtRadius,0,5,
  ], 3));
  geometry.setIndex([0,1,2,3,4,5]);
  geometry.userData.surfaceTriangles = 1;
  const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry)); root.add(scene);
  return scene;
}

describe('cube near-surface loading and navigation', () => {
  it('matches exhaustive radial lattice triangle intersections across cube faces and levels', () => {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    for (const face of ['px','nx','py','ny','pz','nz'] as const) for (const level of [0,3,15]) {
      const tile: CubeHeightTile = { face, level, x: level ? 2 : 0, y: level ? 3 : 0, width: 17, height: 17,
        elevationsKm: Float64Array.from({length: 289}, (_, i) => Math.sin(i*.73)*.01) };
      const mesh = cubeTileMesh(tile, 3396.19);
      for (const [u,v] of [[.173,.371],[.913,.613],[.437,.843]]) {
        const direction = new THREE.Vector3(...cubeFaceToDirection(face, -1+2*(tile.x+u)/2**level, -1+2*(tile.y+v)/2**level));
        const ray = new THREE.Ray(direction.clone().multiplyScalar(3450), direction.clone().negate());
        let expected: number | null = null;
        for (let i = 0; i < mesh.indices.length; i += 3) {
          a.fromArray(mesh.positionsKm, mesh.indices[i]*3); b.fromArray(mesh.positionsKm, mesh.indices[i+1]*3); c.fromArray(mesh.positionsKm, mesh.indices[i+2]*3);
          if (ray.intersectTriangle(a,b,c,false,hit)) expected = Math.max(expected ?? -Infinity, hit.dot(direction));
        }
        expect(expected).not.toBeNull();
        expect(radialCellRadius(tile,u,v,direction,3396.19,3450)).toBeCloseTo(expected!,9);
      }
      expect(radialCellRadius(tile,0,.371,new THREE.Vector3(1,0,0),3396.19,3450)).toBeNull();
      expect(radialCellRadius(tile,.5,.371,new THREE.Vector3(1,0,0),3396.19,3450)).toBeNull();
    }
  });
  it('requests radial coverage at all closed incident tile edges and cube faces without a shell march', () => {
    const interior = radialCubeCoordinates(new THREE.Vector3(1, .12345, .31415), 15);
    expect(interior).toHaveLength(1);
    expect(interior[0].face).toBe('px');
    const centre = radialCubeCoordinates(new THREE.Vector3(1, 0, 0), 15);
    expect(centre).toHaveLength(4);
    expect(centre.some(c => c.u < 0 && c.v < 0)).toBe(true);
    expect(centre.some(c => c.u > 0 && c.v > 0)).toBe(true);
    const edge = radialCubeCoordinates(new THREE.Vector3(1, 1, 0), 15);
    expect(edge).toHaveLength(4);
    expect(new Set(edge.map(c => c.face))).toEqual(new Set(['px', 'py']));
    const corner = radialCubeCoordinates(new THREE.Vector3(1, 1, 1), 15);
    expect(corner).toHaveLength(3);
    expect(new Set(corner.map(c => c.face))).toEqual(new Set(['px', 'py', 'pz']));
    expect([...centre, ...edge, ...corner].every(c => Math.abs(c.u) <= 1 && Math.abs(c.v) <= 1)).toBe(true);
  });
  it('refines all nearby neighbours at a shared boundary independently of the view frustum', () => {
    const detail = { eye: new THREE.Vector3(100,0,0), radiusM: 500, maxErrorM: .5 };
    const volume = (distance: number) => ({ distanceToPoint: () => distance });
    expect(needsNearSurfaceDetail(volume(0), 280, detail)).toBe(true);
    expect(needsNearSurfaceDetail(volume(500), 1, detail)).toBe(true);
    expect(needsNearSurfaceDetail(volume(501), 280, detail)).toBe(false);
    expect(needsNearSurfaceDetail(volume(0), .5, detail)).toBe(false);
    expect(needsNearSurfaceDetail(volume(0), 280, null)).toBe(false);
    expect(needsNearSurfaceDetail(undefined, 280, detail)).toBe(false);
  });

  it('uses only selected GLB surfaces through cold, coarse, refining and evicted states', () => {
    const root = new THREE.Group(), direction = new THREE.Vector3(1,0,0);
    expect(renderedCubeRadius([], root, direction, 1000)).toBeNull();
    const parent = tile(root, 120), fine = tile(root, 100);
    expect(renderedCubeRadius([parent], root, direction, 1000)).toBeCloseTo(120, 8);
    // During a fade both surfaces can be drawn; keep clearance above both.
    expect(renderedCubeRadius([parent, fine], root, direction, 1000)).toBeCloseTo(120, 8);
    // A cached parent and its skirts must not keep pushing the eye after swap.
    expect(renderedCubeRadius([fine], root, direction, 1000)).toBeCloseTo(100, 8);
    expect(renderedCubeRadius([parent], root, direction, 1000)).toBeCloseTo(120, 8);
  });

  it('handles transformed glTF ancestors, hidden imagery source meshes and body-relative roots', () => {
    const root = new THREE.Group(); root.position.set(1e12,-1e12,1e12); root.scale.setScalar(1e-9);
    const scene = tile(root,100); scene.position.x = 3;
    scene.children[0].visible = false; // source replaced by draped imagery
    expect(renderedCubeRadius([scene],root,new THREE.Vector3(1,0,0),1000)).toBeCloseTo(103,8);
    scene.removeFromParent();
    expect(renderedCubeRadius([scene],root,new THREE.Vector3(1,0,0),1000)).toBeNull();
  });

  it('preserves unavailable coverage beside a tile instead of intersecting its skirt', () => {
    const root = new THREE.Group(), scene = tile(root,100);
    expect(renderedCubeRadius([scene],root,new THREE.Vector3(1,1,0),1000)).toBeNull();
    expect(renderedCubeRadius([scene],root,new THREE.Vector3(),1000)).toBeNull();
  });
});
