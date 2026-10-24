import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { needsNearSurfaceDetail, renderedCubeRadius } from '../surface/CubeNavigation.js';

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
