import { describe, it, expect } from 'vitest';
import jezero from './__fixtures__/geographic-jezero.json';
import southpole from './__fixtures__/geographic-southpole.json';
import {
  parseGeographicGeoJson, normalizeGeographicPosition, geographicFeatureName, geographicPropertyLabel,
  geographicFeatureFields, geographicSearchIndex, geographicQueryMatches, geographicQueryEmpty,
  geographicFeatureExtent, geographicFeatureAnchor, geographicPositionInConvention, formatGeographicPosition,
  describeGeographicCoordinates, geographicVertexCount,
  type GeographicCoordinates, type GeographicLayerDefinition, type GeographicLayer, type GeographicFeature,
} from '../geographic/index.js';

const mars: GeographicCoordinates = {
  latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
  height: { unit: 'm', datum: 'ellipsoid', convention: 'radial' },
};
const moon: GeographicCoordinates = {
  latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
  referenceShape: { kind: 'sphere', radiusKm: 1737.4 },
};
const source = { kind: 'catalog' as const, identity: 'https://data.test/v.geojson' };
const layerOf = (text: string, coordinates: GeographicCoordinates, body = 'Mars'): GeographicLayer =>
  parseGeographicGeoJson(text, { id: `${body}:test`, name: 'Test', body, source: 'v.geojson', coordinates } as GeographicLayerDefinition, source);
const collection = (...features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
const feature = (geometry: unknown, id?: string | number, properties: unknown = {}) => ({ type: 'Feature', id, properties, geometry });

describe('geographic feature naming and fields', () => {
  it('names features from conventional properties, then their source ID, then source order', () => {
    const layer = layerOf(collection(
      feature({ type: 'Point', coordinates: [10, 1] }, 'a', { Name: '  Séítah  ' }),
      feature({ type: 'Point', coordinates: [10, 2] }, 7, { title: '' }),
      feature({ type: 'Point', coordinates: [10, 3] }, undefined, null),
    ), mars);
    expect(layer.features.map(geographicFeatureName)).toEqual(['Séítah', '7', 'Feature 3']);
  });

  it('labels property keys for people', () => {
    expect(geographicPropertyLabel('site_id')).toBe('Site ID');
    expect(geographicPropertyLabel('targetName')).toBe('Target name');
    expect(geographicPropertyLabel('usgs-url')).toBe('USGS URL');
  });

  it('inventories typed fields with categories and numeric ranges, ignoring nested values', () => {
    const layer = layerOf(collection(
      feature({ type: 'Point', coordinates: [10, 1] }, 'a', { kind: 'rock', sol: 12, active: true, nested: { x: 1 } }),
      feature({ type: 'Point', coordinates: [10, 2] }, 'b', { kind: 'soil', sol: 40, active: false }),
      feature({ type: 'Point', coordinates: [10, 3] }, 'c', { kind: 'rock', sol: 'unknown' }),
    ), mars);
    const fields = Object.fromEntries(geographicFeatureFields(layer).map(f => [f.key, f]));
    expect(fields.kind).toMatchObject({ type: 'string', count: 3, categories: ['rock', 'soil'] });
    expect(fields.sol).toMatchObject({ type: 'mixed', count: 3 });
    expect(fields.active).toMatchObject({ type: 'boolean', count: 2 });
    expect(fields.nested).toBeUndefined();
    const numeric = layerOf(collection(feature({ type: 'Point', coordinates: [1, 1] }, 'a', { sol: 3 }), feature({ type: 'Point', coordinates: [1, 2] }, 'b', { sol: -2 })), mars);
    expect(geographicFeatureFields(numeric)[0]).toMatchObject({ type: 'number', min: -2, max: 3 });
  });

  it('caps the field inventory and drops categories past the category limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => feature({ type: 'Point', coordinates: [1, i] }, `f${i}`, { label: `v${i}`, [`k${i}`]: i }));
    const fields = geographicFeatureFields(layerOf(collection(...many), mars), 8);
    expect(fields).toHaveLength(8);
    expect(fields.find(f => f.key === 'label')!.categories).toBeUndefined();
  });
});

