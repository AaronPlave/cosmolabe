import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PlaceIndex, PLACE_LIMIT, placeLabelStyle, parseGeographicGeoJson, type GeographicLayerDefinition, type GeographicLayer } from '../geographic/index.js';

const spec: GeographicLayerDefinition = { id: 'sites', name: 'User sites', body: 'Moon', source: 'sites.geojson',
  coordinates: { latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 1737.4 } },
  provenance: { attribution: 'Test mission' } };
function layer(points: Array<{ name: string; lon?: number; lat?: number; aliases?: string[]; placeRef?: string; featureClass?: string }>, definition = spec): GeographicLayer {
  return parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: points.map((p, i) => ({ type: 'Feature', id: i,
    properties: p, geometry: { type: 'Point', coordinates: [p.lon ?? 179.9, p.lat ?? -89.9] } })) }), definition, { kind: 'local-file', identity: definition.source });
}

describe('shared place index', () => {
  it('indexes hidden imported points, aliases and accents; filters body/type and prioritizes active body', () => {
    const moon = layer([{ name: 'Jézero test', aliases: ['Alpha landing'], featureClass: 'Mission site' }], { ...spec, display: { visible: false } });
    const mars = layer([{ name: 'Jezero' }], { ...spec, id: 'mars-sites', body: 'Mars' });
    const index = new PlaceIndex([moon, mars]);
    expect(index.search('jez', { activeBody: 'Mars' }).map(p => p.layer.body)).toEqual(['Mars', 'Moon']);
    expect(index.search('alpha la')[0].feature).toBe(moon.features[0]);
    expect(index.search('jezero', { body: 'Moon', kind: 'Mission site' })).toHaveLength(1);
    expect(index.search('alpha', { body: 'Mars' })).toEqual([]);
    expect(index.search('no such place')).toEqual([]);
    expect(index.places[0].layer.definition.provenance).toEqual({ attribution: 'Test mission' });
  });

  it('retains logical references across chunk moves and diagnoses duplicates', () => {
    const first = layer([{ name: 'Stable', placeRef: 'moon:usgs/123' }]);
    const moved = layer([{ name: 'Stable', placeRef: 'moon:usgs/123' }], { ...spec, id: 'another-chunk' });
    expect(new PlaceIndex([first]).places[0].ref).toBe(new PlaceIndex([moved]).places[0].ref);
    const index = new PlaceIndex([first, moved]);
    expect(index.places).toHaveLength(1);
    expect(index.diagnostics[0]).toContain('Duplicate place reference');
    expect(new PlaceIndex(Array.from({ length: 100 }, () => first)).diagnostics).toHaveLength(32);
  });

  it('finds spatial candidates across the seam and includes every longitude at the pole', () => {
    const index = new PlaceIndex([layer([{ name: 'West', lon: -179.9, lat: 0 }, { name: 'East', lon: 179.9, lat: 0 },
      { name: 'Pole A', lon: 40 }, { name: 'Pole B', lon: -100 }, { name: 'North pole', lon: 80, lat: 90 }])]);
    expect(index.nearby('Moon', 180, 0, 1).map(p => p.name).sort()).toEqual(['East', 'West']);
    expect(index.nearby('Moon', 180, -90, 0.2).map(p => p.name).sort()).toEqual(['Pole A', 'Pole B']);
    expect(index.nearby('Moon', -180, 90, 0).map(p => p.name)).toEqual(['North pole']);
    expect(index.nearby('Mars', 180, -90, 90)).toEqual([]);
  });

  it('bounds storage and result counts with a visible diagnostic', () => {
    const base = layer([{ name: 'Site' }]);
    base.features = Array.from({ length: PLACE_LIMIT + 1 }, (_, i) => ({ ...base.features[0], id: `${i}` }));
    const index = new PlaceIndex([base]);
    expect(index.places).toHaveLength(PLACE_LIMIT);
    expect(index.search('site', { limit: 1000 })).toHaveLength(100);
    expect(index.diagnostics[0]).toContain('limit');
  });

  it('uses cartographic class and catalog overrides separately from physical extent', () => {
    const mons=placeLabelStyle('Mons, montes',600,'nomenclature',{});
    const crater=placeLabelStyle('Crater, craters',600,'nomenclature',{});
    expect(mons.class).toBe('major');expect(crater.class).toBe('regional');
    expect(mons.importance).toBeGreaterThan(crater.importance);
    expect(placeLabelStyle('Site',undefined,'mission/user',{labelImportance:99,labelClass:'major',labelMinPixels:30})).toEqual({importance:99,class:'major',minPixels:30});
    const crowded=layer(Array.from({length:600},(_,i)=>({name:`Small ${i}`,lon:0,lat:0})));
    const major=layer([{name:'Major',lon:80,lat:0}],{...spec,id:'major'});
    major.features[0].properties={name:'Major',featureClass:'Mons, montes',diameterKm:500,placeKind:'nomenclature'};
    expect(new PlaceIndex([crowded,major]).nearby('Moon',0,0,90,1)[0].name).toBe('Major');
  });

  it('loads the shipped full USGS snapshots with the normal parser, coordinate transforms and provenance', () => {
    const root = new URL('../../../../apps/viewer/test-catalogs/places/', import.meta.url);
    const layers: GeographicLayer[] = [];
    for (const body of ['mars', 'moon']) {
      const catalog = JSON.parse(readFileSync(new URL(`${body}.json`, root), 'utf8'));
      for (const d of catalog.geographicLayers) layers.push(parseGeographicGeoJson(readFileSync(new URL(d.source, root), 'utf8'),
        { ...d, coordinates: catalog.geographicCoordinates }, { kind: 'catalog', identity: d.source }));
    }
    const index = new PlaceIndex(layers);
    expect(index.places).toHaveLength(11138);
    expect(layers.every(l => l.skippedFeatures === 0 && l.diagnostics.length === 0)).toBe(true);
    const jezero = index.search('Jezero')[0];
    expect(jezero.ref).toBe('mars:usgs:places/gazetteer:14300');
    expect(jezero.origin).toBe('nomenclature');
    if (jezero.feature.geometry.type !== 'Point') throw new Error('Expected point');
    expect(jezero.feature.geometry.coordinates.lonDeg).toBeCloseTo(77.6873, 5);
    expect(jezero.feature.geometry.coordinates.latDeg).toBeGreaterThan(18.4082);
    expect(index.search('Shackleton')[0].ref).toBe('moon:usgs:places/gazetteer:5450');
  });
});
