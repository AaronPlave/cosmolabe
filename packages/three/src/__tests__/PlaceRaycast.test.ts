import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Ray, Raycaster, SphereGeometry, Vector3 } from 'three';
import type { BodyMesh } from '../BodyMesh.js';
import { placeRaycast } from '../geographic/PlaceRaycast.js';

describe('cooperative place raycasts', () => {
  it('matches rendered nearest hits across transforms and hidden LODs without calling mesh.raycast', () => {
    const body = new Group() as unknown as BodyMesh;
    const globe = new Mesh(new SphereGeometry(1, 64, 32), new MeshBasicMaterial());
    const terrain = new Group();
    const near = new Mesh(new BoxGeometry(.3, .3, .1), new MeshBasicMaterial());
    near.position.z = 1.2; terrain.add(near);
    const hidden = near.clone(); hidden.position.z = 1.5; hidden.visible = false; terrain.add(hidden);
    Object.assign(body, { mesh: globe, terrainTileGroup: terrain, getDskMeshes: () => [] });
    const otherLayer = near.clone(); otherLayer.position.z = 1.6; otherLayer.layers.set(2); terrain.add(otherLayer);
    body.add(globe, terrain); body.position.set(5, 6, 7); body.scale.set(2, 3, 4); body.updateMatrixWorld(true);
    const ray = new Ray(new Vector3(5, 6, 20), new Vector3(0, 0, -1));
    const expected = new Raycaster(ray.origin, ray.direction).intersectObjects([globe, near])[0];
    near.raycast = () => { throw new Error('synchronous raycast'); };
    const query = placeRaycast(ray, 20, [body]); let step = query.next(), chunks = 0;
    while (!step.done) { chunks++; step = query.next(); }
    expect(chunks).toBeGreaterThan(2);
    expect(step.value?.distance).toBeCloseTo(expected.distance, 9);
    expect(step.value?.point.distanceTo(expected.point)).toBeLessThan(1e-9);
    const miss = placeRaycast(ray, 1, [body]); let next = miss.next(); while (!next.done) next = miss.next();
    expect(next.value).toBeNull();
  });
});
