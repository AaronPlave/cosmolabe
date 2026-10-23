import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { TerrainDatum } from '@cosmolabe/core';
import { UniverseRenderer } from '../UniverseRenderer.js';

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
