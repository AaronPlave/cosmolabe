import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  recommendSurfaceSources, validateSurfaceSources,
  type DesiredSurfacePlan, type SurfaceDiscoveryRecord,
} from '../surface-plan/index.js';

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL('../../../../docs/examples/surface-plans/' + name, import.meta.url), 'utf8'));
const jezeroInventory = (): SurfaceDiscoveryRecord[] => fixture('mars-jezero.inventory.json');
const jezeroPlan = (): DesiredSurfacePlan => {
  const plan = fixture('jezero.plan.json') as DesiredSurfacePlan;
  plan.layers[0].geojson = fixture('jezero.geojson');
  return plan;
};
describe('bounded offline Mars raster discovery (#249)', () => {
  it('loads real-identifier inventories through the existing source validator', () => {
    for (const file of ['mars-jezero.inventory.json', 'mars-gale.inventory.json']) {
      const records: SurfaceDiscoveryRecord[] = fixture(file);
      expect(validateSurfaceSources(records.map(r => r.descriptor))).toHaveLength(4);
      expect(records.filter(r => r.descriptor.channel === 'elevation')).toHaveLength(2);
      expect(records.filter(r => r.descriptor.channel === 'imagery')).toHaveLength(2);
      expect(records.every(r => r.evidence.url.startsWith('https://'))).toBe(true);
    }
  });

  it('is deterministic and does not treat a label envelope or unknown footprint as valid coverage', () => {
    const p = jezeroPlan(), records = jezeroInventory();
    const before = JSON.stringify({ p, records });
    const a = recommendSurfaceSources(p, records), b = recommendSurfaceSources(p, records);
    expect(a).toEqual(b);
    expect(JSON.stringify({ p, records })).toBe(before);
    expect(a.recommendations).toHaveLength(6);
    const ortho = a.recommendations.flatMap(r => r.candidates).find(c => c.productId === 'ESP_023524_1985_RED_C_01_ORTHO');
    expect(ortho).toBeDefined();
    expect(ortho!.verifiedValidFraction).toBeNull();
    expect(ortho!.footprintFraction).not.toBeNull();
    const dtm = a.recommendations.flatMap(r => r.candidates).find(c => c.productId === 'DTEEC_023524_1985_023379_1985_U01');
    expect(dtm).toBeDefined();
    expect(dtm!.footprintFraction).toBeNull();
    expect(a.recommendations.every(r => r.status !== 'verified-candidate')).toBe(true);
  });

  it('keeps terrain and imagery independent, and never upgrades 1m DEM uncertainty to 0.5m accuracy', () => {
    const p = jezeroPlan(), report = recommendSurfaceSources(p, jezeroInventory(), { policy: 'physical-accuracy' });
    const touchdownDem = report.recommendations.find(r => r.regionId === 'touchdown' && r.channel === 'elevation')!;
    expect(touchdownDem.requestedAccuracyM).toBe(0.5);
    expect(touchdownDem.candidates.some(c => c.nativeGsdM === 1 && c.meetsTarget === null)).toBe(true);
    expect(touchdownDem.candidates.every(c => c.verifiedValidFraction === null)).toBe(true);
    expect(report.recommendations.find(r => r.regionId === 'touchdown' && r.channel === 'imagery')!.candidates.every(
      c => c.kind !== 'stereo-dtm')).toBe(true);
  });

  it('rejects fabricated valid coverage and refuses unbounded inputs', () => {
    const p = jezeroPlan(), records = jezeroInventory();
    expect(() => recommendSurfaceSources(p, records, { maxCandidates: 4 })).toThrow(/at most 32/);
    const fake = structuredClone(records);
    fake[3].evidence.footprint = 'verified-valid-data';
    expect(() => recommendSurfaceSources(p, fake)).toThrow(/nodata=none/);
    expect(recommendSurfaceSources(p, [], { maxCandidates: 1 }).recommendations.every(
      r => r.status === 'no-matching-candidate')).toBe(true);
  });

  it('accepts explicitly proven synthetic valid-data coverage but never assumes missing areas are invalid', () => {
    const p = jezeroPlan();
    const records = jezeroInventory();
    const image = structuredClone(records[3]);
    image.descriptor.nodata = 'none';
    image.evidence.footprint = 'verified-valid-data';
    image.evidence.caveats = ['Synthetic verified-mask fixture for test only, not an archive claim'];
    const result = recommendSurfaceSources(p, [image]);
    const candidate = result.recommendations.flatMap(r => r.candidates).find(c => c.sourceId === image.descriptor.id);
    expect(candidate?.verifiedValidFraction).not.toBeNull();
    expect(candidate?.verifiedValidFraction).toBeGreaterThan(0);
  });
});
