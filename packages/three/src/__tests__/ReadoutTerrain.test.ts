import { describe, expect, it, vi } from 'vitest';
import { ReadoutTerrain } from '../ReadoutTerrain.js';
import type { BodyMesh } from '../BodyMesh.js';

describe('informational terrain reads', () => {
  it('advances cold work across frames and discards work from old revisions', () => {
    const readout = new ReadoutTerrain();
    let chunks = 0, cancelled = 0;
    const body = { terrainRevision: 1, sampleResidentTerrainSteps: function* () {
      try { for (let i = 0; i < 200; i++) { chunks++; yield; } return null; }
      finally { cancelled++; }
    } } as unknown as BodyMesh;
    vi.spyOn(performance, 'now').mockReturnValue(0);
    readout.sample(body, 1, 2, 0);
    expect(chunks).toBe(64);
    readout.sample(body, 1, 2, 16);
    expect(chunks).toBe(128);
    Object.assign(body, { terrainRevision: 2 });
    readout.sample(body, 1, 2, 32);
    expect(cancelled).toBe(1);
    expect(chunks).toBe(192);
    vi.restoreAllMocks();
  });
  it('reuses identical locations and unknowns, invalidates source revisions, and bounds motion', () => {
    const readout = new ReadoutTerrain();
    const sample = { elevationKm: 1 };
    const query = vi.fn(() => sample);
    const body = { terrainRevision: 1, sampleResidentTerrainSteps: function* () { yield; return query(); } } as unknown as BodyMesh;
    expect(readout.sample(body, 0, 0, 0)).toBe(sample);
    expect(readout.sample(body, 0, 0, 100)).toBe(sample);
    expect(query).toHaveBeenCalledTimes(1);
    expect(readout.sample(body, 1, 0, 100)).toBe(sample);
    expect(readout.sample(body, 1, 0, 200)).toBe(sample);
    Object.assign(body, { terrainRevision: 2 });
    query.mockReturnValue(null as never);
    expect(readout.sample(body, 1, 0, 300)).toBeNull();
    expect(readout.sample(body, 1, 0, 400)).toBeNull();
    expect(readout.sample(body, 1, 0, 1000)).toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledWith();
    const other = { terrainRevision: 2, sampleResidentTerrainSteps: function* () { yield; return query(); } } as unknown as BodyMesh;
    readout.sample(other, 1, 0, 1001);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
