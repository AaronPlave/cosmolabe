import { afterEach, describe, expect, it, vi } from 'vitest';
import { Universe, parseGeographicGeoJson, type Place } from '@cosmolabe/core';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { PlaceNames } from '../geographic/PlaceNames.js';
import { placeAnchor, type PlaceAnchor } from '../geographic/PlaceSurface.js';
import type { BodyMesh } from '../BodyMesh.js';

function fixture(collisionLon = -90) {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const elements: Array<{ style: Record<string, string>; dataset: Record<string, string> }> = [];
  vi.stubGlobal('document', { createElement: () => ({ style: {}, dataset: {}, getContext: () => ({ measureText: (s: string) => ({ width: s.length * 8 }) }), remove() {} }) });
  const universe = new Universe();
  const definition = { id: 'sites', body: 'Moon', name: 'Sites', source: 'sites.geojson', display: { visible: false },
    coordinates: { latitude: 'planetographic' as const, longitudeDirection: 'east' as const, longitudeDomain: '-180..180' as const, referenceShape: { kind: 'sphere' as const, radiusKm: 1 } } };
  const layer = parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'front', properties: { name: 'Front <script>', diameterKm: 1, labelImportance: 90 }, geometry: { type: 'Point', coordinates: [-90, 0] } },
    { type: 'Feature', id: 'collision', properties: { name: 'Colliding', diameterKm: 1 }, geometry: { type: 'Point', coordinates: [collisionLon, 0] } },
    { type: 'Feature', id: 'back', properties: { name: 'Backside', diameterKm: 1 }, geometry: { type: 'Point', coordinates: [90, 0] } },
  ] }), definition, { kind: 'local-file', identity: 'sites.geojson' });
  universe.geographicLayers.replaceCatalog('scene', [{ id: layer.id, source: layer.source, status: 'ready', layer, diagnostics: [] }]);
  const names = new PlaceNames(universe, { appendChild: (el: typeof elements[number]) => elements.push(el) } as unknown as HTMLElement);
  const body = { body: { name: 'Moon' }, visible: true, position: new Vector3(), displayRadius: 1, mesh: { quaternion: new Quaternion() },
    sampleTerrainBodyFixed: () => null, terrainBodyFixedToGeodetic: () => null } as unknown as BodyMesh;
  const camera = new PerspectiveCamera(60, 1, 0.01, 100);
  camera.position.set(0, 0, 4); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const meshes = new Map([['Moon', body]]);
  const update = (hidden = false, obstacles: Array<{ x0: number; y0: number; x1: number; y1: number }> = [], renderedAnchor?: (place: Place, body: BodyMesh, anchor: PlaceAnchor) => PlaceAnchor | null) => {
    for(let i=0;i<4;i++) { now+=100; names.update(camera, meshes, 1, 800, 800, obstacles, () => hidden, renderedAnchor); }
  };
  return { names, body, elements, camera, update };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('optional geographic name annotations', () => {
  it('defaults off, rejects backside points and deterministically resolves colliding names', () => {
    const f = fixture(); f.update(); expect(f.names.metrics.drawn).toBe(0);
    f.names.setBodyVisible('Moon', true); f.update();
    expect(f.names.metrics.drawn).toBe(1);
    expect(f.names.pick(400, 400)?.featureId).toBe('string:front');
    expect(f.elements[0]).toMatchObject({ textContent: 'Front <script>', dataset: { anchor: 'reference-shape' } });
    f.update(); expect(f.names.pick(400, 400)?.featureId).toBe('string:front');
    f.body.mesh.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    f.update(); expect(f.names.pick(400, 400)?.featureId).toBe('string:back');
  });
  it('respects reserved annotation space, terrain LOS, camera motion and selected-place priority', () => {
    const f = fixture(); f.names.setBodyVisible('Moon', true);
    f.update(false, [{ x0: 400, y0: 380, x1: 700, y1: 430 }]); expect(f.names.metrics.drawn).toBe(0);
    f.update(true); expect(f.names.metrics.drawn).toBe(0);
    f.camera.position.z = 5; f.camera.updateMatrixWorld(true);
    f.update(false); expect(f.names.metrics.drawn).toBe(1);
    f.names.selectedRef = f.names.index.places[1].ref;
    f.update(false); expect(f.names.pick(400, 400)?.featureId).toBe('string:collision');
    f.camera.position.z = -5; f.camera.lookAt(0, 0, 0); f.camera.updateMatrixWorld(true);
    f.update(false); expect(f.names.pick(400, 400)?.featureId).toBe('string:back');
    f.names.setBodyVisible('Moon', false); f.names.selectedRef = null; f.update(); expect(f.names.metrics.drawn).toBe(0);
  });
  it('retains the same element through tiny motion and skipped LOS work, and tracks picking', () => {
    const f=fixture();f.names.setBodyVisible('Moon',true);f.update();
    const el=f.elements[0];const enters=f.names.metrics.enters;
    for(let i=0;i<50;i++) {
      f.camera.position.x+=.00001;f.camera.updateMatrixWorld(true);f.update();
      expect(f.names.metrics.drawn).toBe(1);
      expect(f.elements[0]).toBe(el);
      expect(f.names.pick(400,400)?.featureId).toBe('string:front');
    }
    expect(f.names.metrics.enters).toBe(enters);
    expect(el.style.background).toBeUndefined();
  });
  it('does not hide a retained name when a selected name consumes the LOS budget', () => {
    const f=fixture(-85);f.camera.position.z=1.2;f.camera.updateMatrixWorld(true);
    f.names.setBodyVisible('Moon',true);f.names.selectedRef=f.names.index.places[1].ref;f.update();
    expect(f.names.metrics.drawn).toBe(2);
    let tick=10000;vi.spyOn(performance,'now').mockImplementation(()=>tick+=3);
    f.camera.position.x+=.0001;f.camera.updateMatrixWorld(true);
    f.names.update(f.camera,new Map([['Moon',f.body]]),1,800,800,[],()=>false);
    expect(f.names.metrics.losDeferred).toBeGreaterThan(0);
    expect(f.names.metrics.drawn).toBe(2);
    expect(f.names.pick(400,400)?.featureId).toBe('string:front');
  });
  it('anchors on rendered areoid terrain and keeps a close basin label whose reference point is behind the camera', () => {
    const f = fixture();
    Object.assign(f.body, { hasTerrain: true });
    f.names.setBodyVisible('Moon', true);
    // The actual terrain is below the reference sphere; the camera is above
    // the ground but below the reference point. No source datum is relabeled.
    f.camera.position.z = .95; f.camera.lookAt(0, 0, 0); f.camera.updateMatrixWorld(true);
    const rendered = () => ({ offsetKm: new Vector3(0, 0, .9), source: 'rendered-surface' as const });
    f.update(false, [], rendered);
    expect(f.names.pick(400, 400)?.featureId).toBe('string:front');
    expect(f.names.metrics.rendered).toBe(1);
    expect(f.elements[0].dataset.anchor).toBe('rendered-surface');
    // Both retained and newly admitted names use the real anchor at close range.
    f.camera.position.z = .93; f.camera.updateMatrixWorld(true);
    f.update(false, [], rendered);
    expect(f.names.pick(400, 400)?.featureId).toBe('string:front');
    f.update(true, [], rendered);
    expect(f.names.metrics.drawn).toBe(0); // a ridge still occludes immediately
  });
  it('reprojects a refined terrain anchor instead of its old reference position', () => {
    const f = fixture();Object.assign(f.body, { hasTerrain: true });f.names.setBodyVisible('Moon', true);
    let x = 0;
    const rendered = () => ({ offsetKm: new Vector3(x, 0, .9), source: 'rendered-surface' as const });
    f.update(false, [], rendered);
    const element = f.elements[0], originalLeft = element.style.left;
    x = .1;f.update(false, [], rendered);
    expect(f.elements[0]).toBe(element);expect(element.style.left).not.toBe(originalLeft);
    expect(f.names.metrics.drawn).toBe(1);
  });
  it('preserves explicit source heights when rendered terrain is available', () => {
    const f=fixture();Object.assign(f.body,{hasTerrain:true});
    const place=f.names.index.places[0];
    if(place.feature.geometry.type!=='Point')throw new Error('Expected point');
    place.feature.geometry.coordinates.heightKm=.2;
    f.names.selectedRef=place.ref;
    const rendered=vi.fn(()=>({offsetKm:new Vector3(0,0,.9),source:'rendered-surface' as const}));
    f.update(false,[],rendered);
    expect(rendered).not.toHaveBeenCalled();
    expect(f.elements[0].dataset.anchor).toBe('source-height');
    expect(place.feature.geometry.coordinates.heightKm).toBe(.2);
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
