import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createLockedSurfacePlan, estimateSurfacePlan, formatSurfacePlanEstimate, parseSurfacePlan, resolveSurfacePlan,
  serializeSurfacePlan, surfacePlanIdentity, SurfacePlanError, validateDesiredSurfacePlan,
  validateLockedSurfacePlan, validateSurfaceSources,
  type DesiredSurfacePlan, type LockedSurfacePlan, type SurfaceFeatureCollection, type SurfacePlanRegion, type SurfaceSourceDescriptor,
} from '../surface-plan/index.js';

const rectangle = (id: string | number, x0: number, y0: number, x1: number, y1: number): SurfaceFeatureCollection['features'][number] => ({
  type: 'Feature', id, properties: null,
  geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
});
const collection = (...features: SurfaceFeatureCollection['features']): SurfaceFeatureCollection => ({ type: 'FeatureCollection', features });
const region = (id: string, gsdM: number, extra: Partial<SurfacePlanRegion> = {}): SurfacePlanRegion => ({
  id, feature: { layerId: 'roi', featureId: `string:${id}` }, imagery: { gsdM }, ...extra,
});
function plan(features = collection(rectangle('a', 0, 0, 1, 1)), regions = [region('a', 10)]): DesiredSurfacePlan {
  return { version: 1, kind: 'desired-surface-plan', body: 'Moon', frame: 'IAU_MOON',
    coordinates: { latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 1000 } },
    layers: [{ id: 'roi', name: 'ROI', body: 'Moon', source: 'roi.geojson', geojson: features }], regions };
}
function source(p: DesiredSurfacePlan, changes: Partial<SurfaceSourceDescriptor> = {}): SurfaceSourceDescriptor {
  return { id: 'dem', productId: 'TEST-DEM', channel: 'elevation', body: p.body, frame: p.frame, coordinates: p.coordinates,
    footprint: p.layers[0].geojson, nodata: 'none', nativeGsdM: 200, accuracyM: 10, projection: 'equirectangular',
    datum: { referenceShape: p.coordinates.referenceShape, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    asset: { retrieval: 'Synthetic fixture', version: 'v1', bytes: 1234 }, license: { name: 'Apache-2.0', attribution: 'Test' }, ...changes };
}
const fixtureText = (name: string) => readFileSync(new URL(`../../../../docs/examples/surface-plans/${name}`, import.meta.url), 'utf8');
const sphereArea = (r: number, x0: number, y0: number, x1: number, y1: number) => r * r * (x1 - x0) * Math.PI / 180
  * (Math.sin(y1 * Math.PI / 180) - Math.sin(y0 * Math.PI / 180));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('versioned surface data plans', () => {
  it('roundtrips desired JSON and hashes key order deterministically without mutating authored features', async () => {
    const p = plan();
    const before = JSON.stringify(p);
    const reversed = Object.fromEntries(Object.entries(p).reverse());
    expect(parseSurfacePlan(serializeSurfacePlan(p))).toEqual(p);
    expect(await surfacePlanIdentity(reversed)).toBe(await surfacePlanIdentity(p));
    await estimateSurfacePlan(p);
    expect(JSON.stringify(p)).toBe(before);
    const changed = clone(p); changed.regions[0].imagery!.gsdM = 20;
    expect(await surfacePlanIdentity(changed)).not.toBe(await surfacePlanIdentity(p));
  });

  it('identifies the resolved contents of local references, not just filenames', async () => {
    const p = plan(), data = p.layers[0].geojson!; delete p.layers[0].geojson;
    await expect(estimateSurfacePlan(p)).rejects.toMatchObject({ diagnostics: [{ code: 'unresolved-reference' }] });
    const a = await estimateSurfacePlan(p, { references: new Map([['roi.geojson', JSON.stringify(data)]]) });
    const b = await estimateSurfacePlan(p, { references: new Map([['roi.geojson', JSON.stringify(collection(rectangle('a', 0, 0, 2, 1)))]]) });
    expect(a.desiredIdentity).not.toBe(b.desiredIdentity);
    expect(p.layers[0].geojson).toBeUndefined();
  });

  it.each([
    ['wrong kind', (p: any) => { p.kind = 'locked-surface-plan'; }],
    ['future version', (p: any) => { p.version = 2; }],
    ['implicit WGS84', (p: any) => { delete p.coordinates; }],
    ['unknown datum', (p: any) => { p.coordinates.height = { unit: 'm', datum: 'areoid', convention: 'radial' }; }],
    ['triaxial shape', (p: any) => { p.coordinates.referenceShape = { kind: 'ellipsoid', radiiKm: [2, 1, 1] }; }],
    ['wrong units', (p: any) => { p.regions[0].imagery.gsdKm = 1; }],
    ['zero GSD', (p: any) => { p.regions[0].imagery.gsdM = 0; }],
    ['negative accuracy', (p: any) => { p.regions[0].imagery.accuracyM = -1; }],
    ['wrong frame', (p: any) => { p.frame = 'J2000'; }],
    ['wrong body', (p: any) => { p.layers[0].body = 'Mars'; }],
    ['duplicate regions', (p: any) => { p.regions.push(p.regions[0]); }],
    ['order-based IDs', (p: any) => { p.regions[0].feature.featureId = 'index:0'; }],
    ['missing layer', (p: any) => { p.regions[0].feature.layerId = 'absent'; }],
    ['too many regions', (p: any) => { p.regions = Array(33).fill(p.regions[0]); }],
  ])('rejects %s with structured diagnostics', (_label, edit) => {
    const p = plan(); edit(p);
    expect(() => validateDesiredSurfacePlan(p)).toThrow(SurfacePlanError);
  });

  it('rejects non-JSON, oversized, deeply nested, and malformed input', () => {
    expect(() => serializeSurfacePlan({ bad: NaN })).toThrow(SurfacePlanError);
    expect(() => serializeSurfacePlan({ bad: undefined })).toThrow(SurfacePlanError);
    expect(() => serializeSurfacePlan({ bad: new Map() })).toThrow(SurfacePlanError);
    expect(() => parseSurfacePlan('{')).toThrow(SurfacePlanError);
    expect(() => parseSurfacePlan('['.repeat(33))).toThrow(SurfacePlanError);
    expect(() => parseSurfacePlan(' '.repeat(2 * 1024 * 1024 + 1))).toThrow(SurfacePlanError);
  });

  it('uses the same geographic topology validation and reports invalid shapes/references', () => {
    const p = plan();
    p.layers[0].geojson!.features[0].geometry = { type: 'Point', coordinates: [0, 0] };
    expect(() => resolveSurfacePlan(p)).toThrow(/Polygon/);
    p.layers[0].geojson = collection(rectangle('a', 0, 0, 1, 1));
    p.layers[0].geojson.features[0].geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]] };
    expect(() => resolveSurfacePlan(p)).toThrow(/self-intersects/);
    p.layers[0].geojson = collection(rectangle('absent', 0, 0, 1, 1));
    expect(() => resolveSurfacePlan(p)).toThrow(/not found/);
    expect(() => resolveSurfacePlan(parseSurfacePlan(fixtureText('lunar-pole-unsupported.plan.json')))).toThrow(/Pole-enclosing/);
  });
});

