import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseXyzv } from '../trajectories/XyzvParser.js';
import { InterpolatedStatesTrajectory } from '../trajectories/InterpolatedStates.js';
import { CatalogLoader } from '../catalog/CatalogLoader.js';

const COSMOGRAPHIA_DIR = '/Users/aplave/code/cosmographia';

describe('parseXyzv', () => {
  it('parses inline xyzv data', () => {
    const text = `
# comment line
2451545.0  1.0  2.0  3.0  0.1  0.2  0.3
2451546.0  4.0  5.0  6.0  0.4  0.5  0.6
`;
    const records = parseXyzv(text);
    expect(records).toHaveLength(2);

    // JD 2451545.0 = J2000 epoch = ET 0
    expect(records[0].et).toBeCloseTo(0, 0);
    expect(records[0].position).toEqual([1, 2, 3]);
    expect(records[0].velocity).toEqual([0.1, 0.2, 0.3]);

    // JD 2451546.0 = ET 86400
    expect(records[1].et).toBeCloseTo(86400, 0);
    expect(records[1].position).toEqual([4, 5, 6]);
  });

  it('handles scientific notation', () => {
    const text = `2454013.500000000  -8.770724313520381E+07 -2.259813372571933E+08  7.920898990194350E+06  1.852658036573182E+01 -7.060230284335938E+00  4.568955579348342E-01
`;
    const records = parseXyzv(text);
    expect(records).toHaveLength(1);
    expect(records[0].position[0]).toBeCloseTo(-8.77e7, -5);
    expect(records[0].velocity[0]).toBeCloseTo(18.53, 0);
  });

  it('skips malformed lines gracefully', () => {
    const text = `2451545.0  1.0  2.0  3.0  0.1  0.2  0.3
bad_jd  1.0  2.0  3.0  0.1  0.2  0.3
2451546.0  4.0  5.0  6.0  0.4  0.5  0.6
`;
    const records = parseXyzv(text);
    // The bad_jd record should be skipped
    expect(records).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(parseXyzv('')).toHaveLength(0);
    expect(parseXyzv('# just comments\n# nothing here')).toHaveLength(0);
  });
});

describe('parseXyzv with real Cosmographia trajectory', () => {
  it('parses voyager1.xyzv', () => {
    const text = readFileSync(join(COSMOGRAPHIA_DIR, 'data/trajectories/voyager1.xyzv'), 'utf-8');
    const records = parseXyzv(text);

    expect(records.length).toBeGreaterThanOrEqual(100);

    // First record should be in the late 1970s (ET < 0, before J2000)
    expect(records[0].et).toBeLessThan(0);

    // All records should have valid 3-component vectors
    for (const r of records) {
      expect(r.position).toHaveLength(3);
      expect(r.velocity).toHaveLength(3);
      expect(r.position.every(Number.isFinite)).toBe(true);
      expect(r.velocity.every(Number.isFinite)).toBe(true);
    }

    // Records should generally increase in time (file may have patched segments with overlaps)
    const firstEt = records[0].et;
    const lastEt = records[records.length - 1].et;
    expect(lastEt).toBeGreaterThan(firstEt);
  });

  it('creates working InterpolatedStatesTrajectory from voyager1', () => {
    const text = readFileSync(join(COSMOGRAPHIA_DIR, 'data/trajectories/voyager1.xyzv'), 'utf-8');
    const records = parseXyzv(text);
    const traj = new InterpolatedStatesTrajectory(records);

    // Query at a time between first and second record
    const midEt = (records[0].et + records[1].et) / 2;
    const state = traj.stateAt(midEt);

    // Interpolated position should be between first two records
    expect(state.position[0]).toBeGreaterThan(
      Math.min(records[0].position[0], records[1].position[0]),
    );
    expect(state.position[0]).toBeLessThan(
      Math.max(records[0].position[0], records[1].position[0]),
    );
  });
});

describe('CatalogLoader with InterpolatedStates + resolveFile', () => {
  it('loads InterpolatedStates trajectory via resolveFile', () => {
    const loader = new CatalogLoader({
      resolveFile: (source) => {
        if (source === 'trajectories/voyager1.xyzv') {
          return readFileSync(join(COSMOGRAPHIA_DIR, 'data/trajectories/voyager1.xyzv'), 'utf-8');
        }
        return undefined;
      },
    });

    const result = loader.load({
      items: [{
        name: 'Voyager 1',
        center: 'Sun',
        trajectory: {
          type: 'InterpolatedStates',
          source: 'trajectories/voyager1.xyzv',
        },
      }],
    });

    expect(result.bodies).toHaveLength(1);
    const voyager = result.bodies[0];

    // Query state — Voyager 1 launched 1977, positions should be large (AU scale)
    const et = -7e8; // ~1977-1978
    const state = voyager.stateAt(et);
    expect(state.position[0]).not.toBe(0); // Not a FixedPoint fallback
    const dist = Math.sqrt(
      state.position[0] ** 2 + state.position[1] ** 2 + state.position[2] ** 2,
    );
    // Should be somewhere in the inner solar system (~1 AU = 1.5e8 km)
    expect(dist).toBeGreaterThan(1e7);
    expect(dist).toBeLessThan(1e10);
  });

  it('falls back to FixedPoint when resolveFile not provided', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      items: [{
        name: 'Test',
        trajectory: { type: 'InterpolatedStates', source: 'missing.xyzv' },
      }],
    });

    const state = result.bodies[0].stateAt(0);
    expect(state.position).toEqual([0, 0, 0]);
  });

  it('backwards compatible: SpiceInstance constructor still works', () => {
    // Passing undefined (no SPICE) should still work
    const loader = new CatalogLoader(undefined);
    const result = loader.load({ items: [{ name: 'X', trajectory: { type: 'FixedPoint', position: [1, 2, 3] } }] });
    expect(result.bodies[0].stateAt(0).position).toEqual([1, 2, 3]);
  });
});
