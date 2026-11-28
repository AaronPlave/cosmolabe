import type { BodyMesh } from './BodyMesh.js';
import type { TerrainSample } from './TerrainSampler.js';

/** One readout's last sample, refreshed at most every 200ms during motion. */
export class ReadoutTerrain {
  private cached: { body: BodyMesh; revision: number | null; lat: number; lon: number; at: number; sample: TerrainSample | null } | null = null;
  sample(body: BodyMesh, lat: number, lon: number, now = performance.now()): TerrainSample | null {
    const old = this.cached;
    const sameSource = old?.body === body && old.revision === body.terrainRevision;
    if (sameSource && old.lat === lat && old.lon === lon) return old.sample;
    // A moving informational readout may reuse a height for at most 200ms.
    // A changed source must never borrow an answer from the previous revision.
    if (old?.body === body && now - old.at < 200) return sameSource ? old.sample : null;
    const sample = body.sampleResidentTerrain(lat, lon, 128);
    this.cached = { body, revision: body.terrainRevision, lat, lon, at: now, sample };
    return sample;
  }
}
