import { afterEach, describe, expect, it, vi } from 'vitest';
import { Universe, parseGeographicGeoJson, type Place } from '@cosmolabe/core';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { PlaceNames } from '../geographic/PlaceNames.js';
import { placeAnchor } from '../geographic/PlaceSurface.js';
import type { BodyMesh } from '../BodyMesh.js';

function fixture() {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const elements: Array<{ style: Record<string, string>; dataset: Record<string, string> }> = [];
  vi.stubGlobal('document', { createElement: () => ({ style: {}, dataset: {}, getContext: () => ({ measureText: (s: string) => ({ width: s.length * 8 }) }), remove() {} }) });
  const universe = new Universe();
  const definition = { id: 'sites', body: 'Moon', name: 'Sites', source: 'sites.geojson', display: { visible: false },
    coordinates: { latitude: 'planetographic' as const, longitudeDirection: 'east' as const, longitudeDomain: '-180..180' as const, referenceShape: { kind: 'sphere' as const, radiusKm: 1 } } };
  const layer = parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'front', properties: { name: 'Front <script>', diameterKm: 1 }, geometry: { type: 'Point', coordinates: [-90, 0] } },
    { type: 'Feature', id: 'collision', properties: { name: 'Colliding' }, geometry: { type: 'Point', coordinates: [-90, 0] } },
    { type: 'Feature', id: 'back', properties: { name: 'Backside' }, geometry: { type: 'Point', coordinates: [90, 0] } },
  ] }), definition, { kind: 'local-file', identity: 'sites.geojson' });
  universe.geographicLayers.replaceCatalog('scene', [{ id: layer.id, source: layer.source, status: 'ready', layer, diagnostics: [] }]);
  const names = new PlaceNames(universe, { appendChild: (el: typeof elements[number]) => elements.push(el) } as unknown as HTMLElement);
  const body = { body: { name: 'Moon' }, visible: true, position: new Vector3(), displayRadius: 1, mesh: { quaternion: new Quaternion() },
    sampleTerrainBodyFixed: () => null, terrainBodyFixedToGeodetic: () => null } as unknown as BodyMesh;
  const camera = new PerspectiveCamera(60, 1, 0.01, 100);
  camera.position.set(0, 0, 4); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const meshes = new Map([['Moon', body]]);
  const update = (hidden = false, obstacles: Array<{ x0: number; y0: number; x1: number; y1: number }> = []) =>
    names.update(camera, meshes, 1, 800, 800, obstacles, () => hidden);
  return { names, body, elements, camera, update };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('optional geographic name annotations', () => {
  it('defaults off, rejects backside points and deterministically resolves colliding names', () => {
    const f = fixture(); f.update(); expect(f.names.metrics.drawn).toBe(0);
    f.names.setBodyVisible('Moon', true); f.update();
    expect(f.names.metrics.drawn).toBe(1);
    expect(f.names.pick(420, 400)?.featureId).toBe('string:front');
    expect(f.elements[0]).toMatchObject({ textContent: 'Front <script>', dataset: { anchor: 'reference-shape' } });
    f.update(); expect(f.names.pick(420, 400)?.featureId).toBe('string:front');
  });
  it('respects reserved annotation space, terrain LOS, camera motion and selected-place priority', () => {
    const f = fixture(); f.names.setBodyVisible('Moon', true);
    f.update(false, [{ x0: 400, y0: 380, x1: 700, y1: 430 }]); expect(f.names.metrics.drawn).toBe(0);
    f.update(true); expect(f.names.metrics.drawn).toBe(0);
    f.camera.position.z = 5; f.camera.updateMatrixWorld(true);
    f.update(false); expect(f.names.metrics.drawn).toBe(1);
    f.names.selectedRef = f.names.index.places[1].ref;
    f.update(false); expect(f.names.pick(420, 400)?.featureId).toBe('string:collision');
    f.camera.position.z = -5; f.camera.lookAt(0, 0, 0); f.camera.updateMatrixWorld(true);
    f.update(false); expect(f.names.pick(420, 400)?.featureId).toBe('string:back');
    f.names.setBodyVisible('Moon', false); f.names.selectedRef = null; f.update(); expect(f.names.metrics.drawn).toBe(0);
  });
  it('uses supported physical terrain heights and explicitly falls back for an areoid datum', () => {
    const f = fixture(); const place = f.names.index.places[0] as Place;
    const datum = place.layer.datum;
    Object.assign(f.body, { terrainBodyFixedToGeodetic: () => ({ latDeg: 0, lonDeg: -90 }),
      sampleTerrainBodyFixed: () => ({ elevationKm: 0.1, datum }) });
    const terrain = placeAnchor(place, f.body)!;
    expect(terrain.source).toBe('terrain-sample'); expect(terrain.offsetKm.length()).toBeCloseTo(1.1);
    Object.assign(f.body, { sampleTerrainBodyFixed: () => ({ elevationKm: 0.1, datum: { ...datum, verticalDatum: 'areoid' } }) });
    const fallback = placeAnchor(place, f.body)!;
    expect(fallback.source).toBe('reference-shape'); expect(fallback.offsetKm.length()).toBeCloseTo(1);
  });
});
