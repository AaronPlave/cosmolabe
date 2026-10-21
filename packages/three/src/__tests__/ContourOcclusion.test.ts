import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ContourOcclusion } from '../ContourOcclusion.js';

describe('contour annotation occlusion', () => {
  it('matches source raycasts over transformed ray segments without changing picking or plate order', () => {
    const geometry = new THREE.PlaneGeometry(100, 100, 20, 20), material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material), queries = new ContourOcclusion();
    mesh.scale.set(2, 0.5, 3); mesh.rotation.set(0.4, -0.8, 0.2); mesh.position.set(10000, -20000, 30000);
    mesh.updateMatrixWorld(true);
    const indices = Array.from(geometry.index!.array), positions = Array.from(geometry.getAttribute('position').array), raycast = mesh.raycast;
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
    for (const x of [-150, 0, 150]) for (const distance of [20, 50, 80]) for (const far of [10, 40, 100]) {
      const point = new THREE.Vector3(x, 0, 0).applyMatrix4(mesh.matrixWorld);
      const ray = new THREE.Ray(point.clone().addScaledVector(normal, distance), normal.clone().negate());
      const source = new THREE.Raycaster(ray.origin, ray.direction, 0, far), hits: THREE.Intersection[] = [];
      mesh.raycast(source, hits);
      expect(queries.intersects(mesh, ray, far)).toBe(hits.length > 0);
    }
    expect(Array.from(geometry.index!.array)).toEqual(indices);
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(positions);
    expect(geometry.boundsTree).toBeUndefined(); expect(mesh.raycast).toBe(raycast);
  });

  it('honors material side and does not extend the ray beyond its anchor', () => {
    const geometry = new THREE.PlaneGeometry(100, 100), material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material), queries = new ContourOcclusion();
    mesh.updateMatrixWorld(true);
    const ray = new THREE.Ray(new THREE.Vector3(0, 0, -5), new THREE.Vector3(0, 0, 1));
    expect(queries.intersects(mesh, ray, 10)).toBe(false);
    material.side = THREE.DoubleSide;
    expect(queries.intersects(mesh, ray, 4)).toBe(false);
    expect(queries.intersects(mesh, ray, 6)).toBe(true);
    geometry.dispose(); material.dispose();
  });
});
