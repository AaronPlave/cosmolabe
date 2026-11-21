import assert from 'node:assert/strict';
import { describe, it, expect } from 'vitest';
import { parseGeographicGeoJson } from '@cosmolabe/core';
import { GeographicIndex, geographicCell } from '../geographic/GeographicIndex.js';
import countries from '../../../../apps/viewer/test-catalogs/geographic/natural-earth-countries.json';

const earthDefinition = {
  id: 'countries', name: 'Natural Earth countries', body: 'Earth', source: 'natural-earth-countries.json',
  coordinates: { latitude: 'planetographic' as const, longitudeDirection: 'east' as const, longitudeDomain: '-180..180' as const,
    referenceShape: { kind: 'ellipsoid' as const, radiiKm: [6378.137, 6378.137, 6356.752314245] as [number, number, number] } },
};
describe('Natural Earth global countries', () => {
  it('admits all 177 countries without simplifying coastlines', () => {
    const layer = parseGeographicGeoJson(JSON.stringify(countries), earthDefinition, { kind: 'local-file', identity: 'Natural Earth 5.1.1' });
    const index = new GeographicIndex([layer]);
    expect(layer.diagnostics).toEqual([]);
    expect(index.diagnostics).toEqual([]);
    expect(index.features).toHaveLength(177);
    expect(layer.features.map(f => f.id)).toEqual(countries.features.map(f => `string:${f.id}`));
    const polygons = layer.features.flatMap(f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
    expect(polygons).toHaveLength(288);
    expect(polygons.reduce((n, p) => n + p.length - 1, 0)).toBe(1);
    expect(polygons.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0)).toBe(10651);
    expect(index.renderPages).toBeLessThanOrEqual(16);
    const packed = index.pack();
    expect(packed.references.length / 4).toBeLessThanOrEqual(1_000_000);
    // A fine level for close views, clear of Antarctica's polar chart, then the whole-globe one.
    expect(packed.detail?.levels.map(l => l.size)).toEqual([1024, 256]);
    // Its band stops short of Antarctica (~63° S) but still reaches Cape Horn (56° S).
    expect(packed.detail?.levels[0].bounds[1]).toBeGreaterThan(-66);
    expect(packed.detail?.levels[0].bounds[1]).toBeLessThan(-56);
    expect(packed.detail?.levels[1]).toMatchObject({size: 256, height: 128});
    for (let i = 1; i < packed.cells.length; i += 4) expect(packed.cells[i]).toBeLessThanOrEqual(256);
    const cases: [number, number, string | null][] = [
      [2, 47, 'France'], [-53, 4, 'France'], [10, 51, 'Germany'], [24, -29, 'South Africa'], [28.5, -29.5, 'Lesotho'],
      [178, -17.8, 'Fiji'], [-179.9, -16.3, 'Fiji'], [179, 66, 'Russia'], [-179, 68, 'Russia'],
      [-42, 72, 'Greenland'], [135, -25, 'Australia'], [138, 36, 'Japan'], [0, -89, 'Antarctica'],
      [160, 0, null], [0, 0, null],
    ];
    for (const [lon, lat, name] of cases) {
      const hit = index.pick({lonDeg: lon, latDeg: lat}, [0.00001, 0], [0, 0.00001]);
      const actual = hit ? layer.features.find(f => f.id === hit.featureId)?.properties?.NAME : null;
      expect(actual, `${lon},${lat}`).toBe(name);
    }
  });
  it('reuses admitted marks and stable IDs in bounded sparse highlights', () => {
    const layer = parseGeographicGeoJson(JSON.stringify(countries), earthDefinition, {kind:'local-file',identity:'Natural Earth 5.1.1'});
    const index = new GeographicIndex([layer]);
    for (const name of ['France','Germany','Chad','Antarctica']) {
      const id = layer.features.findIndex(f => f.properties?.NAME === name) + 1;
      const highlight = index.highlight(id), packed = highlight.pack();
      expect(highlight.primitives.length).toBeGreaterThan(0);
      expect(highlight.primitives.every(p => p.feature === id && p.kind !== 2 && index.primitives.includes(p))).toBe(true);
      expect(highlight.features).toEqual(index.features);
      expect(highlight.renderPages).toBeLessThanOrEqual(index.renderPages);
      expect(packed.references.length / 4).toBeLessThanOrEqual(1_000_000);
      expect(packed.detail?.levels.at(-1)).toMatchObject({size:256,height:128});
    }
  });

  it('keeps every primitive in conservative coarse and fine cells, including polar triangles', () => {
    const layer = parseGeographicGeoJson(JSON.stringify(countries), earthDefinition, { kind: 'local-file', identity: 'Natural Earth 5.1.1' });
    const index = new GeographicIndex([layer]), packed = index.pack();
    for (const level of packed.detail!.levels) {
      const height = level.height!;
      // Per cell: the primitives referenced, and the features whose polygon covers it whole.
      const ids = new Map<number, Set<number>>(), covered = new Map<number, Set<number>>();
      for (let cell = 0; cell < level.size * height; cell++) for (let page = 0; page < level.pages; page++) {
        const offset = (level.offset + page * level.size * height + cell) * 4;
        assert.ok(packed.detail!.cells[offset + 1] <= 256);
        for (let j = 0; j < packed.detail!.cells[offset + 1]; j++) {
          const ref = (packed.detail!.cells[offset] + j) * 4;
          const id = packed.references[ref], p = index.primitives[id];
          if (packed.references[ref + 1] === 3) {
            assert.equal(p.kind, 2);
            (covered.get(cell) ?? covered.set(cell, new Set()).get(cell)!).add(p.feature);
            continue;
          }
          (ids.get(cell) ?? ids.set(cell, new Set()).get(cell)!).add(id);
          assert.equal(packed.references[ref + 2], p.chart === 'longitude-latitude' ? 0 : p.chart === 'north-polar' ? 1 : -1);
        }
      }
      for (const [id, primitive] of index.primitives.entries()) {
        const {a, b, c, chart} = primitive;
        // Vertices, edge midpoints and interior samples of the source triangles.
        for (const weights of [[1,0,0],[0,1,0],[0,0,1],[0.5,0.5,0],[0,0.5,0.5],[0.5,0,0.5],[0.2,0.3,0.5]]) {
          const x = weights[0]*a[0]+weights[1]*b[0]+weights[2]*c[0];
          const y = weights[0]*a[1]+weights[1]*b[1]+weights[2]*c[1];
          const lon = chart === 'longitude-latitude' ? ((x+180)%360+360)%360-180 : Math.atan2(y,x)*180/Math.PI;
          const lat = chart === 'longitude-latitude' ? y : (chart === 'north-polar' ? 1 : -1)*(90-Math.hypot(x,y));
          assert.ok(index.cells[geographicCell(lon,lat)].includes(id), `coarse primitive ${id}`);
          const cellX = ((Math.floor((lon+180)/level.step[0])%level.size)+level.size)%level.size;
          const row = Math.floor((lat - level.bounds[1])/level.step[1]);
          // A latitude band (the fine level) leaves the rest to the next level.
          if (level.bounds[1] > -90 && (row < 0 || row >= height)) continue;
          const cell = Math.max(0,Math.min(height-1,row))*level.size+cellX;
          assert.ok(ids.get(cell)?.has(id) || (primitive.kind === 2 && covered.get(cell)?.has(primitive.feature)), `${level.size} level primitive ${id}`);
        }
      }
    }
  });


  it('preserves shared France/Germany edges without a fill gap or overlap', () => {
    const layer = parseGeographicGeoJson(JSON.stringify(countries), earthDefinition, { kind: 'local-file', identity: 'Natural Earth 5.1.1' });
    const index = new GeographicIndex([layer]);
    type Point = {lonDeg: number; latDeg: number};
    const edges = (name: string): [Point, Point][] => {
      const geometry = layer.features.find(f => f.properties?.NAME === name)!.geometry;
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
      return polygons.flatMap(p => p.flatMap(r => r.slice(1).map((b, i): [Point, Point] => [r[i], b])));
    };
    const key = ([a,b]: [Point,Point]) => [`${a.lonDeg},${a.latDeg}`,`${b.lonDeg},${b.latDeg}`].sort().join('|');
    const germanEdges = new Set(edges('Germany').map(key));
    const shared = edges('France').filter(e => germanEdges.has(key(e)));
    expect(shared.length).toBeGreaterThan(0);
    for (const [a,b] of shared) {
      const dx=b.lonDeg-a.lonDeg,dy=b.latDeg-a.latDeg,length=Math.hypot(dx,dy);
      const names = [-1,1].map(sign => {
        const point = {lonDeg:(a.lonDeg+b.lonDeg)/2-sign*dy/length*1e-4,latDeg:(a.latDeg+b.latDeg)/2+sign*dx/length*1e-4};
        const hit=index.pick(point,[1e-8,0],[0,1e-8]);
        return layer.features.find(f=>f.id===hit?.featureId)?.properties?.NAME;
      });
      expect(new Set(names)).toEqual(new Set(['France','Germany']));
    }
  });

});
