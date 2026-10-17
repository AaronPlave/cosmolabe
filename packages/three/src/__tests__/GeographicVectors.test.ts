import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Universe, parseGeographicGeoJson, type GeographicLayer, type GeographicGeometry, type GeoPosition } from '@cosmolabe/core';
import { GeographicIndex, VECTOR_CELL_LIMIT } from '../geographic/GeographicIndex.js';
import { GeographicVectorLayer } from '../geographic/GeographicVectorLayer.js';
import jezero from '../../../core/src/__tests__/__fixtures__/geographic-jezero.json';
import southpole from '../../../core/src/__tests__/__fixtures__/geographic-southpole.json';
import type { BodyMesh } from '../BodyMesh.js';

function layer(geometry: GeographicGeometry<GeoPosition>[], body = 'Moon'): GeographicLayer {
  return parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: geometry.map((g, i) => ({ type: 'Feature', id: i, properties: {}, geometry: g })) }), {
    id: 'science', name: 'Science', body, source: 'science.geojson', coordinates: {
      latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
      referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, height: { unit: 'km', datum: 'reference-sphere', convention: 'geodetic-normal' },
    },
  }, { kind: 'local-file', identity: 'science.geojson' });
}
const pick = (index: GeographicIndex, lon: number, lat: number) => index.pick({ lonDeg: lon, latDeg: lat }, [0.0001, 0], [0, 0.0001]);
const ref = { bodyName: 'Moon', layerId: 'science', featureId: 'number:0' };

describe('geographic surface index', () => {
  it('keeps polar point markers independent of the pole longitude', () => {
    for (const sign of [-1, 1]) {
      const index = new GeographicIndex([layer([{ type: 'Point', coordinates: [45, sign * 90] }])]);
      for (const longitude of [-179, -20, 90, 179]) {
        expect(pick(index, longitude, sign * 89.9998)).toEqual(ref);
      }
    }
  });
  it('preserves a seam-crossing concave polygon, holes and ring boundary picking', () => {
    const data = layer([{ type: 'Polygon', coordinates: [
      [[177, -3], [-177, -3], [-177, 3], [179, 3], [179, 1], [177, 1], [177, -3]],
      [[179.3, -1], [-179.3, -1], [-179.3, 0], [179.3, 0], [179.3, -1]],
    ] }]);
    expect(data.skippedFeatures).toBe(0);
    const index = new GeographicIndex([data]);
    expect(index.diagnostics).toEqual([]);
    expect(pick(index, 179, -2)).toEqual(ref);
    expect(pick(index, -179, -2)).toEqual(ref);
    expect(pick(index, 180, -0.5)).toBeNull();
    expect(pick(index, 179.3, -0.5)).toEqual(ref);
    expect(pick(index, 178, 2)).toBeNull();
    expect(pick(index, 0, 0)).toBeNull();
  });

  it('supports pole-enclosing rings and independent polar holes without a longitude seam', () => {
    const ring = (latitude: number): GeoPosition[] => [[-135, latitude], [-45, latitude], [45, latitude], [135, latitude], [-135, latitude]];
    for (const sign of [-1, 1]) {
      const data = layer([{ type: 'Polygon', coordinates: [ring(sign * 85), ring(sign * 89)] }]);
      expect(data.skippedFeatures).toBe(0);
      const index = new GeographicIndex([data]);
      expect(index.diagnostics).toEqual([]);
      expect(pick(index, 179, sign * 87)).toEqual(ref);
      expect(pick(index, -179, sign * 87)).toEqual(ref);
      expect(pick(index, 25, sign * 89.9)).toBeNull();
      expect(pick(index, 0, sign * 82)).toBeNull();
    }
  });

  it('handles wide regions without filling the antipodal side', () => {
    const index = new GeographicIndex([layer([{ type: 'Polygon', coordinates: [
      [[-120, -30], [0, -30], [120, -30], [120, 30], [0, 30], [-120, 30], [-120, -30]],
      [[99, 10], [101, 10], [101, 12], [99, 12], [99, 10]],
    ] }])]);
    expect(index.diagnostics).toEqual([]);
    expect(pick(index, 100, 0)).toEqual(ref);
    expect(pick(index, -100, 0)).toEqual(ref);
    expect(pick(index, 170, 0)).toBeNull();
    expect(pick(index, 100, 11)).toBeNull();
    expect(pick(index, -115, 20)).toEqual(ref);
  });

  it('imports the Jezero and lunar fixtures including every Multi geometry', () => {
    for (const fixture of [jezero, southpole]) {
      const definition = layer([]).definition;
      const data = parseGeographicGeoJson(JSON.stringify(fixture), definition, { kind: 'local-file', identity: 'fixture' });
      const index = new GeographicIndex([data]);
      expect(data.skippedFeatures).toBe(0);
      expect(index.features).toHaveLength(fixture.features.length);
      expect(index.diagnostics).toEqual([]);
      const packed = index.pack();
      expect(packed.records.every(Number.isFinite)).toBe(true);
      expect(packed.cells.every(Number.isFinite)).toBe(true);
    }
  });

  it('returns deterministic point/line/fill precedence and keeps line tolerance in pixels', () => {
    const index = new GeographicIndex([layer([
      { type: 'Point', coordinates: [0, 0] },
      { type: 'LineString', coordinates: [[-1, 0], [1, 0]] },
      { type: 'Polygon', coordinates: [[[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]]] },
    ])]);
    expect(pick(index, 0, 0)).toEqual(ref);
    expect(pick(index, 0.5, 0.0003)?.featureId).toBe('number:1');
    expect(pick(index, 0.5, 0.0006)?.featureId).toBe('number:2');
  });

  it('bounds dense inputs atomically and allocates nothing for hidden layers', () => {
    const data = layer(Array.from({ length: 5000 }, () => ({ type: 'Point', coordinates: [0, 0] })));
    const index = new GeographicIndex([data]);
    expect(index.features).toHaveLength(VECTOR_CELL_LIMIT);
    expect(index.diagnostics).toHaveLength(5000 - VECTOR_CELL_LIMIT);
    expect(Math.max(...index.cells.map(c => c.length))).toBe(VECTOR_CELL_LIMIT);
    data.definition.display = { visible: false };
    const hidden = new GeographicIndex([data]);
    expect(hidden.primitives).toHaveLength(0);
    expect(hidden.pack().records.byteLength).toBe(0);
  });
});

