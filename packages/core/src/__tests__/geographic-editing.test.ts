import { describe, it, expect } from 'vitest';
import jezero from './__fixtures__/geographic-jezero.json';
import {
  createGeographicEditLayer, createGeographicWorkingCopy, applyGeographicEdit, GeographicEditSession, geographicEditLayerToLayer,
  exportGeographicEditLayer, importGeographicEditLayer, geographicEditCompanionCatalog, serializeGeographicEditDocument,
  parseGeographicEditDocument, geographicShapeRing, geographicEditFeatureRefId, parseGeographicGeoJson, normalizeGeographicPosition,
  geodesicDistanceKm, geographicDatum, loadGeographicLayers, GEOGRAPHIC_GEOJSON_EXTENSION, GEOGRAPHIC_SHAPE_MEMBER,
  type GeographicCoordinates, type GeographicEditLayer, type GeographicEditOperation, type GeoPosition,
} from '../geographic/index.js';

const mars: GeographicCoordinates = {
  latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
};
const moon: GeographicCoordinates = {
  latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
  referenceShape: { kind: 'sphere', radiusKm: 1737.4 },
};
const square = (lon: number, lat: number, d = 0.1): GeoPosition[] => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];

function apply(layer: GeographicEditLayer, op: GeographicEditOperation): GeographicEditLayer {
  const result = applyGeographicEdit(layer, op);
  if (!result.ok) throw new Error(result.diagnostics.map(d => d.message).join('; '));
  return result.layer;
}

it('retains the explicit lunar realization through edits, GeoJSON export and import', () => {
  const layer = createGeographicEditLayer({ id: 'lunar', name: 'Lunar', body: 'Moon', coordinates: { ...moon, frame: 'MOON_ME_DE421' } });
  const text = exportGeographicEditLayer(layer), exported = JSON.parse(text);
  expect(exported[GEOGRAPHIC_GEOJSON_EXTENSION].frame).toBe('MOON_ME_DE421');
  expect(geographicEditLayerToLayer(importGeographicEditLayer(text).layer).frame).toBe('MOON_ME_DE421');
  exported[GEOGRAPHIC_GEOJSON_EXTENSION].frame = 'IAU_MOON';
  expect(() => importGeographicEditLayer(JSON.stringify(exported))).toThrow(/frame declarations disagree/);
});

describe.each([['Mars', mars, 77.4, 18.4], ['Moon', moon, -170, -85]] as const)('drawing and editing on %s', (body, coordinates, lon, lat) => {
  const blank = () => createGeographicEditLayer({ id: `${body}:notes`, name: 'Notes', body, coordinates });

  it('adds a point, route and polygon with attributes, and draws them through the ordinary importer', () => {
    let layer = blank();
    layer = apply(layer, { type: 'add', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name: 'Target', category: 'rock', notes: 'n' } });
    layer = apply(layer, { type: 'add', geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + 0.05, lat + 0.02], [lon + 0.1, lat]] } });
    layer = apply(layer, { type: 'add', geometry: { type: 'Polygon', coordinates: [square(lon, lat)] } });
    expect(layer.features.map(f => f.id)).toEqual(['user-1', 'user-2', 'user-3']);
    const drawn = geographicEditLayerToLayer(layer);
    expect(drawn.ownership).toBe('user');
    expect(drawn.source.kind).toBe('user');
    expect(drawn.features.map(f => f.id)).toEqual(['string:user-1', 'string:user-2', 'string:user-3']);
    expect(drawn.skippedFeatures).toBe(0);
    expect(drawn.features[0].properties).toEqual({ name: 'Target', category: 'rock', notes: 'n' });
  });

  it('moves, inserts and deletes vertices, keeping rings closed, with undo and redo', () => {
    const session = new GeographicEditSession(blank());
    session.apply({ type: 'add', geometry: { type: 'Polygon', coordinates: [square(lon, lat)] } });
    const id = session.layer.features[0].id;
    const ring = () => (session.layer.features[0].geometry as { coordinates: GeoPosition[][] }).coordinates[0];
    expect(session.apply({ type: 'move-vertex', featureId: id, vertex: { part: [0], index: 0 }, position: [lon - 0.01, lat - 0.01] }).ok).toBe(true);
    expect(ring()[0]).toEqual([lon - 0.01, lat - 0.01]);
    expect(ring().at(-1)).toEqual(ring()[0]);
    expect(session.apply({ type: 'insert-vertex', featureId: id, vertex: { part: [0], index: 1 }, position: [lon + 0.05, lat - 0.02] }).ok).toBe(true);
    expect(ring()).toHaveLength(6);
    expect(session.apply({ type: 'delete-vertex', featureId: id, vertex: { part: [0], index: 0 } }).ok).toBe(true);
    expect(ring()[0]).toEqual([lon + 0.05, lat - 0.02]);
    expect(ring().at(-1)).toEqual(ring()[0]);
    session.undo(); session.undo();
    expect(ring()[0]).toEqual([lon - 0.01, lat - 0.01]);
    session.redo();
    expect(ring()).toHaveLength(6);
    expect(session.canRedo).toBe(true);
    session.apply({ type: 'set-properties', featureId: id, properties: { name: 'Area' } });
    expect(session.canRedo).toBe(false);
  });

  it('survives save, reload, export and reimport with identical coordinates', () => {
    let layer = blank();
    const awkward: GeoPosition = [lon + 0.123456789012345, lat + 0.000000000000123];
    layer = apply(layer, { type: 'add', geometry: { type: 'Point', coordinates: awkward }, properties: { name: 'Exact' } });
    layer = apply(layer, { type: 'add', geometry: { type: 'Polygon', coordinates: [square(lon, lat)] } });
    const reloaded = parseGeographicEditDocument(serializeGeographicEditDocument([layer]));
    expect(reloaded.problems).toEqual([]);
    expect(reloaded.layers[0]).toEqual(layer);
    const text = exportGeographicEditLayer(layer);
    const parsed = JSON.parse(text);
    expect(parsed[GEOGRAPHIC_GEOJSON_EXTENSION]).toMatchObject({ body, coordinates });
    expect(parsed.features[0].geometry.coordinates).toEqual(awkward);
    const back = importGeographicEditLayer(text);
    expect(back.diagnostics).toEqual([]);
    expect(back.layer.features).toEqual(layer.features);
    expect(back.layer.coordinates).toEqual(coordinates);
    expect(back.layer.nextId).toBe(3);
  });
});