describe('geographic search and filters', () => {
  const layer = layerOf(collection(
    feature({ type: 'Point', coordinates: [77.4, 18.4] }, 'a', { name: 'Séítah ridge', kind: 'rock', sol: 120, tags: ['delta'] }),
    feature({ type: 'Point', coordinates: [77.5, 18.5] }, 'b', { name: 'Octavia E. Butler landing', kind: 'site', sol: 0 }),
    feature({ type: 'Point', coordinates: [77.6, 18.6] }, 'c', { name: 'Three Forks', kind: 'rock', sol: 420, cached: true }),
  ), mars);
  const index = geographicSearchIndex(layer);
  const names = (query: Parameters<typeof geographicQueryMatches>[1]) => index.filter(e => geographicQueryMatches(e, query)).map(e => e.name);

  it('searches names and nested property values case-insensitively; every term must match', () => {
    expect(names({ text: 'BUTLER' })).toEqual(['Octavia E. Butler landing']);
    expect(names({ text: 'delta' })).toEqual(['Séítah ridge']);
    expect(names({ text: 'rock forks' })).toEqual(['Three Forks']);
    expect(names({ text: 'string:b' })).toEqual(['Octavia E. Butler landing']);
  });

  it('filters by category, numeric range, text and boolean', () => {
    expect(names({ field: { key: 'kind', kind: 'category', values: ['rock'] } })).toEqual(['Séítah ridge', 'Three Forks']);
    expect(names({ field: { key: 'sol', kind: 'range', min: 100, max: 200 } })).toEqual(['Séítah ridge']);
    expect(names({ field: { key: 'sol', kind: 'range', max: 0 } })).toEqual(['Octavia E. Butler landing']);
    expect(names({ field: { key: 'name', kind: 'text', contains: 'FORK' } })).toEqual(['Three Forks']);
    expect(names({ field: { key: 'cached', kind: 'boolean', value: true } })).toEqual(['Three Forks']);
    expect(names({ text: 'ridge', field: { key: 'kind', kind: 'category', values: ['site'] } })).toEqual([]);
  });

  it('reuses one index per immutable layer and reports empty queries', () => {
    expect(geographicSearchIndex(layer)).toBe(index);
    expect(geographicQueryEmpty({ text: '  ' })).toBe(true);
    expect(geographicQueryEmpty({ text: 'a' })).toBe(false);
  });
});

