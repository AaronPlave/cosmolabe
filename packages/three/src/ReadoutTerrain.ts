import type { BodyMesh } from './BodyMesh.js';
import type { TerrainSample } from './TerrainSampler.js';

/** One informational readout. Cold mesh preparation and intersection both
 * yield; each frame advances at most 64 chunks or 1ms of cooperative work. */
export class ReadoutTerrain {
  private cached: { body: BodyMesh; revision: number | null; lat: number; lon: number; at: number; sample: TerrainSample | null } | null = null;
  private pending: { body: BodyMesh; revision: number | null; lat: number; lon: number; at: number; steps: Generator<void, TerrainSample | null> } | null = null;
  sample(body: BodyMesh, lat: number, lon: number, now = performance.now()): TerrainSample | null {
    const old = this.cached, revision = body.terrainRevision;
    const sameSource = old?.body === body && old.revision === revision;
    if (this.pending && (this.pending.body !== body || this.pending.revision !== revision)) {
      this.pending.steps.return(null); this.pending = null;
    }
    if (!this.pending) {
      if (sameSource && (old.lat === lat && old.lon === lon || now - old.at < 200)) return old.sample;
      this.pending = { body, revision, lat, lon, at: now, steps: body.sampleResidentTerrainSteps(lat, lon) };
    }
    const pending = this.pending, deadline = performance.now() + 1;
    for (let i = 0; i < 64; i++) {
      const step = pending.steps.next();
      if (step.done) {
        this.cached = { body: pending.body, revision: pending.revision, lat: pending.lat, lon: pending.lon, at: pending.at, sample: step.value }; this.pending = null;
        return step.value;
      }
      if (performance.now() >= deadline) break;
    }
    return sameSource ? old.sample : null;
  }
}