function harness(data: GeographicLayer) {
  const universe = new Universe();
  universe.geographicLayers.replaceCatalog('test', [{ id: data.id, status: 'ready', layer: data, source: data.source, diagnostics: [] }]);
  const vectors = new GeographicVectorLayer(universe, 1);
  const geometry = new THREE.SphereGeometry(1737.4, 16, 8).rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld(true);
  const body = { visible: true, body: { name: 'Moon', geometryType: 'Globe', radii: [1737.4, 1737.4, 1737.4] }, mesh,
    position: new THREE.Vector3(), terrainTileGroup: null, terrainDatum: null, getSurfaceOverlays: () => [],
    bodyToWorldQuaternion: (q: THREE.Quaternion) => q.identity(), surfaceTransitionState: 'static', isImageryOnlySurface: false } as unknown as BodyMesh;
  const renderer = { getPixelRatio: () => 1, render: () => {} } as unknown as THREE.WebGLRenderer;
  return { universe, vectors, mesh, body, renderer, camera: new THREE.PerspectiveCamera(45, 1, 1, 10000) };
}

describe('geographic renderer lifecycle and placement', () => {
  it('shares terrain geometry, prunes LOD/reload proxies and preserves source resources', () => {
    const h = harness(layer([{ type: 'Point', coordinates: [0, 0] }]));
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.vectors.status[0]).toMatchObject({ surface: 'reference-ellipsoid', features: 1 });
    const old = h.mesh.geometry;
    h.mesh.geometry = old.clone();
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.mesh.geometry).not.toBe(old);
    h.vectors.setVisible('science', false); h.vectors.begin();
    expect(h.vectors.featureCount).toBe(0);
    expect(old.getAttribute('position').count).toBeGreaterThan(0);
    h.vectors.dispose(); h.universe.dispose();
  });

  it('keeps explicit heights in km and rejects mixed/variable heights with diagnostics', () => {
    const h = harness(layer([{ type: 'Point', coordinates: [0, 0, 2] }, { type: 'LineString', coordinates: [[0, 0, 1], [1, 0, 2]] }]));
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.vectors.status[0].surface).toBe('body-fixed-height');
    expect(h.vectors.featureCount).toBe(1);
    expect(h.vectors.diagnostics[0].code).toBe('unsupported-height');
    h.vectors.setPlacement('science', { mode: 'terrain-relative', offsetKm: 0.002 });
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.vectors.featureCount).toBe(2);
    expect(h.vectors.diagnostics).toEqual([]);
    h.vectors.dispose(); h.universe.dispose();
  });

  it('does not project onto DSKs or mismatched datums', () => {
    const h = harness(layer([{ type: 'Point', coordinates: [0, 0] }]));
    Object.defineProperty(h.body.body, 'geometryType', { value: 'Mesh' });
    h.vectors.begin(); h.vectors.render(h.renderer, h.camera, [h.body]); h.vectors.end();
    expect(h.vectors.diagnostics[0].code).toBe('unsupported-surface');
    h.vectors.dispose(); h.universe.dispose();
  });
});
