import { BackSide, DoubleSide, Matrix4, Mesh, Ray, Vector3 } from 'three';
import type { BodyMesh } from '../BodyMesh.js';

/** Cooperative annotation-only triangle query. Each step tests at most 128
 * triangles; no BVH/CPU mesh construction or source mutation occurs here.
 * Picking and scientific queries retain their existing synchronous path. */
export function* placeRaycast(ray: Ray, far: number, bodies: readonly BodyMesh[]):
  Generator<void, { body: BodyMesh; point: Vector3; distance: number } | null> {
  let best: { body: BodyMesh; point: Vector3; distance: number } | null = null;
  const queue = bodies.filter(b => b.visible).map(body => ({ object: body as import('three').Object3D, body }));
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3();
  while (queue.length) {
    yield;
    const { object, body } = queue.pop()!;
    if (!object.visible) continue;
    // Only authoritative geometry: globe, DSK and terrain.
    if (object === body) {
      if (body.mesh.visible) queue.push({ object: body.mesh, body });
      for (const mesh of body.getDskMeshes()) queue.push({ object: mesh, body });
      if (body.terrainTileGroup?.visible) queue.push({ object: body.terrainTileGroup, body });
      continue;
    }
    for (const child of object.children) queue.push({ object: child, body });
    if (!(object instanceof Mesh) || (object.layers.mask & 1) === 0) continue;
    const geometry = object.geometry, position = geometry.getAttribute('position');
    if (!position) continue;
    const matrix = object.matrixWorld.clone();
    const local = ray.clone().applyMatrix4(new Matrix4().copy(matrix).invert());
    if (geometry.boundingSphere && !local.intersectsSphere(geometry.boundingSphere)) continue;
    if (geometry.boundingBox && !local.intersectsBox(geometry.boundingBox)) continue;
    const index = geometry.index;
    const count = index?.count ?? position.count;
    const groups = Array.isArray(object.material) ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const group of groups) {
      const material = Array.isArray(object.material) ? object.material[group.materialIndex ?? 0] : object.material;
      if (!material) continue;
      const start = Math.max(group.start, geometry.drawRange.start);
      const end = Math.min(count, group.start + group.count, geometry.drawRange.start + geometry.drawRange.count);
      for (let i = start; i < end; i += 3) {
        if ((i - start) % 384 === 0) yield;
        a.fromBufferAttribute(position, index ? index.getX(i) : i);
        b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1);
        c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2);
        const point = material.side === BackSide ? local.intersectTriangle(c, b, a, true, hit)
          : local.intersectTriangle(a, b, c, material.side !== DoubleSide, hit);
        if (!point) continue;
        point.applyMatrix4(matrix);
        const distance = point.distanceTo(ray.origin);
        if (distance <= far && (!best || distance < best.distance)) best = { body, distance, point: point.clone() };
      }
    }
  }
  return best;
}
