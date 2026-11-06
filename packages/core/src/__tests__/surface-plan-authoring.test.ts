import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGeographicGeoJson } from '../geographic/import.js';
import type { GeographicCoordinates, GeographicLayer } from '../geographic/model.js';
import {
  addSurfacePlanRegion, createSurfacePlanDraft, estimateSurfacePlan, matchingSurfacePreset, parseSurfacePlan,
  recommendSurfaceSources, refreshSurfaceRegion, removeSurfacePlanRegion, renameSurfacePlanRegion, serializeSurfacePlan, setSurfacePlanBudget,
  surfaceCoverageLayer, surfacePlanChanges, surfacePlanIdentity, surfaceRegionDrift, surfaceRegionIntent,
  surfaceRegionRefusal, surfaceRegionSource, updateSurfacePlanRegion, validateDesiredSurfacePlan, resolveSurfacePlan,
  surfaceSelectedFidelity, parseSurfacePlannerFeedback, surfaceRegionBuildStatus, validateSurfaceSources,
  type SurfaceDiscoveryRecord, type SurfacePlannerFeedback,
} from '../surface-plan/index.js';

const MARS: GeographicCoordinates = { frame: 'IAU_MARS', latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] } };
const fixture = (name: string) => readFileSync(new URL(`../../../../docs/examples/surface-plans/${name}`, import.meta.url), 'utf8');

function layer(text: string, options: { id?: string; coordinates?: GeographicCoordinates; kind?: 'catalog' | 'user'; body?: string } = {}): GeographicLayer {
  const id = options.id ?? 'jezero-sites';
  return parseGeographicGeoJson(text, { id, name: 'Jezero sites', body: options.body ?? 'Mars', source: `${id}.geojson`, coordinates: options.coordinates ?? MARS },
    { kind: options.kind ?? 'catalog', identity: `https://example.test/${id}.geojson` });
}

const withHoleAndSeam = JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { name: 'Crater rim' }, geometry: { type: 'Polygon', coordinates: [
    [[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]], [[10.5, 10.5], [10.5, 11.5], [11.5, 11.5], [11.5, 10.5], [10.5, 10.5]]] } },
  { type: 'Feature', id: 7, properties: { name: 'Seam' }, geometry: { type: 'Polygon', coordinates: [[[359, -1], [1, -1], [1, 1], [359, 1], [359, -1]]] } },
  { type: 'Feature', id: 'path', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
] });

