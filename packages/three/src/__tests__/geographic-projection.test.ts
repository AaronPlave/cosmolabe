import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { TerrainDatum } from '@cosmolabe/core';
import { UniverseRenderer } from '../UniverseRenderer.js';
import { ContourOcclusion } from '../ContourOcclusion.js';

const datum: TerrainDatum = { referenceShape: { kind: 'sphere', radiusKm: 1000 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' };

function harness(options: { terrain?: TerrainDatum | null; visible?: boolean } = {}) {
  // Camera 3000 km out along body-fixed +X (lon 0, lat 0), looking at the centre.
  const camera = new THREE.PerspectiveCamera(60, 2, 1, 1e6);
  camera.position.set(3000, 0, 0);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const sampleTerrain = vi.fn(() => ({ elevationKm: 500 }));
  const body = {
    visible: options.visible ?? true, position: new THREE.Vector3(), terrainDatum: options.terrain ?? null, sampleTerrain,
    bodyToWorldQuaternion: (q: THREE.Quaternion) => q.identity(),
  };
  const renderer = Object.assign(Object.create(UniverseRenderer.prototype), {
    bodyMeshes: new Map([['Moon', body]]), camera, scaleFactor: 1,
    renderer: { domElement: { clientWidth: 800, clientHeight: 400 } },
  }) as UniverseRenderer;
  return { renderer, sampleTerrain };
}

describe('projectGeographicPositions', () => {
  it('places the sub-camera point at the canvas centre and reports far-side points as not facing', () => {
    const { renderer } = harness();
    const [near, far, limb] = renderer.projectGeographicPositions('Moon', [
      { latDeg: 0, lonDeg: 0 }, { latDeg: 0, lonDeg: 180 }, { latDeg: 0, lonDeg: 89 },
    ], datum)!;
    expect(near.x).toBeCloseTo(400, 6);
    expect(near.y).toBeCloseTo(200, 6);
    expect(near).toMatchObject({ facing: true, inFront: true });
    expect(far.facing).toBe(false);
    expect(limb.x).toBeGreaterThan(400);
  });

  it('puts north up the canvas', () => {
    const { renderer } = harness();
    const [north] = renderer.projectGeographicPositions('Moon', [{ latDeg: 10, lonDeg: 0 }], datum)!;
    expect(north.y).toBeLessThan(200);
  });

  it('samples terrain only when asked and only on a matching datum', () => {
    const matching = harness({ terrain: datum });
    const flat = matching.renderer.projectGeographicPositions('Moon', [{ latDeg: 10, lonDeg: 0 }], datum)!;
    expect(matching.sampleTerrain).not.toHaveBeenCalled();
    const raised = matching.renderer.projectGeographicPositions('Moon', [{ latDeg: 10, lonDeg: 0 }], datum, { sampleTerrain: true })!;
    expect(matching.sampleTerrain).toHaveBeenCalledOnce();
    expect(raised[0].y).toBeLessThan(flat[0].y);
    const other = harness({ terrain: { ...datum, referenceShape: { kind: 'sphere', radiusKm: 999 } } });
    other.renderer.projectGeographicPositions('Moon', [{ latDeg: 10, lonDeg: 0 }], datum, { sampleTerrain: true });
    expect(other.sampleTerrain).not.toHaveBeenCalled();
  });

  it('returns null for a body that is not drawn', () => {
    expect(harness({ visible: false }).renderer.projectGeographicPositions('Moon', [{ latDeg: 0, lonDeg: 0 }], datum)).toBeNull();
    expect(harness().renderer.projectGeographicPositions('Mars', [{ latDeg: 0, lonDeg: 0 }], datum)).toBeNull();
  });
});

describe('projectGeographicPositions at close range', () => {
  // A camera 4 km below the datum (inside a crater), at lon 0, lat 0, looking north along the surface.
  function low(meshes: THREE.Object3D[] = []) {
    const camera = new THREE.PerspectiveCamera(60, 2, 0.01, 1e6);
    camera.position.set(996, 0, 0); camera.up.set(1, 0, 0); camera.lookAt(996, 0, 100); camera.updateMatrixWorld(true);
    const group = new THREE.Group(); for (const m of meshes) group.add(m); group.updateMatrixWorld(true);
    const body = { visible: true, position: new THREE.Vector3(), terrainDatum: null, mesh: new THREE.Object3D(), terrainTileGroup: group,
      bodyToWorldQuaternion: (q: THREE.Quaternion) => q.identity() };
    body.mesh.visible = false;
    return Object.assign(Object.create(UniverseRenderer.prototype), {
      bodyMeshes: new Map([['Moon', body]]), camera, scaleFactor: 1, overlayOcclusion: new ContourOcclusion(),
      renderer: { domElement: { clientWidth: 800, clientHeight: 400 } },
    }) as UniverseRenderer;
  }
  // 0.6° north ≈ 10.5 km away, on a rim 3 km below the datum: higher than the camera, and in plain view.
  const rim = { latDeg: 0.6, lonDeg: 0, heightKm: -3 };

  it('keeps a point higher than a low camera, which a surface-normal test rejected', () => {
    const [p] = low().projectGeographicPositions('Moon', [rim], datum)!;
    expect(p).toMatchObject({ facing: true, inFront: true });
    // The old test: the geodetic normal at the point, against the direction to the camera.
    const n = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, -1, 0), 0.6 * Math.PI / 180);
    const at = new THREE.Vector3(997 * Math.cos(0.6 * Math.PI / 180), 0, 997 * Math.sin(0.6 * Math.PI / 180));
    expect(n.dot(new THREE.Vector3(996, 0, 0).sub(at))).toBeLessThan(0);
  });

  it('hides a point behind drawn terrain only when occlusion is asked for, and never one beyond the near plane test', () => {
    // A wall across the view halfway there, standing well above the line of sight.
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateY(Math.PI / 2).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    wall.position.set(996, 0, 5);
    wall.lookAt(996, 0, 0);
    const r = low([wall]);
    expect(r.projectGeographicPositions('Moon', [rim], datum)![0].facing).toBe(true);
    expect(r.projectGeographicPositions('Moon', [rim], datum, { occlusion: true })![0].facing).toBe(false);
    // Without the wall, line of sight is clear: the point is not hidden by the surface it sits on.
    expect(low().projectGeographicPositions('Moon', [rim], datum, { occlusion: true })![0].facing).toBe(true);
    // Behind the camera.
    expect(r.projectGeographicPositions('Moon', [{ latDeg: -0.6, lonDeg: 0, heightKm: -3 }], datum)![0].inFront).toBe(false);
  });
});

