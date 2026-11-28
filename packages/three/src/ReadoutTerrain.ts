import type { BodyMesh } from './BodyMesh.js';
import type { TerrainSample } from './TerrainSampler.js';

interface ReadoutPosition { latDeg: number; lonDeg: number; heightKm: number }
interface Reading {
  body: BodyMesh;
  revision: number | null;
  position: ReadoutPosition;
  at: number;
}

/** A live altitude readout. Cold preparation/intersection both yield; each
 * call advances at most 64 chunks or 1ms of cooperative work. */
export class ReadoutTerrain {
  private cached: (Reading & { sample: TerrainSample | null }) | null = null;
  private pending: (Reading & { steps: Generator<void, TerrainSample | null> }) | null = null;

  altitude(body: BodyMesh, position: ReadoutPosition, now = performance.now()): number | null {
    const old = this.cached, revision = body.terrainRevision;
    const sameSource = old?.body === body && old.revision === revision;
    if (this.pending && (this.pending.body !== body || this.pending.revision !== revision)) {
      this.pending.steps.return(null); this.pending = null;
    }
    if (!this.pending && !(sameSource && (old.position.latDeg === position.latDeg
      && old.position.lonDeg === position.lonDeg || now - old.at < 200))) {
      this.pending = { body, revision, position: { ...position }, at: now,
        steps: body.sampleResidentTerrainSteps(position.latDeg, position.lonDeg) };
    }
    if (this.pending) {
      const pending = this.pending, deadline = performance.now() + 1;
      for (let i = 0; i < 64; i++) {
        const step = pending.steps.next();
        if (step.done) {
          this.cached = { body, revision, position: pending.position, at: pending.at, sample: step.value };
          this.pending = null;
          break;
        }
        if (performance.now() >= deadline) break;
      }
    }
    const cached = this.cached;
    if (!cached || cached.body !== body || cached.revision !== revision || !cached.sample) return null;
    // Vertical motion over the same subpoint needs no terrain query. During
    // horizontal motion hold the last complete reading: mixing a new height
    // with terrain from an old location would invent an altitude over slopes.
    if (cached.position.latDeg === position.latDeg && cached.position.lonDeg === position.lonDeg) {
      cached.position.heightKm = position.heightKm;
    }
    return cached.position.heightKm - cached.sample.elevationKm;
  }
}
