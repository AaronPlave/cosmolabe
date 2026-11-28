import { describe, expect, it, vi } from 'vitest';
import { ReadoutTerrain } from '../ReadoutTerrain.js';
import type { BodyMesh } from '../BodyMesh.js';

describe('informational terrain reads', () => {
  it('reuses identical locations and unknowns, invalidates source revisions, and bounds motion', () => {
    const readout = new ReadoutTerrain();
    const sample = { elevationKm: 1 };
    const query = vi.fn(() => sample);
    const body = { terrainRevision: 1, sampleResidentTerrain: query } as unknown as BodyMesh;
    expect(readout.sample(body, 0, 0, 0)).toBe(sample);
    expect(readout.sample(body, 0, 0, 100)).toBe(sample);
    expect(query).toHaveBeenCalledTimes(1);
    expect(readout.sample(body, 1, 0, 100)).toBe(sample);
    expect(readout.sample(body, 1, 0, 200)).toBe(sample);
    Object.assign(body, { terrainRevision: 2 });
    expect(readout.sample(body, 1, 0, 300)).toBeNull();
    query.mockReturnValue(null as never);
    expect(readout.sample(body, 1, 0, 400)).toBeNull();
    expect(readout.sample(body, 1, 0, 1000)).toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenLastCalledWith(1, 0, 128);
    const other = { terrainRevision: 2, sampleResidentTerrain: query } as unknown as BodyMesh;
    readout.sample(other, 1, 0, 1001);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