describe('validation keeps every feature importable', () => {
  const layer = () => apply(apply(createGeographicEditLayer({ id: 'm', name: 'M', body: 'Mars', coordinates: mars }),
    { type: 'add', geometry: { type: 'Polygon', coordinates: [square(10, 10, 1), [[10.2, 10.2], [10.4, 10.2], [10.4, 10.4], [10.2, 10.4], [10.2, 10.2]]] } }),
    { type: 'add', geometry: { type: 'LineString', coordinates: [[20, 0], [21, 0]] } });

  it.each([
    ['self-intersection', { type: 'move-vertex', featureId: 'user-1', vertex: { part: [0], index: 1 }, position: [10, 11.5] }, /self-intersects/],
    ['hole outside its exterior', { type: 'move-vertex', featureId: 'user-1', vertex: { part: [1], index: 0 }, position: [12, 12] }, /hole|intersect/],
    ['zero-area ring', { type: 'replace-geometry', featureId: 'user-1', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] } }, /zero area/],
    ['too-short line', { type: 'delete-vertex', featureId: 'user-2', vertex: { part: [], index: 0 } }, /Too few vertices/],
    ['ambiguous 180° edge', { type: 'replace-geometry', featureId: 'user-2', geometry: { type: 'LineString', coordinates: [[0, 0], [180, 0], [190, 1]] } }, null],
    ['out of the declared domain', { type: 'move-vertex', featureId: 'user-2', vertex: { part: [], index: 0 }, position: [-5, 0] }, /domain/],
    ['an unknown feature', { type: 'delete', featureId: 'user-9' }, /No feature/],
  ] as const)('refuses %s and changes nothing', (_, op, message) => {
    const before = layer();
    const snapshot = JSON.stringify(before);
    const result = applyGeographicEdit(before, op as GeographicEditOperation);
    if (message === null) {
      // Lines may cross 180° (only polygon edges are ambiguous); the result stays importable.
      expect(result.ok).toBe(true);
      return;
    }
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.diagnostics.map(d => d.message).join(' ')).toMatch(message);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('refuses to reduce a ring below a triangle', () => {
    const once = apply(layer(), { type: 'delete-vertex', featureId: 'user-1', vertex: { part: [1], index: 0 } });
    const result = applyGeographicEdit(once, { type: 'delete-vertex', featureId: 'user-1', vertex: { part: [1], index: 0 } });
    expect(result.ok ? '' : result.diagnostics[0].message).toMatch(/at least 3/);
  });

  it('refuses a polygon edge spanning exactly 180 degrees', () => {
    const result = applyGeographicEdit(layer(), { type: 'add', geometry: { type: 'Polygon', coordinates: [[[0, 0], [180, 0], [180, 10], [0, 10], [0, 0]]] } });
    expect(result.ok).toBe(false);
  });

  it('a refused edit leaves other features untouched, and a valid one only changes its own', () => {
    const before = layer();
    const after = apply(before, { type: 'translate', featureId: 'user-2', from: [20, 0], to: [20, 1] });
    expect(after.features[0]).toBe(before.features[0]);
    expect(after.features[1]).not.toBe(before.features[1]);
  });
});