describe('surface planner authoring (#250)', () => {
  it('authors three different-resolution regions from imported shapes and roundtrips them with stable IDs', async () => {
    const source = layer(fixture('jezero.geojson'));
    const before = JSON.stringify(source.features.map(f => f.original));
    let plan = createSurfacePlanDraft('Mars', MARS);
    const presets = ['orbit-context', 'descent', 'local-operations'] as const;
    source.features.forEach((f, i) => { plan = addSurfacePlanRegion(plan, source, f, { preset: presets[i] }).plan; });
    expect(plan.regions.map(r => [r.id, r.imagery?.gsdM, r.elevation?.gsdM])).toEqual([
      ['approach', 50, 200], ['landing', 1, 10], ['touchdown', 0.25, 1]]);
    expect(plan.regions.map(r => r.feature.featureId)).toEqual(['string:approach', 'string:landing', 'string:touchdown']);
    expect(plan.frame).toBe('IAU_MARS');
    expect(plan.coordinates).not.toHaveProperty('frame');
    // The read-only source is referenced, not mutated; its provenance is recorded.
    expect(JSON.stringify(source.features.map(f => f.original))).toBe(before);
    expect(plan.layers[0].provenance).toMatchObject({ sourceLayerId: 'jezero-sites', readOnlySource: true, ownership: 'catalog' });
    plan = setSurfacePlanBudget(plan, 100_000_000);
    const text = serializeSurfacePlan(validateDesiredSurfacePlan(plan));
    const reloaded = parseSurfacePlan(text);
    expect(reloaded).toEqual(plan);
    expect(await surfacePlanIdentity(reloaded)).toBe(await surfacePlanIdentity(plan));
    expect(surfacePlanChanges(reloaded, plan).dirty).toBe(false);
    const estimate = await estimateSurfacePlan(reloaded);
    expect(estimate.bands.filter(b => b.channel === 'imagery').map(b => b.gsdM).sort((a, b) => a - b)).toEqual([0.25, 1, 50]);
  });

  it('preserves holes, assigns explicit IDs to unidentified features and refuses non-polygons', () => {
    const source = layer(withHoleAndSeam, { kind: 'user' });
    let plan = createSurfacePlanDraft('Mars', MARS);
    const added = addSurfacePlanRegion(plan, source, source.features[0]);
    plan = added.plan;
    expect(added.regionId).toBe('crater-rim');
    const copy = plan.layers[0].geojson!.features[0];
    expect(copy.id).toBe('crater-rim');
    expect((copy.geometry as { coordinates: unknown[] }).coordinates).toHaveLength(2);
    expect(plan.regions[0].feature.featureId).toBe('string:crater-rim');
    expect(surfaceRegionSource(plan, plan.regions[0])).toEqual({ layerId: 'jezero-sites', featureId: source.features[0].id });
    expect(plan.layers[0].provenance).toMatchObject({ readOnlySource: false, ownership: 'user' });
    expect(surfaceRegionRefusal(plan, source, source.features[2])).toMatch(/polygons/);
    // A second region on the same feature shares one embedded copy.
    plan = addSurfacePlanRegion(plan, source, source.features[0], { name: 'Crater rim' }).plan;
    expect(plan.regions.map(r => r.id)).toEqual(['crater-rim', 'crater-rim-2']);
    expect(plan.layers[0].geojson!.features).toHaveLength(1);
    expect(() => resolveSurfacePlan(plan)).not.toThrow();
  });

  it('handles regions across the longitude seam and displays discovery coverage in an explicit convention', () => {
    const source = layer(withHoleAndSeam);
    const plan = addSurfacePlanRegion(createSurfacePlanDraft('Mars', MARS), source, source.features[1]).plan;
    expect(plan.regions[0].feature.featureId).toBe('number:7');
    const resolved = resolveSurfacePlan(plan);
    expect(resolved.layers[0].features).toHaveLength(1);
    const display = surfaceCoverageLayer('planner:gap', 'Gaps', plan, [{ featureId: 'gap', geometry: [[[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]] }]);
    expect(display.coordinates).toMatchObject({ longitudeDirection: 'east', longitudeDomain: '-180..180' });
    const parsed = parseGeographicGeoJson(JSON.stringify(display.geojson), display, { kind: 'user', identity: 'planner' });
    expect(parsed.features).toHaveLength(1);
  });

  it('refuses frames, bodies and conventions it cannot honestly use without transform', () => {
    const moonMe = layer(withHoleAndSeam, { body: 'Moon', coordinates: { ...MARS, frame: 'MOON_ME_DE421', referenceShape: { kind: 'sphere', radiusKm: 1737.4 } } });
    expect(() => createSurfacePlanDraft('Moon', moonMe.coordinates)).toThrow(/not interchangeable with IAU_MOON/);
    const plan = addSurfacePlanRegion(createSurfacePlanDraft('Mars', MARS), layer(fixture('jezero.geojson')), layer(fixture('jezero.geojson')).features[0]).plan;
    expect(surfaceRegionRefusal(plan, moonMe, moonMe.features[0])).toMatch(/on Moon/);
    const west = layer(withHoleAndSeam, { id: 'west', coordinates: { ...MARS, longitudeDirection: 'west' } });
    expect(surfaceRegionRefusal(plan, west, west.features[0])).toMatch(/no implicit conversion/);
  });

  it('edits intent, presets and exact values; tracks uncommitted changes; refreshes drifted copies', () => {
    const source = layer(fixture('jezero.geojson'), { kind: 'user' });
    const base = addSurfacePlanRegion(createSurfacePlanDraft('Mars', MARS), source, source.features[0], { preset: 'descent' }).plan;
    expect(matchingSurfacePreset(base.regions[0])?.id).toBe('descent');
    let plan = updateSurfacePlanRegion(base, 'approach', { intent: 'imagery' });
    expect(plan.regions[0].elevation).toBeUndefined();
    expect(surfaceRegionIntent(plan.regions[0])).toBe('imagery');
    plan = updateSurfacePlanRegion(plan, 'approach', { imagery: { gsdM: 0.5 } });
    expect(matchingSurfacePreset(plan.regions[0])).toBeUndefined();
    expect(() => updateSurfacePlanRegion(plan, 'approach', { imagery: { gsdM: -1 } })).toThrow();
    expect(base.regions[0].imagery!.gsdM).toBe(1);
    expect(surfacePlanChanges(base, plan)).toMatchObject({ dirty: true, modified: ['approach'], added: [], removed: [] });
    const moved = structuredClone(source.features[0]);
    (moved.original.geometry as { coordinates: number[][][] }).coordinates[0][0] = [77.31, 18.3];
    (moved.original.geometry as { coordinates: number[][][] }).coordinates[0][4] = [77.31, 18.3];
    expect(surfaceRegionDrift(plan, plan.regions[0], source.features[0])).toBe(false);
    expect(surfaceRegionDrift(plan, plan.regions[0], moved)).toBe(true);
    const refreshed = refreshSurfaceRegion(plan, 'approach', moved);
    expect(surfaceRegionDrift(refreshed, refreshed.regions[0], moved)).toBe(false);
    expect(surfacePlanChanges(plan, refreshed).modified).toEqual(['approach']);
    const removed = removeSurfacePlanRegion(refreshed, 'approach');
    expect(removed.regions).toHaveLength(0);
    expect(removed.layers).toHaveLength(0);
  });

  it('renames a region to a unique slug and refuses empty or taken names', () => {
    const source = layer(fixture('jezero.geojson'), { kind: 'user' });
    let plan = addSurfacePlanRegion(createSurfacePlanDraft('Mars', MARS), source, source.features[0]).plan;
    plan = addSurfacePlanRegion(plan, source, source.features[1]).plan;
    const [first, second] = plan.regions.map(r => r.id);
    const renamed = renameSurfacePlanRegion(plan, first, '  Crater Rim ');
    expect(renamed.regionId).toBe('crater-rim');
    expect(renamed.plan.regions.map(r => r.id)).toEqual(['crater-rim', second]);
    expect(renamed.plan.regions[0].feature).toEqual(plan.regions[0].feature);
    expect(plan.regions[0].id).toBe(first);
    expect(() => renameSurfacePlanRegion(plan, first, '!!')).toThrow(/letter or digit/);
    expect(() => renameSurfacePlanRegion(plan, first, second)).toThrow(/already named/);
    expect(renameSurfacePlanRegion(plan, first, first).regionId).toBe(first);
  });

  it('an imagery-only plan on a reference ellipsoid needs no elevation inputs or work', async () => {
    const source = layer(fixture('jezero.geojson'), { kind: 'user' });
    const plan = addSurfacePlanRegion(createSurfacePlanDraft('Mars', MARS), source, source.features[1], { intent: 'imagery', preset: 'descent' }).plan;
    const estimate = await estimateSurfacePlan(plan);
    expect(estimate.bands.every(b => b.channel === 'imagery')).toBe(true);
    expect(estimate.totals.elevation).toMatchObject({ areaM2: 0, baseSamples: 0, publishedBytes: { min: 0, max: 0 } });
    expect(estimate.fidelity.elevation.requestedAreaM2).toBe(0);
    // With no inventory, discovery explicitly reports no candidates, never assumed coverage.
    const report = recommendSurfaceSources(plan, []);
    expect(report.recommendations).toEqual([expect.objectContaining({ channel: 'imagery', status: 'no-matching-candidate', candidates: [] })]);
    expect(report.recommendations.some(r => r.channel === 'elevation')).toBe(false);
  });

  it('works with the deterministic Jezero discovery inventory', async () => {
    const source = layer(fixture('jezero.geojson'));
    let plan = createSurfacePlanDraft('Mars', MARS);
    for (const f of source.features) plan = addSurfacePlanRegion(plan, source, f, { preset: 'descent' }).plan;
    const records = JSON.parse(fixture('mars-jezero.inventory.json')) as SurfaceDiscoveryRecord[];
    const report = recommendSurfaceSources(plan, records);
    expect(report.combinations.map(c => c.regionId)).toEqual(['approach', 'landing', 'touchdown']);
    expect(report.combinations.every(c => c.alternatives.length >= 1 && c.alternatives.length <= 3)).toBe(true);
  });

  it('assesses selected-plan fidelity per region: a source chosen for one region never satisfies another', async () => {
    const source = layer(fixture('jezero.geojson'));
    let plan = createSurfacePlanDraft('Mars', MARS);
    for (const f of source.features.slice(0, 2)) plan = addSurfacePlanRegion(plan, source, f, { intent: 'elevation' }).plan;
    const dem = validateSurfaceSources(JSON.parse(fixture('jezero.sources.json')));
    // Pooled, the DEM covering both regions satisfies both.
    expect((await estimateSurfacePlan(plan, { sources: dem })).fidelity.elevation.unsatisfiedAreaM2).toBe(0);
    const selected = await surfaceSelectedFidelity(plan, id => id === 'approach' ? dem : []);
    expect(selected.approach.elevation.adequateAreaM2).toBeGreaterThan(0);
    expect(selected.landing.elevation.adequateAreaM2).toBe(0);
    expect(selected.landing.elevation.requestedAreaM2).toBeGreaterThan(0);
  });

  it('reports built/published status from build feedback, and unknown without it', () => {
    const lock = JSON.parse(fixture('jezero-build.lock.json'));
    const plan = validateDesiredSurfacePlan(lock.desired);
    // The checked-in feedback predates its `surface` field: conventions come from its lock here.
    const stated = parseSurfacePlannerFeedback(JSON.parse(readFileSync(new URL('../../../../docs/releases/surface-build-jezero/production-planner-feedback.json', import.meta.url), 'utf8')));
    expect(stated.surface).toBeUndefined();
    expect(surfaceRegionBuildStatus(plan, stated, 'pilot', 'imagery')).toMatchObject({ status: 'published-unproven', detail: expect.stringContaining('does not state the build') });
    const feedback: SurfacePlannerFeedback = { ...stated, surface: { body: lock.desired.body, frame: lock.desired.frame, coordinates: lock.desired.coordinates } };
    expect(surfaceRegionBuildStatus(plan, null, 'pilot', 'imagery').status).toBe('unknown');
    expect(surfaceRegionBuildStatus(plan, feedback, 'pilot', 'imagery', ['hirise-ortho']).status).toBe('published');
    expect(surfaceRegionBuildStatus(plan, feedback, 'context', 'imagery').status).toBe('published');
    // The real Jezero terrain is published, but its ROI coverage is not proved by tile availability: not success.
    expect(surfaceRegionBuildStatus(plan, feedback, 'pilot', 'elevation').status).toBe('published-unproven');
    expect(surfaceRegionBuildStatus(plan, feedback, 'pilot', 'imagery', ['other']).status).toBe('needs-build');
    expect(surfaceRegionBuildStatus(updateSurfacePlanRegion(plan, 'pilot', { imagery: { gsdM: 0.1 } }), feedback, 'pilot', 'imagery').status).toBe('needs-build');
    expect(surfaceRegionBuildStatus(plan, feedback, 'context', 'elevation').status).toBe('needs-build');
    const unpublished: SurfacePlannerFeedback = { ...feedback, products: feedback.products.map(p => ({ ...p, publication: { ...p.publication, status: 'not-published' as const } })) };
    expect(surfaceRegionBuildStatus(plan, unpublished, 'pilot', 'elevation').status).toBe('built');

    // A stricter physical accuracy limit, with GSD, shape and sources unchanged.
    const strict = updateSurfacePlanRegion(plan, 'pilot', { elevation: { gsdM: 100, accuracyM: 1 } });
    const proved: SurfacePlannerFeedback = { ...feedback, products: feedback.products.map(p => ({ ...p, continuousNativeCoverageStatus: 'proved-for-checked-requested-ROI-only' as const })) };
    expect(surfaceRegionBuildStatus(plan, proved, 'pilot', 'elevation').status).toBe('published');
    // Unreported accuracy against a limit is unproven, not success.
    expect(surfaceRegionBuildStatus(strict, proved, 'pilot', 'elevation')).toMatchObject({ status: 'published-unproven', detail: expect.stringContaining('accuracy is unreported') });
    const withAccuracy = (m: number): SurfacePlannerFeedback => ({ ...proved, requested: proved.requested.map(r => ({ ...r,
      channels: r.channels.map(c => ({ ...c, accuracyM: c.sourceIds.map(sourceId => ({ sourceId, accuracyM: m })) })) })) });
    expect(surfaceRegionBuildStatus(strict, withAccuracy(2), 'pilot', 'elevation').status).toBe('needs-build');
    expect(surfaceRegionBuildStatus(strict, withAccuracy(0.5), 'pilot', 'elevation').status).toBe('published');

    // Same numbers on another body, or in other conventions, are not a reusable product.
    const moon = (() => { const p = structuredClone(plan); p.body = 'Moon'; p.frame = 'IAU_MOON'; return p; })();
    expect(surfaceRegionBuildStatus(moon, feedback, 'pilot', 'imagery').status).toBe('needs-build');
    const oblate = { ...plan, coordinates: { ...plan.coordinates, referenceShape: { kind: 'ellipsoid' as const, radiiKm: [3396.19, 3396.19, 3376.2] as [number, number, number] } } };
    expect(surfaceRegionBuildStatus(oblate, feedback, 'pilot', 'imagery').status).toBe('needs-build');
    expect(surfaceRegionBuildStatus(plan, stated, 'pilot', 'imagery', null, feedback.surface!).status).toBe('published');
    expect(surfaceRegionBuildStatus(moon, stated, 'pilot', 'imagery', null, feedback.surface!).status).toBe('needs-build');

    // Achieved output, not the original request: a product whose finest level is coarser than the target is not sufficient.
    const coarse: SurfacePlannerFeedback = { ...feedback, products: feedback.products.map(p => ({ ...p, emitted: { ...p.emitted, outputSpacingMByLevel: p.emitted.outputSpacingMByLevel.slice(0, -2) } })) };
    expect(surfaceRegionBuildStatus(plan, coarse, 'pilot', 'imagery')).toMatchObject({ status: 'needs-build', detail: expect.stringContaining('Finest output produced') });

    // Unrecognized statuses and identities are refused, never read as published.
    const raw = JSON.parse(readFileSync(new URL('../../../../docs/releases/surface-build-jezero/production-planner-feedback.json', import.meta.url), 'utf8'));
    expect(() => parseSurfacePlannerFeedback({ ...raw, products: [{ ...raw.products[0], publication: { ...raw.products[0].publication, status: 'published' } }] })).toThrow(/publication status/);
    expect(() => parseSurfacePlannerFeedback({ ...raw, products: [{ ...raw.products[0], continuousNativeCoverageStatus: 'full' }] })).toThrow(/coverage status/);
    expect(() => parseSurfacePlannerFeedback({ ...raw, lockIdentity: 'abc' })).toThrow(/lock identity/);
    expect(() => parseSurfacePlannerFeedback({ ...raw, products: [{ ...raw.products[0], emitted: {} }] })).toThrow(/output spacings/);
    expect(() => parseSurfacePlannerFeedback({ ...raw, surface: { body: 'Mars' } })).toThrow(/surface/);
    expect(() => parseSurfacePlannerFeedback({ kind: 'surface-planner-feedback' })).toThrow();
  });
});
