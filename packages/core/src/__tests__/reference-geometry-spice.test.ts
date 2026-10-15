/**
 * Reference geometry against real SPICE kernels (Cassini SOI): velocity at the
 * spacecraft SPK's coverage edges, agreement with SPICE's own state velocity,
 * CK-frame availability, and the per-frame cost of resolving many overlays.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '@cosmolabe/spice';
import { Universe } from '../Universe.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';
import { frameAvailability, resolveSpatialRelationship, resolveVelocity, type SpatialRelationship } from '../geometry/spatial-relationships.js';

const KERNEL_DIR = join(__dirname, '../../../spice/test-kernels');
const CASSINI_DIR = join(KERNEL_DIR, 'cassini');
const SOI_CK = join(CASSINI_DIR, '04183_04185ra.bc');
const HAS_SOI_CK = existsSync(SOI_CK) && statSync(SOI_CK).size > 100_000;
const CASSINI_SPK = '040629AP_SCPSE_04179_04185.bsp';

const CATALOG: CatalogJson = {
  name: 'Cassini reference geometry',
  items: [
    { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
    {
      name: 'Saturn', class: 'planet', center: 'Sun', trajectory: { type: 'Builtin', name: 'Saturn' },
      rotationModel: { type: 'Builtin' }, geometry: { type: 'Globe', radii: [60268, 60268, 54364] },
      items: [{ name: 'Cassini', class: 'spacecraft', center: 'Saturn', trajectoryFrame: 'J2000', trajectory: { type: 'Spice', target: 'CASSINI', center: 'SATURN' } }],
    },
  ],
};

describe('reference geometry with SPICE', () => {
  let spice: Spice;
  let universe: Universe;
  let coverage: { start: number; end: number };
  const cassini = { kind: 'entity', bodyName: 'Cassini' } as const;

  beforeAll(async () => {
    spice = await Spice.init();
    const furnish = (dir: string, file: string) => spice.furnish({ type: 'buffer', data: readFileSync(join(dir, file)).buffer, filename: file });
    for (const file of ['naif0012.tls', 'pck00010.tpc']) await furnish(KERNEL_DIR, file);
    for (const file of ['cas_v43.tf', 'cas00172.tsc', CASSINI_SPK]) await furnish(CASSINI_DIR, file);
    if (HAS_SOI_CK) await furnish(CASSINI_DIR, '04183_04185ra.bc');
    universe = new Universe(spice);
    universe.loadCatalog(CATALOG);
    const windows = spice.spkcov(-82);
    coverage = { start: windows[0].start, end: windows[windows.length - 1].end };
  }, 30000);

  it('agrees with the SPICE state velocity relative to the central body', () => {
    const et = (coverage.start + coverage.end) / 2;
    const resolved = resolveVelocity(universe, cassini, undefined, et)!;
    expect(resolved.center).toEqual({ kind: 'entity', bodyName: 'Saturn' });
    const { state } = spice.spkezr('CASSINI', et, 'ECLIPJ2000', 'NONE', 'SATURN');
    resolved.velocityKmS.forEach((v, i) => expect(v).toBeCloseTo(state[i + 3], 5));
  });

  it('has a velocity at both ends of the spacecraft SPK coverage, and none beyond', () => {
    for (const et of [coverage.start, coverage.end]) {
      const resolved = resolveVelocity(universe, cassini, undefined, et);
      expect(resolved, `et ${et}`).not.toBeNull();
      const { state } = spice.spkezr('CASSINI', et, 'ECLIPJ2000', 'NONE', 'SATURN');
      // One-sided over half a second: first-order, still well under a mm/s here.
      resolved!.velocityKmS.forEach((v, i) => expect(Math.abs(v - state[i + 3])).toBeLessThan(1e-3));
    }
    expect(resolveVelocity(universe, cassini, undefined, coverage.start - 60)).toBeNull();
    expect(resolveVelocity(universe, cassini, undefined, coverage.end + 60)).toBeNull();
  });

  it('classifies SPICE frames as unknown, or known without orientation outside CK coverage', () => {
    const et = (coverage.start + coverage.end) / 2;
    expect(frameAvailability(universe, 'IAU_SATURN', et)).toBe('available');
    expect(frameAvailability(universe, 'NOT_A_FRAME', et)).toBe('unknown');
    expect(frameAvailability(universe, 'IAU_NOT_A_BODY', et)).toBe('unknown');
    if (!HAS_SOI_CK) return;
    const ck = spice.ckcov(-82000);
    expect(frameAvailability(universe, 'CASSINI_SC_COORD', ck[0].start + 60)).toBe('available');
    expect(frameAvailability(universe, 'CASSINI_SC_COORD', ck[0].start - 86400)).toBe('unavailable');
  });

  it('resolves a scene of overlays within a fraction of a frame, sharing lookups through a per-frame cache', () => {
    const et = (coverage.start + coverage.end) / 2;
    const sun = { kind: 'entity', bodyName: 'Sun' } as const, saturn = { kind: 'entity', bodyName: 'Saturn' } as const;
    // A busy but plausible analysis scene: overlays share bodies, and angles reuse displayed operands.
    const scene: SpatialRelationship[] = [
      { id: 'v', kind: 'velocity', object: cassini },
      { id: 'vs', kind: 'velocity', object: cassini, relativeTo: sun },
      { id: 'sv', kind: 'velocity', object: saturn },
      { id: 'd', kind: 'direction', source: cassini, target: sun },
      { id: 'ds', kind: 'direction', source: cassini, target: saturn },
      { id: 'ax', kind: 'axes', frame: 'IAU_SATURN', origin: saturn },
      { id: 'aj', kind: 'axes', frame: 'J2000', origin: cassini },
      { id: 'g1', kind: 'vector-angle', first: { kind: 'velocity', object: cassini }, second: { kind: 'direction', source: cassini, target: sun } },
      { id: 'g2', kind: 'vector-angle', first: { kind: 'velocity', object: cassini }, second: { kind: 'frame-axis', frame: 'IAU_SATURN', origin: saturn, axis: '+Z' } },
      { id: 'dist', kind: 'distance', source: cassini, target: saturn },
    ];
    const overlays = [...scene, ...scene, ...scene, ...scene].map((r, i) => ({ ...r, id: `${r.id}${i}` }));
    const frames = 50;
    const time = (cached: boolean) => {
      const start = performance.now();
      for (let f = 0; f < frames; f++) {
        const cache = cached ? new Map() : undefined;
        for (const overlay of overlays) expect(resolveSpatialRelationship(universe, overlay, et + f, cache)).not.toBeNull();
      }
      return (performance.now() - start) / frames;
    };
    // Same answers either way.
    const cache = new Map();
    for (const overlay of overlays) expect(resolveSpatialRelationship(universe, overlay, et, cache)).toEqual(resolveSpatialRelationship(universe, overlay, et));
    const uncached = time(false), cached = time(true);
    console.info(`[reference geometry] ${overlays.length} SPICE-backed overlays per frame: ${uncached.toFixed(2)} ms uncached, ${cached.toFixed(2)} ms with a per-frame cache`);
    expect(cached).toBeLessThan(uncached);
    // Generous for shared CI runners; the point is to catch an order-of-magnitude regression.
    expect(cached).toBeLessThan(10);
  });
});