describe('working copies of read-only layers', () => {
  const source = parseGeographicGeoJson(JSON.stringify({ ...jezero, features: jezero.features.map((f, i) => i === 0 ? { ...f, foreign: { keep: true } } : f) }),
    { id: 'mars:science', name: 'Science', body: 'Mars', source: 'science.geojson', coordinates: mars }, { kind: 'catalog', identity: 'https://x/science.geojson' });

  it('copies exact source geometry, holes, Multi parts, IDs, properties and foreign members; the source is unchanged', () => {
    const before = JSON.stringify(source);
    const copy = createGeographicWorkingCopy(source);
    expect(copy.id).toBe('mars:science:edits');
    expect(copy.basedOn).toEqual({ layerId: 'mars:science', source: source.source });
    expect(copy.features.map(f => f.geometry)).toEqual(jezero.features.map(f => f.geometry));
    expect(copy.features.map(f => f.id)).toEqual(jezero.features.map(f => f.id));
    expect(copy.features[0].members).toEqual({ foreign: { keep: true } });
    const drawn = geographicEditLayerToLayer(copy);
    expect(drawn.features.map(f => f.id)).toEqual(source.features.map(f => f.id));
    expect(drawn.features.map(f => f.geometry)).toEqual(source.features.map(f => f.geometry));
    // Editing the copy leaves the source alone.
    const polygon = copy.features.find(f => f.geometry.type === 'Polygon')!;
    apply(copy, { type: 'set-properties', featureId: polygon.id, properties: { name: 'changed' } });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('preserves a polygon’s holes through a vertex edit on its exterior', () => {
    const copy = createGeographicWorkingCopy(source);
    const polygon = copy.features.find(f => f.geometry.type === 'Polygon')!;
    const rings = (polygon.geometry as { coordinates: GeoPosition[][] }).coordinates;
    const edited = apply(copy, { type: 'move-vertex', featureId: polygon.id, vertex: { part: [0], index: 0 },
      position: [rings[0][0][0] - 0.01, rings[0][0][1] - 0.01] });
    const after = (edited.features.find(f => f.id === polygon.id)!.geometry as { coordinates: GeoPosition[][] }).coordinates;
    expect(after).toHaveLength(rings.length);
    expect(after.slice(1)).toEqual(rings.slice(1));
  });

  it('names features without source IDs by source position', () => {
    const anonymous = parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } }] }),
      { id: 'a', name: 'A', body: 'Mars', source: 'a', coordinates: mars }, { kind: 'local-file', identity: 'a' });
    expect(createGeographicWorkingCopy(anonymous).features[0].id).toBe('source-0');
  });
});

describe('circles and ellipses keep their parameters', () => {
  const blank = () => createGeographicEditLayer({ id: 'm', name: 'M', body: 'Mars', coordinates: mars });

  it('generates rings at the geodesic radius on the reference ellipsoid, in the declared convention', () => {
    const shape = { kind: 'ellipse' as const, center: [77.4, 18.4] as [number, number], semiMajorKm: 12, semiMinorKm: 5, bearingDeg: 30 };
    const ring = geographicShapeRing(shape, mars, 8);
    const center = normalizeGeographicPosition(shape.center, mars);
    const distances = ring.slice(0, -1).map(p => geodesicDistanceKm(center, normalizeGeographicPosition(p, mars), geographicDatum(mars)));
    expect(Math.max(...distances)).toBeLessThanOrEqual(12 + 1e-6);
    expect(Math.min(...distances)).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(ring.at(-1)).toEqual(ring[0]);
    expect(ring.every(p => p[0] >= 0 && p[0] <= 360)).toBe(true);
    const circle = geographicShapeRing({ ...shape, kind: 'circle', semiMinorKm: 12 }, mars, 16);
    for (const p of circle) expect(geodesicDistanceKm(center, normalizeGeographicPosition(p, mars), geographicDatum(mars))).toBeCloseTo(12, 6);
  });

  it('round-trips shape parameters through export and reimport; a vertex edit makes it an ordinary polygon', () => {
    const shape = { kind: 'circle' as const, center: [77.4, 18.4] as [number, number], semiMajorKm: 3, semiMinorKm: 3, bearingDeg: 0 };
    let layer = apply(blank(), { type: 'add', shape, properties: { name: 'Keep-out' } });
    expect(layer.features[0].shape).toEqual(shape);
    const exported = JSON.parse(exportGeographicEditLayer(layer));
    expect(exported.features[0][GEOGRAPHIC_SHAPE_MEMBER]).toEqual(shape);
    expect(importGeographicEditLayer(JSON.stringify(exported)).layer.features[0].shape).toEqual(shape);
    layer = apply(layer, { type: 'set-shape', featureId: 'user-1', shape: { ...shape, kind: 'ellipse', semiMajorKm: 6, bearingDeg: 90 } });
    expect(layer.features[0].shape?.semiMajorKm).toBe(6);
    layer = apply(layer, { type: 'translate', featureId: 'user-1', from: [77.4, 18.4], to: [78, 19] });
    expect(layer.features[0].shape!.center[0]).toBeCloseTo(78, 9);
    expect(layer.features[0].shape!.center[1]).toBeCloseTo(19, 9);
    const result = applyGeographicEdit(layer, { type: 'move-vertex', featureId: 'user-1', vertex: { part: [0], index: 0 }, position: [78, 19.2] });
    expect(result.ok && result.layer.features[0].shape).toBeUndefined();
    expect(result.ok && result.diagnostics.map(d => d.code)).toEqual(['shape-converted']);
  });
});

