import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogLoader } from '../catalog/CatalogLoader.js';

import { cosmographiaData, COSMOGRAPHIA_HINT } from './_harness/cosmographia.js';

const COSMOGRAPHIA_DATA = cosmographiaData();
/** Skip rather than fail when the fetch has not been run. CI always fetches.
 *  Guarded at module scope because the readdir below used to throw during
 *  collection, which took the whole file down instead of reporting a skip. */
const withData = COSMOGRAPHIA_DATA ? describe : describe.skip;
if (!COSMOGRAPHIA_DATA) console.warn(`[catalog-all-cosmographia] ${COSMOGRAPHIA_HINT}`);

// All JSON catalog files from Cosmographia's data directory
const catalogFiles = COSMOGRAPHIA_DATA
  ? readdirSync(COSMOGRAPHIA_DATA).filter(f => f.endsWith('.json')).sort()
  : [];

withData('Load all Cosmographia catalogs without errors', () => {
  const loader = new CatalogLoader();

  for (const file of catalogFiles) {
    it(`loads ${file}`, () => {
      const text = readFileSync(join(COSMOGRAPHIA_DATA!, file), 'utf-8');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // Some Cosmographia files have trailing commas (invalid JSON) — skip gracefully
        return;
      }

      // Should not throw
      const result = loader.load(json as Record<string, unknown>);

      // Basic sanity
      expect(result).toBeDefined();
      expect(result.bodies).toBeInstanceOf(Array);

      // Every body should have a name and a working trajectory
      for (const body of result.bodies) {
        expect(body.name).toBeTruthy();
        const state = body.stateAt(0);
        expect(state.position).toHaveLength(3);
        expect(state.position.every(Number.isFinite)).toBe(true);
      }
    });
  }

  it('found at least 20 catalog files', () => {
    expect(catalogFiles.length).toBeGreaterThanOrEqual(20);
  });

  it('loads all catalogs and produces bodies', () => {
    let totalBodies = 0;
    for (const file of catalogFiles) {
      const text = readFileSync(join(COSMOGRAPHIA_DATA!, file), 'utf-8');
      let json: unknown;
      try { json = JSON.parse(text); } catch { continue; }
      const result = loader.load(json as Record<string, unknown>);
      totalBodies += result.bodies.length;
    }
    // Should produce a substantial number of bodies across all catalogs
    expect(totalBodies).toBeGreaterThan(50);
  });
});