describe('renderedSurfaceHeightsKm', () => {
  function withMesh(radiusKm: number, segments: number) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radiusKm, segments, segments / 2), new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    const body = { visible: true, position: new THREE.Vector3(), mesh, terrainTileGroup: null, bodyToWorldQuaternion: (q: THREE.Quaternion) => q.identity() };
    return Object.assign(Object.create(UniverseRenderer.prototype), { bodyMeshes: new Map([['Moon', body]]), scaleFactor: 1 }) as UniverseRenderer;
  }

  it('reads the drawn surface along the normal: a coarse globe lies below the datum between its vertices', () => {
    const fine = withMesh(1000, 256).renderedSurfaceHeightsKm('Moon', [{ latDeg: 10, lonDeg: 20 }], datum)[0]!;
    expect(fine).toBeLessThan(0);
    expect(fine).toBeGreaterThan(-0.1);
    const coarse = withMesh(1000, 16).renderedSurfaceHeightsKm('Moon', [{ latDeg: 10, lonDeg: 20 }], datum)[0]!;
    expect(coarse).toBeLessThan(fine);
    // No deeper than a 22.5° facet can sag at its centre.
    expect(coarse).toBeGreaterThan(-1000 * (1 - Math.cos(Math.PI / 8)));
  });

  it('returns null where nothing drawn is hit, and for a body that is not drawn', () => {
    const r = withMesh(500, 32);
    expect(r.renderedSurfaceHeightsKm('Moon', [{ latDeg: 0, lonDeg: 0 }], datum)).toEqual([null]);
    expect(r.renderedSurfaceHeightsKm('Mars', [{ latDeg: 0, lonDeg: 0 }], datum)).toEqual([null]);
  });
});