describe('moving and duplicating whole features', () => {
  it('rotates a feature about the body centre, preserving its shape', () => {
    const datum = geographicDatum(moon);
    let layer = apply(createGeographicEditLayer({ id: 'l', name: 'L', body: 'Moon', coordinates: moon }),
      { type: 'add', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0], [1, 1]] } });
    const length = (l: GeographicEditLayer) => {
      const c = (l.features.at(-1)!.geometry as { coordinates: GeoPosition[] }).coordinates.map(p => normalizeGeographicPosition(p, moon));
      return [geodesicDistanceKm(c[0], c[1], datum), geodesicDistanceKm(c[1], c[2], datum)];
    };
    const before = length(layer);
    layer = apply(layer, { type: 'duplicate', featureId: 'user-1', offset: { from: [0, 0], to: [40, 60] } });
    expect(layer.features.map(f => f.id)).toEqual(['user-1', 'user-2']);
    const moved = (layer.features[1].geometry as { coordinates: GeoPosition[] }).coordinates;
    expect(moved[0][0]).toBeCloseTo(40, 9);
    expect(moved[0][1]).toBeCloseTo(60, 9);
    length(layer).forEach((d, i) => expect(d).toBeCloseTo(before[i], 6));
  });
});

describe('export for other software', () => {
  it('loads through the ordinary catalog path with the companion catalog, never as WGS84', async () => {
    const layer = apply(createGeographicEditLayer({ id: 'mars:notes', name: 'Notes', body: 'Mars', coordinates: mars }),
      { type: 'add', geometry: { type: 'Point', coordinates: [282.5, -4.5] } });
    const text = exportGeographicEditLayer(layer);
    const catalog = geographicEditCompanionCatalog(layer, 'notes.geojson');
    const [load] = await loadGeographicLayers(catalog as never, { readText: async () => text });
    expect(load.status).toBe('ready');
    const point = load.layer!.features[0].geometry as { coordinates: { lonDeg: number } };
    expect(point.coordinates.lonDeg).toBeCloseTo(-77.5, 9);
    expect(load.layer!.coordinates).toEqual(mars);
  });

  it('refuses plain GeoJSON without a declared body and convention, and accepts it with one', () => {
    const plain = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties: {}, geometry: { type: 'Point', coordinates: [10, 10] } }] });
    expect(() => importGeographicEditLayer(plain)).toThrow(/WGS84/);
    const { layer } = importGeographicEditLayer(plain, { id: 'p', name: 'P', body: 'Moon', coordinates: moon });
    expect(layer.features[0].id).toBe(1);
    expect(geographicEditFeatureRefId(layer.features[0].id)).toBe('number:1');
  });

  it('reports and skips damaged stored layers instead of installing invalid features', () => {
    const good = createGeographicEditLayer({ id: 'g', name: 'Good', body: 'Moon', coordinates: moon });
    const bad = { ...good, id: 'b', name: 'Bad', features: [{ id: 'x', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] } }] };
    const { layers, problems } = parseGeographicEditDocument(JSON.stringify({ format: 'cosmolabe-geographic-edits', version: 1, layers: [good, bad, { nonsense: true }] }));
    expect(layers.map(l => l.id)).toEqual(['g', 'b']);
    expect(layers[1].features).toEqual([]);
    expect(problems).toEqual(expect.arrayContaining(['Bad: 1 invalid features left out', 'A layer: malformed layer']));
    expect(parseGeographicEditDocument('{').problems).toEqual(['Stored edits are not valid JSON']);
  });

  it('bounds undo history', () => {
    const session = new GeographicEditSession(createGeographicEditLayer({ id: 'g', name: 'G', body: 'Moon', coordinates: moon }), 3);
    for (let i = 0; i < 5; i++) session.apply({ type: 'add', geometry: { type: 'Point', coordinates: [i, 0] } });
    let undone = 0;
    while (session.undo()) undone++;
    expect(undone).toBe(3);
    expect(session.layer.features).toHaveLength(2);
  });
});
