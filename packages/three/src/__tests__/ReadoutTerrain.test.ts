import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadoutTerrain } from '../ReadoutTerrain.js';
import type { BodyMesh } from '../BodyMesh.js';

afterEach(() => vi.restoreAllMocks());

describe('informational terrain reads', () => {
  it('advances cold work across frames and discards work from old revisions', () => {
    const readout = new ReadoutTerrain();
    let chunks = 0, cancelled = 0;
    const body = { terrainRevision: 1, sampleResidentTerrainSteps: function* () {
      try { for (let i = 0; i < 200; i++) { chunks++; yield; } return null; }
      finally { cancelled++; }
    } } as unknown as BodyMesh;
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const point = { latDeg: 1, lonDeg: 2, heightKm: 3 };
    readout.altitude(body, point, 0);
    expect(chunks).toBe(64);
    readout.altitude(body, point, 16);
    expect(chunks).toBe(128);
    Object.assign(body, { terrainRevision: 2 });
    readout.altitude(body, point, 32);
    expect(cancelled).toBe(1);
    expect(chunks).toBe(192);
  });

  it('holds a coherent altitude during horizontal motion and updates vertical motion without resampling', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const readout = new ReadoutTerrain();
    let unavailable = false;
    const query = vi.fn((lat: number, lon: number) => (function* () {
      yield; return unavailable ? null : { elevationKm: lat + lon + 1 };
    })());
    const body = { terrainRevision: 1, sampleResidentTerrainSteps: query } as unknown as BodyMesh;
    expect(readout.altitude(body, { latDeg: 0, lonDeg: 0, heightKm: 100 }, 0)).toBe(99);
    expect(readout.altitude(body, { latDeg: 0, lonDeg: 0, heightKm: 110 }, 100)).toBe(109);
    expect(query).toHaveBeenCalledTimes(1);
    // A different reference height must not be mixed with the old ground.
    expect(readout.altitude(body, { latDeg: 1, lonDeg: 0, heightKm: 500 }, 100)).toBe(109);
    expect(readout.altitude(body, { latDeg: 1, lonDeg: 0, heightKm: 500 }, 200)).toBe(498);
    expect(query).toHaveBeenLastCalledWith(1, 0);
    expect(readout.altitude(body, { latDeg: 1, lonDeg: 0, heightKm: 501 }, 201)).toBe(499);
    expect(query).toHaveBeenCalledTimes(2);
    Object.assign(body, { terrainRevision: 2 }); unavailable = true;
    const point = { latDeg: 1, lonDeg: 0, heightKm: 501 };
    expect(readout.altitude(body, point, 300)).toBeNull();
    expect(readout.altitude(body, point, 400)).toBeNull();
    expect(readout.altitude(body, point, 1000)).toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
    const other = { terrainRevision: 2, sampleResidentTerrainSteps: query } as unknown as BodyMesh;
    readout.altitude(other, point, 1001);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
