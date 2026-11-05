import { describe, it, expect, vi } from 'vitest';
import jezero from './__fixtures__/geographic-jezero.json';
import southpole from './__fixtures__/geographic-southpole.json';
import { Universe } from '../Universe.js';
import { loadCatalogFromUrl } from '../catalog/CatalogResolver.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';
import {
  parseGeographicGeoJson, loadGeographicLayers, fetchGeographicText, geographicAbsolutePosition,
  validateGeographicCoordinates, type GeographicCoordinates, type GeographicLayerDefinition, type GeographicLayer,
} from '../geographic/index.js';

const mars: GeographicCoordinates = {
  latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
};
const moon: GeographicCoordinates = {
  latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
  referenceShape: { kind: 'sphere', radiusKm: 1737.4 },
};
const spec: GeographicLayerDefinition = { id: 'mars:science', name: 'Jezero', body: 'Mars', source: 'vectors/jezero.geojson', coordinates: mars,
  display: { visible: true, color: '#ffcc00', opacity: 0.7 }, provenance: { mission: 'Mars 2020', version: 2 } };
const source = { kind: 'catalog' as const, identity: 'https://data.test/vectors/jezero.geojson', catalog: 'https://data.test/scene.json' };
const feature = (geometry: unknown, id?: string | number, properties: unknown = {}) => ({ type: 'Feature', id, properties, geometry });
const point = (coords: unknown = [77.45, 18.45]) => ({ type: 'Point', coordinates: coords });
const collection = (...features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const parse = (text: string, definition = spec) => parseGeographicGeoJson(text, definition, source);
const position = (layer: GeographicLayer) => {
  const geometry = layer.features[0].geometry;
  if (geometry.type !== 'Point') throw new Error('Expected point');
  return geometry.coordinates;
};

describe('planetary GeoJSON data', () => {
  it('imports Jezero points, traverse, all Multi geometries and regions with holes without losing properties', () => {
    const layer = parse(JSON.stringify(jezero));
    expect(layer.features.map(x => x.geometry.type)).toEqual(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);
    expect(layer.skippedFeatures).toBe(0);
    expect(layer.diagnostics).toEqual([]);
    expect(layer.features[0].properties).toEqual(jezero.features[0].properties);
    expect(layer.features[4].original).toEqual(jezero.features[4]);
    expect(layer).toMatchObject({ body: 'Mars', frame: 'IAU_MARS', ownership: 'catalog', source, definition: spec });
    expect(position(layer).latDeg).toBeGreaterThan(18.45); // Centric != graphic on Mars.
    expect(position(layer)).not.toHaveProperty('heightKm');
    expect(JSON.parse(JSON.stringify(layer))).toEqual(layer);
  });

  it.each([-1,1])('preserves planar source cuts while normalizing a pole-%s cap for the globe', sign => {
    const geometry = {type: 'Polygon', coordinates: [[[-180,sign*80],[-180,sign*90],[180,sign*90],[180,sign*80],[90,sign*70],[0,sign*75],[-90,sign*70],[-180,sign*80]]]};
    const layer = parse(collection(feature(geometry,'cap')), {...spec,body:'Moon',coordinates:moon});
    expect(layer.diagnostics).toEqual([]);
    expect(layer.features).toHaveLength(1);
    expect(layer.features[0].original.geometry).toEqual(geometry);
    const normalized = layer.features[0].geometry;
    if (normalized.type !== 'Polygon') throw new Error('Expected polygon');
    expect(normalized.coordinates[0]).toHaveLength(5);
    expect(normalized.coordinates[0].some(p => Math.abs(p.latDeg) === 90)).toBe(false);
  });

  it('accepts lunar south-pole regions and holes across the longitude seam', () => {
    const layer = parse(JSON.stringify(southpole), { ...spec, body: 'Moon', coordinates: moon });
    expect(layer.skippedFeatures).toBe(0);
    expect(layer.features[1].geometry).toMatchObject({ type: 'Polygon' });
    expect(layer.features[1].original.geometry).toEqual(southpole.features[1].geometry);
    expect(position(layer)).toEqual({ latDeg: -89.5, lonDeg: -179.8 });
  });

  it('preserves typed IDs, stable fallbacks, foreign members, and diagnoses duplicate IDs', () => {
    const text = collection(feature(point(), 7), feature(point(), '7'), feature(point()), feature(point(), 7),
      { ...feature(point(), 'foreign'), links: ['paper'] });
    const layer = parse(text);
    expect(layer.features.map(x => x.id)).toEqual(['number:7', 'string:7', 'index:2', 'string:foreign']);
    expect(layer.features.at(-1)!.original.links).toEqual(['paper']);
    expect(layer.skippedFeatures).toBe(1);
    expect(layer.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'generated-id', featureIndex: 2 }),
      expect.objectContaining({ code: 'skipped-feature', featureIndex: 3, message: expect.stringContaining('Duplicate') }),
    ]));
    expect(parse(text).features.map(x => x.id)).toEqual(layer.features.map(x => x.id));
  });

  it('normalizes west longitudes, both domains, seam endpoints and meter heights', () => {
    const coordinates: GeographicCoordinates = { ...moon, longitudeDirection: 'west', longitudeDomain: '0..360', height: { unit: 'm', datum: 'reference-sphere', convention: 'geodetic-normal' } };
    const layer = parse(collection(feature(point([350, -89, 1200]), 'site')), { ...spec, coordinates });
    expect(position(layer)).toEqual({ latDeg: -89, lonDeg: 10, heightKm: 1.2 });
    expect(position(parse(collection(feature(point([180, 0]), 'a')), { ...spec, coordinates: moon })).lonDeg).toBe(-180);
    expect(position(parse(collection(feature(point([360, 0]), 'a')))).lonDeg).toBe(0);
    const cart = geographicAbsolutePosition(position(layer), layer.datum)!;
    expect(Math.hypot(cart.xKm, cart.yKm, cart.zKm)).toBeCloseTo(1738.6, 9);
    expect(geographicAbsolutePosition({ latDeg: 0, lonDeg: 0 }, layer.datum)).toBeNull();
  });

  it('converts radial centric Z on the physical Mars ellipsoid, in km', () => {
    const coordinates: GeographicCoordinates = { ...mars, height: { unit: 'm', datum: 'ellipsoid', convention: 'radial' } };
    const layer = parse(collection(feature(point([0, 45, 1500]), 'site')), { ...spec, coordinates });
    const p = position(layer), cart = geographicAbsolutePosition(p, layer.datum)!;
    expect(p.latDeg).toBeGreaterThan(45);
    if (mars.referenceShape.kind !== 'ellipsoid') throw new Error('Expected Mars ellipsoid');
    const [a,, b] = mars.referenceShape.radiiKm;
    const radius = a * b / Math.hypot(b / Math.SQRT2, a / Math.SQRT2);
    expect(cart.xKm).toBeCloseTo((radius + 1.5) / Math.SQRT2, 8);
    expect(cart.zKm).toBeCloseTo(cart.xKm, 8);
  });

  it.each([
    undefined, {}, { ...mars, latitude: 'unknown' }, { ...mars, longitudeDirection: 'positive' },
    { ...mars, referenceShape: { kind: 'ellipsoid', radiiKm: [3, 2, 1] } },
    { ...mars, height: { unit: 'm', datum: 'areoid', convention: 'radial' } },
    { ...mars, height: { unit: 'm', datum: 'ellipsoid', convention: 'geodetic-normal' } },
  ])('rejects ambiguous or unsupported coordinate conventions: %j', coordinates => {
    expect(() => validateGeographicCoordinates(coordinates)).toThrow();
  });

  it.each([
    [], [1], [1, 91], [-1, 0], [361, 0], [1, 2, 3], [1, 2, 3, 4], ['1', 2], [null, 2],
  ].map(coords => ({ coords })))('diagnoses malformed/ambiguous positions without discarding good features: $coords', ({ coords }) => {
    const layer = parse(collection(feature(point(coords), 'bad'), feature(point(), 'good')));
    expect(layer.features.map(x => x.id)).toEqual(['string:good']);
    expect(layer.skippedFeatures).toBe(1);
    expect(layer.diagnostics[0]).toMatchObject({ code: 'skipped-feature', featureIndex: 0 });
  });

  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  it.each([
    [], [[]], [[[0, 0], [1, 0], [0, 0]]], [[[0, 0], [1, 0], [1, 1], [0, 1]]],
    [[[0, 0], [1, 1], [2, 2], [0, 0]]], [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]],
    [outer, [[11, 1], [12, 1], [12, 2], [11, 1]]],
    [outer, [[0, 1], [2, 1], [2, 2], [0, 1]]],
    [outer, [[1, 1], [5, 1], [5, 5], [1, 5], [1, 1]], [[2, 2], [3, 2], [3, 3], [2, 2]]],
  ].map(coordinates => ({ coordinates })))('rejects malformed rings, crossings, outside/touching/nested holes: $coordinates', ({ coordinates }) => {
    const layer = parse(collection(feature({ type: 'Polygon', coordinates }, 'bad')));
    expect(layer.features).toHaveLength(0);
    expect(layer.skippedFeatures).toBe(1);
    expect(layer.diagnostics).toHaveLength(1);
  });

  it('rejects collection/geometry CRS and non-FeatureCollection roots', () => {
    expect(() => parse(JSON.stringify(point()))).toThrow('FeatureCollection');
    expect(() => parse('{bad')).toThrow();
    expect(() => parse(JSON.stringify({ ...jezero, crs: { name: 'EPSG:4326' } }))).toThrow('crs');
    const layer = parse(collection(feature(null), feature({ ...point(), crs: {} }), feature({ type: 'GeometryCollection', geometries: [] })));
    expect(layer.skippedFeatures).toBe(3);
  });

  it('bounds bytes, nesting, features, vertices and topology work across bad features', () => {
    const text = JSON.stringify(jezero);
    for (const limits of [{ maxBytes: 40 }, { maxDepth: 3 }, { maxFeatures: 1 }, { maxVertices: 3 }, { maxTopologyChecks: 1 }]) {
      expect(() => parseGeographicGeoJson(text, spec, source, undefined, limits)).toThrow(/exceeds/);
    }
    expect(() => parseGeographicGeoJson(text, spec, source, undefined, { maxBytes: -1 })).toThrow('limit');
    const unicode = collection(feature(point(), '🌕'.repeat(50)));
    expect(() => parseGeographicGeoJson(unicode, spec, source, undefined, { maxBytes: unicode.length })).toThrow('bytes');
  });

  it('warns about unsafe property integers and rejects imprecise numeric IDs', () => {
    const layer = parse(collection(feature(point(), 'safe', { count: 2 ** 60 }), feature(point(), 2 ** 60)));
    expect(layer.diagnostics.map(x => x.code)).toEqual(['numeric-precision', 'skipped-feature']);
    expect(parse(collection(feature(point(), 1.25))).features[0].sourceId).toBe(1.25);
    expect(parse('{"type":"FeatureCollection","features":[{"type":"Feature","id":"bad","properties":{"count":1e999},"geometry":{"type":"Point","coordinates":[77,18]}}]}').skippedFeatures).toBe(1);
  });
});

