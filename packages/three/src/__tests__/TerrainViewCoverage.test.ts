import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { TerrainManager } from '../TerrainManager.js';

describe('streamer view coverage observations', () => {
  it('separates required coverage loads, draw counts, pending work and exact screen-space error, including terminal tiles', () => {
    const required = [{ internal: { loadingState: 4 }, traversal: { inFrustum: true }, children: [] }];
    const scene = new Object3D();
    const selected = { traversal: { error: 4 }, engineData: { scene }, children: [] };
    const tiles = { stats: { queued: 0, downloading: 0, parsing: 0 }, errorTarget: 2, visibleTiles: new Set([selected]) };
    const tm = Object.create(TerrainManager.prototype) as TerrainManager;
    Object.defineProperties(tm, {
      tiles: { value: tiles }, coverageTiles: { value: () => required }, culledScenes: { value: [] },
      viewUpdateSucceeded: { value: true }, surfaceStatus: { value: { tiles: { drawn: 1 } } },
      imageryOnly: { value: false }, frameAvailability: { value: { kind: 'available' } },
    });
    expect(tm.viewCoverage).toMatchObject({ observed: true, missing: 0, drawn: 1, targetLod: false, physical: true });
    selected.traversal.error = 2; expect(tm.viewCoverage.targetLod).toBe(true);
    required[0].internal.loadingState = 0; expect(tm.viewCoverage.missing).toBe(1);
    required[0].internal.loadingState = -1; expect(tm.viewCoverage.failed).toBe(1);
    tiles.stats.parsing = 3; expect(tm.viewCoverage.pending).toBe(3);
    selected.traversal.error = NaN; expect(tm.viewCoverage.targetLod).toBe(false);
  });
});