describe('overlap-aware physical area and resource estimates', () => {
  it('integrates a spherical rectangle in physical meters and separates imagery and DEM sampling', async () => {
    const p = plan(); p.regions[0].elevation = { gsdM: 100 };
    const e = await estimateSurfacePlan(p);
    const expected = sphereArea(1e6, 0, 0, 1, 1);
    expect(e.totals.imagery.areaM2).toBeCloseTo(expected, 3);
    expect(e.totals.imagery.baseSamples).toBe(Math.ceil(expected / 100));
    expect(e.totals.elevation.baseSamples).toBe(Math.ceil(expected / 10000));
    expect(e.stage).toBe('geometry-only');
    expect(e.bands.every(b => b.sourceEvidence.status === 'unknown')).toBe(true);
    expect(e.totals.rawSourceDownloadBytes.max).toBeNull();
    expect(e.totals.peakWorkDiskBytes.max).toBeNull();
    expect(e.totals.outputWorkDiskBytes.max).toBe(e.totals.outputWorkDiskBytes.min * 2);
    expect(e.bands[0].pyramidSamples!).toBeGreaterThan(e.bands[0].baseSamples!);
    const finitePyramidFactor = 4 / 3 * (1 - 4 ** -e.bands[0].levels!);
    expect(e.bands[0].pyramidSamples! / e.bands[0].baseSamples!).toBeCloseTo(finitePyramidFactor, 5);
  });

  it('integrates oblate ellipsoids and converts centric latitude in the area integral', async () => {
    const p = plan(); p.coordinates.referenceShape = { kind: 'ellipsoid', radiiKm: [2000, 2000, 1000] };
    const graphic = await estimateSurfacePlan(p);
    const a = 2e6, b = 1e6, e2 = 1 - b * b / (a * a);
    const localMetric = a * a * (1 - e2) * (Math.PI / 180) ** 2;
    expect(graphic.totals.imagery.areaM2 / localMetric).toBeCloseTo(1, 3);
    p.coordinates.latitude = 'planetocentric';
    const centric = await estimateSurfacePlan(p);
    expect(centric.totals.imagery.areaM2 / graphic.totals.imagery.areaM2).toBeCloseTo(4, 1);
    const sphere = plan(); sphere.coordinates.referenceShape = { kind: 'ellipsoid', radiiKm: [1000, 1000, 1000] };
    expect((await estimateSurfacePlan(sphere)).totals.imagery.areaM2).toBeCloseTo(sphereArea(1e6, 0, 0, 1, 1), 3);
  });

  it('unions intersecting ROIs and assigns finest fidelity independently of source order/priority', async () => {
    const p = plan(collection(rectangle('a', 0, 0, 2, 1), rectangle('b', 1, 0, 3, 1)), [region('a', 10, { priority: 100 }), region('b', 5)]);
    const e = await estimateSurfacePlan(p);
    expect(e.bands.map(b => b.gsdM)).toEqual([5, 10]);
    expect(e.bands[0].areaM2).toBeCloseTo(sphereArea(1e6, 1, 0, 3, 1), 3);
    expect(e.bands[1].areaM2).toBeCloseTo(sphereArea(1e6, 0, 0, 1, 1), 3);
    expect(e.totals.imagery.areaM2).toBeCloseTo(sphereArea(1e6, 0, 0, 3, 1), 3);
    p.regions.reverse();
    expect((await estimateSurfacePlan(p)).bands).toEqual(e.bands);
  });

  it('combines the strictest accuracy and GSD in overlaps', async () => {
    const p = plan(collection(rectangle('a', 0, 0, 2, 1), rectangle('b', 1, 0, 3, 1)),
      [region('a', 10, { imagery: { gsdM: 10, accuracyM: 1 } }), region('b', 5, { imagery: { gsdM: 5, accuracyM: 10 } })]);
    const e = await estimateSurfacePlan(p);
    expect(e.bands.map(b => [b.gsdM, b.accuracyM])).toEqual([[5, 1], [5, 10], [10, 1]]);
    expect(e.totals.imagery.areaM2).toBeCloseTo(sphereArea(1e6, 0, 0, 3, 1), 3);
  });

  it('preserves holes, MultiPolygons, and duplicate ROI unions', async () => {
    const a = rectangle('a', 0, 0, 3, 3);
    a.geometry = { type: 'MultiPolygon', coordinates: [
      [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]],
      [[[4, 0], [5, 0], [5, 1], [4, 1], [4, 0]]],
    ] };
    const p = plan(collection(a), [region('a', 10), region('duplicate', 10, { feature: { layerId: 'roi', featureId: 'string:a' } })]);
    const e = await estimateSurfacePlan(p);
    const expected = sphereArea(1e6, 0, 0, 3, 3) - sphereArea(1e6, 1, 1, 2, 2) + sphereArea(1e6, 4, 0, 5, 1);
    expect(e.totals.imagery.areaM2).toBeCloseTo(expected, 2);
    expect(e.bands).toHaveLength(1);
  });

  it('handles the lunar polar longitude seam and east/west longitude conventions', async () => {
    const lunar = parseSurfacePlan(fixtureText('lunar-pole.plan.json'));
    const refs = new Map([['lunar-pole.geojson', fixtureText('lunar-pole.geojson')]]);
    const e = await estimateSurfacePlan(lunar, { references: refs });
    const expected = sphereArea(1737400, 179, -89.5, 181, -89);
    expect(e.totals.elevation.areaM2).toBeCloseTo(expected, 2);
    expect(e.totals.imagery.areaM2).toBeCloseTo(expected, 2);
    expect(e.diagnostics.some(d => d.code === 'longitude-seam')).toBe(true);
    lunar.coordinates.longitudeDirection = 'west';
    expect((await estimateSurfacePlan(lunar, { references: refs })).totals.elevation.areaM2).toBeCloseTo(expected, 2);
  });

  it('captures gutters, full-tile packing, imagery/elevation compression, and browser scenarios', async () => {
    const p = plan();
    const a = await estimateSurfacePlan(p, { assumptions: { gutter: 0, imageryCompression: [1, 1] } });
    const b = await estimateSurfacePlan(p, { assumptions: { gutter: 2, imageryCompression: [1, 1] } });
    expect(b.totals.publishedBytes.min / a.totals.publishedBytes.min).toBeCloseTo((260 / 256) ** 2, 4);
    expect(b.totals.publishedObjects).toEqual(a.totals.publishedObjects);
    expect(b.browser.decodedTileBytes.imagery).toBe(260 * 260 * 3);
    expect(b.browser.visibleRequests).toEqual({ min: 16, max: 64 });
    b.assumptions.elevationCompression[0] = 99;
    expect((await estimateSurfacePlan(p)).assumptions.elevationCompression).toEqual([0.25, 0.8]);
    await expect(estimateSurfacePlan(p, { assumptions: { imageryCompression: [0.9, 0.1] } })).rejects.toThrow(SurfacePlanError);
  });

  it('returns explicit unknowns for impossible sample counts instead of Infinity or invented sizes', async () => {
    const p = plan(); p.regions[0].imagery!.gsdM = 1e-200;
    const e = await estimateSurfacePlan(p);
    expect(e.bands[0].baseSamples).toBeNull();
    expect(e.totals.publishedBytes.max).toBeNull();
    expect(e.diagnostics.some(d => d.code === 'impossible-estimate')).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(/Infinity|NaN/);
  });

  it('provides bounded explicit budget comparisons that protect higher priorities and require-target regions', async () => {
    const p = plan(collection(rectangle('a', 0, 0, 2, 2), rectangle('b', 0.9, 0.9, 1.1, 1.1)),
      [region('a', 10, { fallback: 'allow-coarser' }), region('b', 1, { priority: 100, fallback: 'require-target' })]);
    p.budget = { publishedBytes: 1 };
    const original = clone(p);
    const e = await estimateSurfacePlan(p);
    expect(e.budget?.status).toBe('over');
    expect(e.budget?.comparisons).toHaveLength(2);
    expect(e.budget?.comparisons.every(c => c.regionIds.join() === 'a' && c.publishedBytes.min < e.totals.publishedBytes.min)).toBe(true);
    expect(p).toEqual(original);
    p.regions[0].fallback = 'require-target';
    expect((await estimateSurfacePlan(p)).budget?.comparisons).toEqual([]);
    p.budget.publishedBytes = 1e12;
    expect((await estimateSurfacePlan(p)).budget?.status).toBe('within');
    p.budget.publishedBytes = Math.ceil(e.totals.publishedBytes.min * 1.1);
    expect((await estimateSurfacePlan(p)).budget?.status).toBe('uncertain');
  });
});