describe('geographic asset loading and lifecycle', () => {
  const text = JSON.stringify(jezero);
  it('resolves required catalog sources against their own URLs, retaining provenance and default conventions', async () => {
    const graph = await loadCatalogFromUrl('https://data.test/missions/main.json', async url => url.endsWith('main.json')
      ? { require: ['../base/base.json'], geographicLayers: [{ ...spec, id: 'main' }] }
      : { geographicCoordinates: mars, geographicLayers: [{ ...spec, id: 'base', coordinates: undefined }] });
    const requested: string[] = [];
    const universe = new Universe();
    for (const { url, json } of graph.catalogs) {
      const loads = await loadGeographicLayers(json, { catalogUrl: url, readText: async path => { requested.push(path); return text; } });
      universe.loadCatalog(json, { source: url, geographicLayers: loads });
    }
    expect(requested).toEqual(['https://data.test/base/vectors/jezero.geojson', 'https://data.test/missions/vectors/jezero.geojson']);
    expect(universe.geographicLayers.layers).toHaveLength(2);
    expect(universe.geographicLayers.get('base')!.source.catalog).toBe(graph.catalogs[0].url);
    universe.dispose();
    expect(universe.geographicLayers.loads).toEqual([]);
  });

  it('isolates missing/CORS/bad sources from other layers and the body catalog', async () => {
    const catalog: CatalogJson = { name: 'Mars', items: [{ name: 'Mars' }], geographicLayers: [
      { ...spec, id: 'missing', source: 'missing' }, { ...spec, id: 'malformed', source: 'malformed' }, spec,
    ] };
    const loads = await loadGeographicLayers(catalog, { catalogUrl: 'https://data.test/scene.json', readText: async path => {
      if (path.endsWith('missing')) throw new TypeError('Failed to fetch (CORS)');
      return path.endsWith('malformed') ? '{}' : text;
    } });
    expect(loads.map(x => x.status)).toEqual(['error', 'error', 'ready']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const universe = new Universe();
    universe.loadCatalog(catalog, { source: 'scene', geographicLayers: loads });
    expect(universe.getBody('Mars')).toBeDefined();
    expect(universe.geographicLayers.loads[0].diagnostics[0].message).toContain('CORS');
    warn.mockRestore();
  });

  it('loads local files through resolveFile, removes replaced definitions, supports lookup and clears on disposal', () => {
    const universe = new Universe(undefined, { resolveFile: path => path === spec.source ? text : undefined });
    const changed = vi.fn();
    universe.events.on('geographic:changed', changed);
    universe.loadCatalog({ name: 'Local', geographicLayers: [spec] });
    expect(universe.geographicLayers.get(spec.id)!.ownership).toBe('transient');
    expect(changed).toHaveBeenCalledOnce();
    universe.loadCatalog({ name: 'Local', geographicLayers: [] });
    expect(universe.geographicLayers.loads).toEqual([]);
    universe.loadCatalog({ name: 'Other', geographicLayers: [spec] });
    universe.geographicLayers.removeCatalog('Other');
    expect(universe.geographicLayers.layers).toEqual([]);
    universe.dispose();
  });

  it('cancels during source load without installing partial state', async () => {
    const controller = new AbortController();
    await expect(loadGeographicLayers({ geographicLayers: [spec] }, { signal: controller.signal, readText: async () => {
      controller.abort(); return text;
    } })).rejects.toThrow();
  });

  it('composes anonymous catalogs and replaces the same catalog object without losing other owners', () => {
    const universe = new Universe(undefined, { resolveFile: () => text });
    const first: CatalogJson = { geographicLayers: [{ ...spec, id: 'first' }] };
    const second: CatalogJson = { geographicLayers: [{ ...spec, id: 'second' }] };
    universe.loadCatalog(first);
    universe.loadCatalog(second);
    expect(universe.geographicLayers.layers.map(x => x.id)).toEqual(['first', 'second']);
    first.geographicLayers = [];
    universe.loadCatalog(first);
    expect(universe.geographicLayers.layers.map(x => x.id)).toEqual(['second']);
    universe.dispose();
  });

  it('retains every invalid definition diagnostic even when definitions lack IDs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalog = { geographicLayers: [{ source: 'a' }, { source: 'b' }] } as unknown as CatalogJson;
    const loads = await loadGeographicLayers(catalog);
    const universe = new Universe();
    universe.loadCatalog(catalog, { geographicLayers: loads });
    expect(universe.geographicLayers.loads).toHaveLength(2);
    expect(universe.geographicLayers.loads.map(x => x.source.identity)).toEqual(['a', 'b']);
    warn.mockRestore();
  });

  it('validates definitions and layer counts before fetching and diagnoses duplicate IDs', async () => {
    const readText = vi.fn(async () => text);
    expect((await loadGeographicLayers({ geographicLayers: new Array(17).fill(spec) }, { readText }))[0].status).toBe('error');
    expect(readText).not.toHaveBeenCalled();
    const loads = await loadGeographicLayers({ geographicLayers: [spec, spec, { ...spec, id: 'bad', body: '' }] }, { readText });
    expect(loads.map(x => x.status)).toEqual(['ready', 'error', 'error']);
    expect(readText).toHaveBeenCalledOnce();
  });

  it('bounds streamed download bytes without trusting Content-Length and releases its reader', async () => {
    const cancel = vi.fn();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel,
    })));
    await expect(fetchGeographicText('https://data.test/large', 10, new AbortController().signal)).rejects.toThrow('bytes');
    expect(cancel).toHaveBeenCalledOnce();
    fetcher.mockResolvedValue(new Response('missing', { status: 404 }));
    await expect(fetchGeographicText('https://data.test/missing', 100, new AbortController().signal)).rejects.toThrow('404');
    fetcher.mockRestore();
  });
});
