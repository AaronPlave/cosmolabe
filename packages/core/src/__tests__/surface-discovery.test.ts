import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  recommendSurfaceSources, discoveryEstimatorSources, estimateSurfacePlan, validateSurfaceSources,
  type DesiredSurfacePlan, type SurfaceDiscoveryRecord, type SurfaceFeatureCollection,
} from '../surface-plan/index.js';
import { geographicDatum } from '../geographic/import.js';
const fixture = (name: string) => JSON.parse(readFileSync(new URL('../../../../docs/examples/surface-plans/' + name, import.meta.url), 'utf8'));
const ring = (x0 = 0, x1 = 1, y0 = 0, y1 = 1): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const polygon = (rings = [ring()]): SurfaceFeatureCollection => ({ type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'roi', properties: null, geometry: { type: 'Polygon', coordinates: rings } },
] });
function plan(): DesiredSurfacePlan {
  const p: DesiredSurfacePlan = fixture('jezero.plan.json');
  p.layers = [{ id: 'r', name: 'Synthetic tests only', body: 'Mars', source: 'inline', geojson: polygon() }];
  p.regions = [{ id: 'r', feature: { layerId: 'r', featureId: 'string:roi' }, imagery: { gsdM: 10 }, elevation: { gsdM: 10 }, fallback: 'allow-coarser' }];
  delete p.budget; return p;
}
function source(id: string, channel: 'imagery' | 'elevation' = 'imagery', shape = polygon()): SurfaceDiscoveryRecord {
  const r: SurfaceDiscoveryRecord = structuredClone(fixture('mars-jezero.inventory.json')[0]);
  const d = r.descriptor;
  d.id = id; d.productId = id; d.channel = channel; r.kind = channel === 'imagery' ? 'observation-image' : 'gridded-elevation';
  d.coordinates = plan().coordinates; d.datum = geographicDatum(d.coordinates); d.projection = 'Synthetic identity test';
  d.footprint = shape; d.nodata = 'unknown'; d.nativeGsdM = 1; d.accuracyM = 1;
  d.asset = { url: 'https://example.test/' + id, bytes: 100, version: '1' };
  d.metadata = { ...d.metadata!, evidenceUrl: 'https://example.test/evidence', confidence: 'verified-mask',
    rasterGsdM: 1, registration: { group: 'synthetic-reference', evidenceUrl: 'https://example.test/registration', accuracyM: 1 },
    observationId: 'synthetic', sourceProjection: d.projection, reuse: { status: 'allowed', evidenceUrl: 'https://example.test/license' },
    illumination: { incidenceDeg: 30, emissionDeg: 0, phaseDeg: 30, photometry: 'Synthetic consistent test fixture' }, unknowns: [],
    validData: { geometry: shape, evidenceUrl: 'https://example.test/synthetic-mask', method: 'Synthetic test polygon, no archive claim', extent: 'complete-mask' } };
  r.evidence = { url: 'https://example.test/evidence', footprint: 'archive-footprint' }; return r;
}
const first = (p: DesiredSurfacePlan, records: SurfaceDiscoveryRecord[]) => recommendSurfaceSources(p, records).combinations[0].alternatives[0];
describe('bounded Mars source discovery (#249)', () => {
  it('validates product-level Jezero/Gale inventories and preserves true archive geometry without claiming valid pixels', () => {
    for (const region of ['jezero', 'gale']) {
      const records: SurfaceDiscoveryRecord[] = fixture(`mars-${region}.inventory.json`);
      expect(validateSurfaceSources(records.map(r => r.descriptor))).toHaveLength(7);
      expect(records.some(r => /megt(?:44n000|00n090)hb/.test(r.descriptor.productId))).toBe(true);
      expect(records.filter(r => r.kind === 'stereo-dtm')).toHaveLength(1);
      expect(records.find(r => r.kind === 'stereo-dtm')?.descriptor.footprint).toBeDefined();
      expect(records.find(r => r.kind === 'orthoimage')?.descriptor.asset.url).toMatch(/ORTHO.JP2$/);
      const p: DesiredSurfacePlan = fixture(`${region}.plan.json`); p.layers[0].geojson = fixture(`${region}.geojson`);
      const a = recommendSurfaceSources(p, records), b = recommendSurfaceSources(p, [...records].reverse());
      expect(a).toEqual(b);
      expect(a.combinations).toHaveLength(p.regions.length);
      expect(a.combinations.every(r => r.alternatives.length <= 3)).toBe(true);
      expect(a.recommendations.every(r => r.status !== 'verified-complete')).toBe(true);
      expect(a.recommendations.flatMap(r => r.candidates).every(c => c.verifiedValidFraction === null)).toBe(true);
    }
  });
  it('keeps the missing 99% visible for a verified 1% sliver and rejects naked nodata claims', () => {
    const p = plan(), image = source('sliver', 'imagery', polygon([ring(0, 0.01)]));
    const report = recommendSurfaceSources(p, [image]);
    expect(report.recommendations[0].status).toBe('verified-partial');
    expect(report.diagnostics.some(d => d.code === 'discovery-coverage-partial')).toBe(true);
    const c = report.combinations[0].alternatives[0].channels.imagery!.coverage;
    expect(c.verifiedFraction).toBeCloseTo(0.01, 6); expect(c.gapFraction).toBeCloseTo(0.99, 6);
    delete image.descriptor.metadata!.validData; image.descriptor.nodata = 'none'; image.evidence.footprint = 'verified-valid-data';
    expect(() => recommendSurfaceSources(p, [image])).toThrow(/independent mask/);
    image.evidence.footprint = 'raster-envelope';
    expect(first(p, [image]).channels.imagery!.coverage.unknownFraction).toBeCloseTo(0.01);
  });
  it('unions two compatible halves without double counting, honors mask holes, and distinguishes unknown from gaps', () => {
    const p = plan(); delete p.regions[0].elevation;
    const a = source('left', 'imagery', polygon([ring(0, 0.6)])), b = source('right', 'imagery', polygon([ring(0.4, 1)]));
    const c = first(p, [a, b]); expect(c.sourceIds).toEqual(['left', 'right']);
    expect(c.channels.imagery!.coverage.verifiedFraction).toBeCloseTo(1);
    const holed = source('hole'); holed.descriptor.metadata!.validData!.geometry = polygon([ring(), ring(0.4, 0.6, 0.4, 0.6)]);
    const h = first(p, [holed]).channels.imagery!.coverage;
    expect(h.status).toBe('verified-partial'); expect(h.gapFraction).toBeGreaterThan(0.039); expect(h.unknownFraction).toBe(0);
    holed.descriptor.metadata!.validData!.extent = 'known-valid-subset';
    const u = first(p, [holed]).channels.imagery!.coverage;
    expect(u.gapFraction).toBe(0); expect(u.unknownFraction).toBeGreaterThan(0.039);
  });
  it('preserves dateline geometry and ROI holes in union and gap accounting', () => {
    const p = plan(); delete p.regions[0].elevation;
    p.layers[0].geojson = polygon([ring(179, 181), ring(179.4, 179.6, 0.4, 0.6)]);
    const a = source('west', 'imagery', polygon([ring(179, 180)])), b = source('east', 'imagery', polygon([ring(180, 181)]));
    const c = first(p, [a, b]).channels.imagery!.coverage;
    expect(c.verifiedFraction).toBeCloseTo(1); expect(c.gapFraction).toBe(0); expect(c.verifiedGeometry).toHaveLength(2);
  });
  it('refuses to union unregistered or mismatched datum sources and keeps target fidelity independent of coverage', () => {
    const p = plan(); delete p.regions[0].elevation;
    const a = source('left', 'imagery', polygon([ring(0, 0.5)])), b = source('right', 'imagery', polygon([ring(0.5, 1)]));
    b.descriptor.metadata!.registration = null;
    expect(first(p, [a, b]).channels.imagery!.coverage.verifiedFraction).toBeLessThan(0.51);
    b.descriptor.metadata!.registration = a.descriptor.metadata!.registration;
    b.descriptor.datum.verticalDatum = 'areoid';
    const report = recommendSurfaceSources(p, [a, b]);
    expect(report.diagnostics.some(d => d.code === 'discovery-datum-unresolved')).toBe(true);
    expect(first(p, [a, b]).sourceIds).toHaveLength(1);
    const image = source('coarse'); image.descriptor.nativeGsdM = 20;
    const c = first(p, [image]).channels.imagery!.coverage;
    expect(c.verifiedFraction).toBe(1); expect(c.targetVerifiedFraction).toBe(0);
  });
  it('reports projection/illumination/observation/registration tradeoffs and does not infer a stereo DTM from an image', () => {
    const p = plan(), a = source('left', 'imagery', polygon([ring(0, 0.5)])), b = source('right', 'imagery', polygon([ring(0.5, 1)]));
    b.descriptor.metadata!.illumination!.incidenceDeg = 65; b.descriptor.metadata!.observationId = 'different'; b.descriptor.projection = 'Other source projection';
    const c = first(p, [a, b]);
    expect(c.warnings.join(' ')).toMatch(/Illumination mismatch/); expect(c.warnings.join(' ')).toMatch(/Different\/unknown observations/);
    expect(c.warnings.join(' ')).toMatch(/projections differ/);
    expect(recommendSurfaceSources(p, [a]).diagnostics.some(d => d.code === 'discovery-no-released-stereo-dtm')).toBe(true);
  });
  it('changes compact combinations by policy, reports finer/coarser fallbacks, and costs only selected unique assets', async () => {
    const p = plan(), mosaic = source('mosaic'), fine = source('fine'), dem = source('dem', 'elevation');
    mosaic.kind = 'controlled-mosaic'; mosaic.descriptor.nativeGsdM = 10;
    fine.descriptor.nativeGsdM = 0.25; fine.descriptor.asset.bytes = 1000;
    const consistent = recommendSurfaceSources(p, [mosaic, fine, dem], { policy: 'consistent' });
    const finest = recommendSurfaceSources(p, [mosaic, fine, dem], { policy: 'finest-imagery' });
    expect(consistent.recommendedSourceIds).toEqual(['dem', 'mosaic']); expect(finest.recommendedSourceIds).toEqual(['dem', 'fine']);
    expect(consistent.combinations[0].alternatives[0].cost.downloadBytes).toEqual({ min: 200, max: 200 });
    const selected = discoveryEstimatorSources(finest, [mosaic, fine, dem]);
    expect(selected.map(d => d.id)).toEqual(['dem', 'fine']);
    const estimate = await estimateSurfacePlan(p, { sources: selected });
    expect(estimate.sourceDownload.candidateIds.sort()).toEqual(['dem', 'fine']);
    expect(estimate.totals.rawSourceDownloadBytes).toEqual({ min: 1100, max: 1100 });
    expect(estimate.fidelity.status).toBe('satisfied');
    delete fine.descriptor.asset.bytes;
    expect(first(p, [fine]).cost.downloadBytes).toEqual({ min: 0, max: null });
    fine.descriptor.asset.bytes = 100; fine.descriptor.asset.url = mosaic.descriptor.asset.url;
    // Identical asset/version is one source download, even if metadata describes separate channels.
    dem.descriptor.asset = mosaic.descriptor.asset;
    expect(first(p, [mosaic, dem]).cost.downloadBytes).toEqual({ min: 100, max: 100 });
    expect((await estimateSurfacePlan(p, { sources: [mosaic.descriptor, dem.descriptor] })).totals.rawSourceDownloadBytes.min).toBe(100);
  });
  it('favors evidenced physical accuracy, preserves coarse fallbacks, and excludes restricted products', () => {
    const p = plan(); delete p.regions[0].imagery;
    const accurate = source('accurate', 'elevation'), fine = source('fine', 'elevation');
    accurate.descriptor.nativeGsdM = 10; accurate.descriptor.accuracyM = 0.1;
    fine.descriptor.nativeGsdM = 0.1; fine.descriptor.accuracyM = null;
    const physical = recommendSurfaceSources(p, [accurate, fine], { policy: 'physical-accuracy' });
    expect(physical.recommendedSourceIds).toEqual(['accurate']);
    accurate.descriptor.nativeGsdM = 20;
    expect(recommendSurfaceSources(p, [accurate]).recommendations[0].fallbacks.coarserSourceIds).toEqual(['accurate']);
    p.regions[0].fallback = 'require-target'; expect(first(p, [accurate]).sourceIds).toEqual([]);
    fine.descriptor.metadata!.reuse.status = 'restricted'; expect(first(p, [fine]).sourceIds).toEqual([]);
  });
  it('estimator cannot combine incompatible registration groups into complete coverage', async () => {
    const p = plan(); delete p.regions[0].elevation;
    const left = source('left', 'imagery', polygon([ring(0, 0.5)])), right = source('right', 'imagery', polygon([ring(0.5, 1)]));
    right.descriptor.metadata!.registration!.group = 'other-reference';
    const estimate = await estimateSurfacePlan(p, { sources: [left.descriptor, right.descriptor] });
    expect(estimate.fidelity.status).toBe('partial');
    expect(estimate.fidelity.imagery.adequateAreaM2 / estimate.fidelity.imagery.requestedAreaM2).toBeCloseTo(0.5);
    expect(estimate.fidelity.imagery.unknownAreaM2 / estimate.fidelity.imagery.requestedAreaM2).toBeCloseTo(0.5);
  });
  it('keeps complete-mask invalid pixels separate from unknown quality, other sources and outside-footprint evidence', async () => {
    const p = plan(); delete p.regions[0].elevation;
    const image = source('masked', 'imagery', polygon([ring(0, 0.8)]));
    image.descriptor.metadata!.validData!.geometry = polygon([ring(0, 0.6)]);
    image.descriptor.nativeGsdM = null;
    const estimate = async (records: SurfaceDiscoveryRecord[]) => (await estimateSurfacePlan(p, { sources: records.map(r => r.descriptor) })).fidelity.imagery;
    const unknownQuality = await estimate([image]);
    expect(unknownQuality.unknownAreaM2 / unknownQuality.requestedAreaM2).toBeCloseTo(0.8);
    expect(unknownQuality.unsatisfiedAreaM2 / unknownQuality.requestedAreaM2).toBeCloseTo(0.2);
    const other = source('other', 'imagery', polygon([ring(0.6, 1)]));
    const filled = await estimate([image, other]);
    expect(filled.adequateAreaM2 / filled.requestedAreaM2).toBeCloseTo(0.4);
    expect(filled.unsatisfiedAreaM2).toBe(0);
    delete other.descriptor.metadata!.validData;
    const possible = await estimate([image, other]);
    expect(possible.unknownAreaM2 / possible.requestedAreaM2).toBeCloseTo(1);
    expect(possible.unsatisfiedAreaM2).toBe(0);
  });
  it('never promotes a partial validity mask to full estimator coverage, or source grid spacing to accuracy', async () => {
    const p = plan(); p.regions[0].elevation!.accuracyM = 0.5;
    const dem = source('dem', 'elevation'); dem.descriptor.accuracyM = null;
    const report = recommendSurfaceSources(p, [dem]);
    expect(report.recommendations.find(r => r.channel === 'elevation')!.candidates[0].meetsTarget).toBeNull();
    const image = source('image'); image.descriptor.nodata = 'none';
    image.descriptor.metadata!.validData!.geometry = polygon([ring(0, 0.01)]);
    const estimate = await estimateSurfacePlan(p, { sources: [image.descriptor] });
    expect(estimate.fidelity.imagery.adequateAreaM2 / estimate.fidelity.imagery.requestedAreaM2).toBeCloseTo(0.01);
    delete image.descriptor.metadata!.validData;
    const unverified = await estimateSurfacePlan(p, { sources: discoveryEstimatorSources(recommendSurfaceSources(p, [image]), [image]) });
    expect(unverified.fidelity.imagery.adequateAreaM2).toBe(0);
  });
  it('is bounded, immutable and honest when all metadata is absent; rejects malformed masks and quality', () => {
    const p = plan(), records = [source('a')], before = JSON.stringify({ p, records });
    expect(() => recommendSurfaceSources(p, records, { maxCandidates: 4 })).toThrow(/at most 32/);
    recommendSurfaceSources(p, records); expect(JSON.stringify({ p, records })).toBe(before);
    expect(recommendSurfaceSources(p, []).recommendedSourceIds).toEqual([]);
    records[0].descriptor.metadata!.validData!.geometry = polygon([ring(0, 2)]);
    expect(() => recommendSurfaceSources(p, records)).toThrow(/exceeds product footprint/);
    records[0].descriptor.metadata!.validData!.evidenceUrl = '';
    expect(() => recommendSurfaceSources(p, records)).toThrow();
  });
});