describe('source evidence and locked builds', () => {
  it('never calls 200 m native DEM genuine 1 m terrain, even when allow-coarser is requested', async () => {
    const p = plan(); p.regions[0] = { ...region('a', 1), imagery: undefined, elevation: { gsdM: 1 }, fallback: 'allow-coarser' };
    delete p.regions[0].imagery;
    const e = await estimateSurfacePlan(p, { sources: [source(p)] });
    expect(e.stage).toBe('source-aware');
    expect(e.bands[0].sourceEvidence.status).toBe('unsatisfied');
    expect(e.bands[0].sourceEvidence.adequateAreaM2).toBe(0);
    expect(e.bands[0].sourceEvidence.candidates[0].nativeGsdM).toBe(200);
    expect(e.diagnostics.some(d => d.code === 'coarser-native-source')).toBe(true);
    expect(e.totals.rawSourceDownloadBytes).toEqual({ min: 1234, max: 1234 });
  });

  it('accounts for partial footprints, masks, unknown resolution and absent footprint evidence', async () => {
    const p = plan();
    const s = source(p, { channel: 'imagery', nativeGsdM: 1, footprint: collection(rectangle('coverage', 0, 0, 0.5, 1)) });
    const e = await estimateSurfacePlan(p, { sources: [s] });
    expect(e.bands[0].sourceEvidence.status).toBe('partial');
    expect(e.bands[0].sourceEvidence.adequateAreaM2 / e.bands[0].areaM2).toBeCloseTo(0.5, 6);
    for (const unknown of [{ nodata: 'unknown' }, { nativeGsdM: null }, { footprint: undefined }, { datum: { ...s.datum, verticalDatum: 'areoid' } }]) {
      const candidate = { ...s, ...unknown } as SurfaceSourceDescriptor;
      if (candidate.footprint === undefined) delete candidate.footprint;
      const result = await estimateSurfacePlan(p, { sources: [candidate] });
      expect(result.bands[0].sourceEvidence.status).toBe('unknown');
    }
    const absent = source(p, { channel: 'imagery', nativeGsdM: 1, footprint: collection(rectangle('coverage', 2, 0, 3, 1)) });
    const outside = await estimateSurfacePlan(p, { sources: [absent] });
    expect(outside.sourceDownload.candidateIds).toEqual([]);
    expect(outside.bands[0].sourceEvidence.status).toBe('unknown');
    const mismatched = source(p, { body: 'Mars' });
    expect((await estimateSurfacePlan(p, { sources: [mismatched] })).diagnostics.some(d => d.code === 'unsupported-source-transform')).toBe(true);
  });

  it('unions adequate source coverage and counts assets once across bands', async () => {
    const p = plan(collection(rectangle('a', 0, 0, 2, 1), rectangle('b', 1, 0, 2, 1)), [region('a', 10), region('b', 5)]);
    const s = source(p, { channel: 'imagery', nativeGsdM: 1 });
    const e = await estimateSurfacePlan(p, { sources: [s] });
    expect(e.bands.every(b => b.sourceEvidence.status === 'satisfied')).toBe(true);
    expect(e.totals.rawSourceDownloadBytes).toEqual({ min: 1234, max: 1234 });
    const changedVersion = clone(s); changedVersion.asset.version = 'v2';
    const changedEstimate = await estimateSurfacePlan(p, { sources: [changedVersion] });
    expect(changedEstimate.sourceMetadataIdentity).not.toBe(e.sourceMetadataIdentity);
    expect(changedEstimate.desiredIdentity).toBe(e.desiredIdentity);
    const unknownSize = clone(s); delete unknownSize.asset.bytes;
    const unknown = await estimateSurfacePlan(p, { sources: [unknownSize] });
    expect(unknown.totals.rawSourceDownloadBytes).toEqual({ min: 0, max: null });
    expect(unknown.sourceDownload.unknownSizeIds).toEqual(['dem']);
    p.regions[0].imagery!.accuracyM = 0.1;
    expect((await estimateSurfacePlan(p, { sources: [s] })).bands.some(b => b.sourceEvidence.status === 'unsatisfied')).toBe(true);
  });

  it('validates metadata, including malformed footprints and duplicate source IDs', () => {
    const p = plan();
    expect(() => validateSurfaceSources([source(p), source(p)])).toThrow(/Duplicate/);
    expect(() => validateSurfaceSources([{ ...source(p), nativeGsdM: -1 }])).toThrow(/positive/);
    expect(() => validateSurfaceSources([{ ...source(p), footprint: {} }])).toThrow(SurfacePlanError);
  });

  function lockInput(): Omit<LockedSurfacePlan, 'identity' | 'desiredIdentity'> {
    const p = plan();
    return { version: 1, kind: 'locked-surface-plan', desired: p, sources: [source(p, { channel: 'imagery', nativeGsdM: 1 })],
      selections: [{ regionId: 'a', channel: 'imagery', sourceIds: ['dem'], outputGsdM: 10, resampling: 'bilinear', transformations: ['identity: IAU_MOON / declared sphere'] }],
      processing: { generator: { name: 'test-generator', version: '1.0.0' }, fusion: 'single-source', parameters: {} },
      output: { representation: 'tiled-raster-pyramid', formatVersion: '1', tileSize: 256, gutter: 1, imageryEncoding: 'png-rgb8', elevationEncoding: 'float32' } };
  }
  it('roundtrips a lock with a new identity for every source/output/generator choice and rejects tampering', async () => {
    const input = lockInput();
    const lock = await createLockedSurfacePlan(input);
    expect(await validateLockedSurfacePlan(JSON.parse(serializeSurfacePlan(lock)))).toEqual(lock);
    expect(() => validateDesiredSurfacePlan(lock)).toThrow(SurfacePlanError);
    const tampered = clone(lock); tampered.sources[0].asset.version = 'v2';
    await expect(validateLockedSurfacePlan(tampered)).rejects.toThrow(/Content changed/);
    const changed = clone(input); changed.sources[0].asset.version = 'v2';
    expect((await createLockedSurfacePlan(changed)).identity).not.toBe(lock.identity);
    expect((await createLockedSurfacePlan(changed)).desiredIdentity).toBe(lock.desiredIdentity);
    changed.processing.generator.version = '2.0.0';
    expect((await createLockedSurfacePlan(changed)).identity).not.toBe((await createLockedSurfacePlan(input)).identity);
  });
  it('requires source pinning, fully embedded ROIs, and explicit complete channel selections in a lock', async () => {
    const input = lockInput(); delete input.sources[0].asset.version;
    await expect(createLockedSurfacePlan(input)).rejects.toThrow(/version or checksum/);
    input.sources[0].asset.version = 'v1'; delete input.desired.layers[0].geojson;
    await expect(createLockedSurfacePlan(input)).rejects.toThrow(/embed/);
    const incomplete = lockInput(); incomplete.desired.regions[0].elevation = { gsdM: 10 };
    await expect(createLockedSurfacePlan(incomplete)).rejects.toThrow(/Missing explicit selection/);
  });

  it('keeps synthetic Mars examples reproducible without implying HiRISE coverage', async () => {
    const p = parseSurfacePlan(fixtureText('jezero.plan.json'));
    const options = { references: new Map([['jezero.geojson', fixtureText('jezero.geojson')]]), sources: validateSurfaceSources(JSON.parse(fixtureText('jezero.sources.json'))) };
    const a = await estimateSurfacePlan(p, options), b = await estimateSurfacePlan(p, options);
    expect(a).toEqual(b);
    const text = formatSurfacePlanEstimate(a);
    expect(text).toBe(formatSurfacePlanEstimate(b));
    expect(text).toContain('source-aware');
    expect(text).toContain('source unsatisfied');
    expect(text).toContain('Peak/intermediate work disk:');
    expect(text).toContain('Compare only approach at 2× coarser GSD');
    expect(text).toMatchSnapshot();
  });
});