describe('geographic extents and anchors', () => {
  const extentOf = (geometry: unknown, coordinates = moon) =>
    geographicFeatureExtent(layerOf(collection(feature(geometry, 'f')), coordinates, 'Moon').features[0]);

  it('boxes ordinary features and anchors points at their own position', () => {
    const layer = layerOf(JSON.stringify(jezero), mars);
    const traverse = layer.features.find(f => f.id === 'string:traverse')!;
    const extent = geographicFeatureExtent(traverse);
    expect(extent.kind).toBe('box');
    if (extent.kind !== 'box') return;
    const norm = (lon: number, lat: number) => normalizeGeographicPosition([lon, lat], mars);
    expect(extent.west).toBeCloseTo(norm(77.4, 18.4).lonDeg, 10);
    expect(extent.east).toBeCloseTo(norm(77.5, 18.5).lonDeg, 10);
    expect(extent.south).toBeCloseTo(norm(77.4, 18.4).latDeg, 10);
    expect(extent.north).toBeCloseTo(norm(77.5, 18.5).latDeg, 10);
    const point = layer.features[0] as GeographicFeature & { geometry: { type: 'Point' } };
    expect(geographicFeatureAnchor(point)).toBe(point.geometry.coordinates);
  });

  it('crosses the ±180° seam along the short way rather than spanning the globe', () => {
    const extent = extentOf({ type: 'LineString', coordinates: [[170, 0], [-170, 10]] });
    expect(extent).toEqual({ kind: 'box', west: 170, south: 0, east: -170, north: 10 });
    expect(geographicFeatureAnchor(layerOf(collection(feature({ type: 'LineString', coordinates: [[170, 0], [-170, 10]] }, 'f')), moon, 'Moon').features[0]))
      .toEqual({ latDeg: 5, lonDeg: -180 });
  });

  it('keeps an edge inside the box even when its vertices alone would suggest the other side', () => {
    // Vertices at 0, 170 and -170: the 0→170 edge is drawn eastward, so the box
    // must cover it instead of the 20° gap's complement through 180.
    const extent = extentOf({ type: 'LineString', coordinates: [[0, 0], [170, 0], [-170, 0]] });
    expect(extent).toEqual({ kind: 'box', west: 0, south: 0, east: -170, north: 0 });
  });

  it('boxes the lunar seam fixture across ±180° and describes a pole-enclosing ring by its pole', () => {
    const layer = parseGeographicGeoJson(JSON.stringify(southpole), {
      id: 'moon:south', name: 'South', body: 'Moon', source: 'south.geojson', coordinates: moon,
    }, source);
    expect(geographicFeatureExtent(layer.features[1])).toEqual({ kind: 'box', west: 179, south: -89, east: -179, north: -87 });
    const cap = { type: 'Polygon', coordinates: [[[0, -80], [90, -81], [180, -80], [-90, -82], [0, -80]]] };
    expect(extentOf(cap)).toEqual({ kind: 'polar', pole: 'south', boundaryLatDeg: -80 });
    expect(geographicFeatureAnchor(layerOf(collection(feature(cap, 'f')), moon, 'Moon').features[0])).toEqual({ latDeg: -90, lonDeg: 0 });
  });

  it('counts vertices across parts and rings', () => {
    const layer = layerOf(JSON.stringify(jezero), mars);
    expect(geographicVertexCount(layer.features[0])).toBe(1);
    expect(geographicVertexCount(layer.features.find(f => f.geometry.type === 'Polygon')!)).toBeGreaterThan(4);
  });
});

describe('coordinates in the declared convention', () => {
  it('round-trips positions through the declared convention exactly enough to copy', () => {
    const conventions: GeographicCoordinates[] = [
      mars,
      { ...mars, latitude: 'planetographic', height: { unit: 'km', datum: 'ellipsoid', convention: 'geodetic-normal' } },
      { ...mars, longitudeDirection: 'west', longitudeDomain: '-180..180' },
      moon,
    ];
    for (const c of conventions) {
      for (const raw of [[77.45, 18.45, 1200], [359.5, -89.2, -3000], [0, 0, 0]] as const) {
        const input = c.longitudeDomain === '0..360' ? raw : [raw[0] > 180 ? raw[0] - 360 : raw[0], raw[1], raw[2]] as const;
        const declared = c.height ? input : [input[0], input[1]] as [number, number];
        const position = normalizeGeographicPosition([...declared] as [number, number] | [number, number, number], c);
        const back = geographicPositionInConvention(position, c);
        const lon = (x: number) => ((x % 360) + 360) % 360;
        expect(lon(back[0])).toBeCloseTo(lon(declared[0]), 9);
        expect(back[1]).toBeCloseTo(declared[1], 9);
        if (c.height) expect(back[2]).toBeCloseTo(declared[2]!, 6);
        else expect(back).toHaveLength(2);
      }
    }
  });

  it('formats hemispheres and names the convention', () => {
    const position = normalizeGeographicPosition([282.5, -4.5], mars);
    expect(formatGeographicPosition(position, mars, 2)).toBe('4.50°S, 282.50°E');
    const west: GeographicCoordinates = { ...moon, longitudeDirection: 'west' };
    expect(formatGeographicPosition({ latDeg: 1, lonDeg: -20 }, west, 1)).toBe('1.0°N, 20.0°W');
    expect(formatGeographicPosition({ latDeg: 1, lonDeg: 20 }, west, 1)).toBe('1.0°N, 20.0°E');
    expect(describeGeographicCoordinates(mars)).toBe('Planetocentric latitude · east longitude 0–360° · ellipsoid 3396.19 × 3376.2 km · heights in m above the ellipsoid');
    expect(describeGeographicCoordinates(moon)).toBe('Planetographic latitude · east longitude -180–180° · sphere r=1737.4 km');
  });
});
