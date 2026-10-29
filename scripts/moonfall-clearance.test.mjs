import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Universe, resolveViewpoint } from '../packages/core/dist/index.js';
import { hoppers } from './data/moonfall-sorties.mjs';
import { bakeFlight, trajectory, terrainSource, validateFlight, sha256, segmentSteps } from './lib/moonfall-clearance.mjs';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const catalog = read('../apps/viewer/test-catalogs/moonfall-shackleton.json');
const report = read('./data/moonfall-clearance.json');
const dataset = read('./data-hosting/datasets.json').datasets['cube-terrain/moon-terrain-cube'];
const elevations = read('./data/moon-elevations-cube.json').elevations;
const actual = catalog.items.find(i => i.name === 'Moon').items;
const grids = process.env.MOONFALL_GRIDS ?? resolve(dataset.localDir, 'cpu-grids.json');

describe('MoonFall synthetic flight clearance', () => {
  it('places the named surface views above the Moon and aims at their region across epochs', () => {
    const u = new Universe();
    u.loadCatalog(catalog);
    for (const [name, heightKm] of [['Shackleton Overview', 60], ['PSR Floor View', 20]]) {
      const def = u.viewpoints.find(v => v.name === name);
      for (const et of [u.time, u.time + 12 * 86400]) {
        const pose = resolveViewpoint(u, def, et);
        expect(Math.hypot(...pose.eye) - 1737.4).toBeCloseTo(heightKm, 8);
        expect(Math.hypot(...pose.target)).toBeCloseTo(1737.4, 8);
        const lat = def.latitude * Math.PI / 180, lon = def.longitude * Math.PI / 180;
        const direction = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
        const expected = u.toWorldFrame(direction, 'BodyFixed', 'Moon', et);
        expect(Math.hypot(...pose.target.map((v, i) => v / 1737.4 - expected[i]))).toBeLessThan(1e-10);
        expect(Math.hypot(...pose.eye.map((v, i) => v - pose.target[i]))).toBeCloseTo(heightKm, 8);
      }
    }
  });
  it('binds the 12 clearance diagnostics to the actual catalog, authored routes and terrain revision', () => {
    expect(report.revision).toBe(dataset.build);
    expect(report.authoredSha256).toBe(sha256(hoppers));
    expect(report.sampling).toEqual({ maxDistanceM: 2, maxTimeS: .1 });
    expect(report.flights).toHaveLength(12);
    for (const hopper of actual) {
      expect(hopper.trajectoryPlot).toEqual({ frame: 'BodyFixed', sampleInterval: 1 });
      expect(hopper.arcs).toHaveLength(5);
      for (const [i, arc] of hopper.arcs.entries()) {
        expect(arc.trajectory.useAbsoluteAlt).toBe(true);
        if (i % 2) { expect(arc.showLine).toBe(false); continue; }
        const diagnostics = report.flights.find(f => f.hopper === hopper.name && f.epoch === arc.startTime);
        expect(diagnostics.pathSha256).toBe(sha256(arc.trajectory.waypoints));
        expect(diagnostics.after.minClearanceM).toBeGreaterThanOrEqual(.75);
        expect(diagnostics.after.maxClearanceM).toBeLessThan(500);
        expect(diagnostics.after.segments.length).toBeGreaterThan(4);
        // Flight/rest boundaries retain the same authored landing site.
        const next = hopper.arcs[i + 1];
        if (next) {
          const end = trajectory(arc.trajectory.waypoints).stateAt(Infinity).position;
          const start = trajectory(next.trajectory.waypoints).stateAt(-Infinity).position;
          expect(Math.hypot(...end.map((v, k) => v - start[k])) * 1000).toBeLessThan(.001);
        }
      }
    }
    expect(report.flights.filter(f => f.before.minClearanceM < 0)).toHaveLength(5);
  });

  it('bounds sampling distance even when cubic endpoints coincide', () => {
    const path = { stateAt: t => ({ position: [0, 0, 0], velocity: [t === 0 ? 1 : -1, 0, 0] }) };
    expect(segmentSteps(path, 0, 1, 2, .1)).toBeGreaterThanOrEqual(500);
  });

  // CI supplies the immutable hosted manifest. Local runs use the pinned grid
  // tree; no approximate DEM or cached min-value substitutes for these queries.
  it.skipIf(!process.env.MOONFALL_GRIDS && !existsSync(grids))('replays every actual Hermite path on the authoritative finest CPU field', async () => {
    const source = await terrainSource(grids, dataset.build);
    try {
      for (const hopper of actual) for (const arc of hopper.arcs.filter(a => a.showLine !== false)) {
        const expected = report.flights.find(f => f.hopper === hopper.name && f.epoch === arc.startTime);
        const result = await validateFlight(arc.trajectory.waypoints, source);
        expect(result.minClearanceM, `${hopper.name} ${arc.startTime}`).toBeGreaterThanOrEqual(.75);
        expect(result.maxClearanceM).toBeLessThan(500);
        expect(result.minClearanceM).toBeCloseTo(expected.after.minClearanceM, 5);
        expect(result.samples).toBe(expected.after.samples);
        const authored = hoppers.find(h => h.name === hopper.name).flights.find(f => f.epoch === arc.startTime);
        expect(await bakeFlight(authored, elevations, source)).toEqual(arc.trajectory.waypoints);
      }
      for (const [file, hash] of source.clearanceInputs) expect(hash, file).toBe(report.terrainInputs[file]);
    } finally { source.dispose(); }
  }, 180_000);
});
