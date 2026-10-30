import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Body, FixedPointTrajectory } from '@cosmolabe/core';
import { BodyMesh } from '../BodyMesh.js';
import { castRenderedSurfaces } from '../RenderedSurfaceQuery.js';

function fixture() {
  const bm = new BodyMesh(new Body({ name: 'Moon', radii: [100, 100, 100],
    geometryType: 'Globe', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
  bm.updatePosition([0, 0, 0], 0, 1); bm.applyMeshScale(1); bm.mesh.visible = false;
  const terrain = new THREE.Group(); bm.add(terrain);
  vi.spyOn(bm, 'terrainTileGroup', 'get').mockReturnValue(terrain);
  const ray = new THREE.Raycaster(new THREE.Vector3(300, 0, 0), new THREE.Vector3(-1, 0, 0));
  const add = (radius: number) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 16), new THREE.MeshBasicMaterial());
    terrain.add(mesh); bm.updateMatrixWorld(true); return mesh;
  };
  return { bm, terrain, ray, add };
}
describe('shared rendered surface discovery', () => {
  it('uses the active LOD, rejects hidden caches immediately, and recovers without CPU samples', () => {
    const { bm, terrain, ray, add } = fixture();
    const cached = add(110), active = add(100); cached.visible = false;
    const cpu = vi.spyOn(bm, 'sampleTerrain');
    const hit = castRenderedSurfaces(ray, [bm], 1)!;
    expect(hit.intersection.object).toBe(active); expect(hit.bm).toBe(bm); expect(hit.source).toBe('terrain');
    expect(hit.distance).toBeCloseTo(200); expect(cpu).not.toHaveBeenCalled();
    active.visible = false; expect(castRenderedSurfaces(ray, [bm], 1)).toBeNull();
    cached.visible = true; expect(castRenderedSurfaces(ray, [bm], 1)?.intersection.object).toBe(cached);
    terrain.visible = false; expect(castRenderedSurfaces(ray, [bm], 1)).toBeNull();
    terrain.visible = true; bm.visible = false; expect(castRenderedSurfaces(ray, [bm], 1)).toBeNull();
    bm.visible = true; expect(castRenderedSurfaces(ray, [bm], 1)).not.toBeNull(); bm.dispose();
  });
  it('retains nearest ownership and the actual facet, including authoritative DSKs', () => {
    const { bm, ray, add } = fixture(); const mesh = add(100);
    mesh.removeFromParent(); bm.add(mesh); bm.updateMatrixWorld(true);
    vi.spyOn(bm, 'getDskMeshes').mockReturnValue([mesh]);
    mesh.userData.dskSurface = true;
    expect(castRenderedSurfaces(ray, [bm], 1)?.source).toBe('dsk');
    const nearer = new BodyMesh(new Body({ name: 'Foreign', radii: [1, 1, 1], geometryType: 'Globe', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    nearer.updatePosition([200, 0, 0], 0, 1); nearer.applyMeshScale(1); nearer.updateMatrixWorld(true);
    expect(castRenderedSurfaces(ray, [bm, nearer], 1)?.bm).toBe(nearer);
    nearer.visible = false;
    const hit = castRenderedSurfaces(ray, [bm, nearer], 1)!;
    expect(hit.intersection.face).not.toBeNull(); expect(hit.intersection.object).toBe(mesh); expect(hit.bm).toBe(bm);
    nearer.dispose(); bm.dispose();
  });
  it('does not promote visual-only site reconstructions or CPU data to authoritative geometry', () => {
    const { bm, ray } = fixture();
    const local = new THREE.Group(); local.add(new THREE.Mesh(new THREE.SphereGeometry(120), new THREE.MeshBasicMaterial()));
    local.updateMatrixWorld(true);
    vi.spyOn(bm, 'getSurfaceOverlays').mockReturnValue([{ group: local }] as never);
    expect(castRenderedSurfaces(ray, [bm], 1)).toBeNull();
    expect(castRenderedSurfaces(ray, [bm], 1, { visualBlockers: true })).toMatchObject({ bm, annotationBlocker: true, source: 'surface-overlay' }); bm.dispose();
  });
});
