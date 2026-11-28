import { describe, expect, it } from 'vitest';
import { geodeticToBodyFixed, parseGeographicGeoJson, PlaceIndex } from '@cosmolabe/core';
import { DoubleSide, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Vector3 } from 'three';
import type { BodyMesh } from '../BodyMesh.js';
import { bodyFixedToGeodetic } from '../TerrainSampler.js';
import { UniverseRenderer } from '../UniverseRenderer.js';
import { placeAnchor } from '../geographic/PlaceSurface.js';
import type { PlaceWorkResult } from '../geographic/PlaceNames.js';

describe('cooperative rendered place placement', () => {
  it('preserves the analytical location across different place and terrain reference shapes', () => {
    const layer = parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', id: 'site', properties: { name: 'Site' }, geometry: { type: 'Point', coordinates: [0, 45] } },
    ] }), { id: 'sites', body: 'Mars', name: 'Sites', source: 'sites.geojson',
      coordinates: { latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
        referenceShape: { kind: 'sphere', radiusKm: 10 } } }, { kind: 'local-file', identity: 'sites.geojson' });
    // Use the same public index adapter as the viewer.
    const place = new PlaceIndex([layer]).places[0];
    const datum = { referenceShape: { kind: 'ellipsoid' as const, radiiKm: [12, 12, 9] as const },
      verticalDatum: 'ellipsoid' as const, heightConvention: 'geodetic-normal' as const };
    let analyticalCalls = 0;
    const body = new Group() as unknown as BodyMesh;
    const globe = new Mesh(); globe.visible = false;
    Object.assign(body, { body: { name: 'Mars' }, mesh: globe, hasTerrain: true, terrainDatum: datum,
      displayRadius: 12, getDskMeshes: () => [],
      terrainBodyFixedToGeodetic: (point: Parameters<typeof bodyFixedToGeodetic>[0]) => bodyFixedToGeodetic(point, datum),
      sampleTerrainBodyFixed: () => { analyticalCalls++; return { elevationKm: 2, datum }; } });
    const physical = placeAnchor(place, body)!;
    expect(physical.source).toBe('terrain-sample');
    analyticalCalls = 0;
    const p = geodeticToBodyFixed(place.feature.geometry.type === 'Point' ? place.feature.geometry.coordinates : { latDeg: 0, lonDeg: 0 }, place.layer.datum);
    const geo = bodyFixedToGeodetic(p, datum), lat = geo.latDeg*Math.PI/180;
    const normal = new Vector3(Math.cos(lat), Math.sin(lat), 0);
    const terrain = new Mesh(new PlaneGeometry(100, 100), new MeshBasicMaterial({ side: DoubleSide }));
    terrain.position.copy(physical.offsetKm);
    terrain.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal);
    const tiles = new Group(); tiles.add(terrain); body.add(tiles);
    Object.assign(body, { terrainTileGroup: tiles }); body.updateMatrixWorld(true);
    const camera = new PerspectiveCamera(); camera.position.copy(physical.offsetKm).addScaledVector(normal, 10);
    const context = { bodyMeshes: new Map([['Mars', body]]), scaleFactor: 1, camera, placeNames: { metrics: { raycasts: 0 } } };
    const method = UniverseRenderer.prototype as unknown as { _placeWork: (...args: unknown[]) => Generator<void, PlaceWorkResult | null> };
    const query = method._placeWork.call(context, place, body, undefined, true);
    let step = query.next(); while (!step.done) step = query.next();
    expect(step.value?.anchor.source).toBe('rendered-surface');
    expect(step.value!.anchor.offsetKm.distanceTo(physical.offsetKm)).toBeLessThan(1e-9);
    expect(step.value?.hidden).toBe(false);
    expect(analyticalCalls).toBe(0);
    if (place.feature.geometry.type !== 'Point') throw new Error('Expected point');
    place.feature.geometry.coordinates.heightKm = 5;
    const explicit = placeAnchor(place, body)!;
    const explicitQuery = method._placeWork.call(context, place, body, undefined, true);
    let explicitStep = explicitQuery.next(); while (!explicitStep.done) explicitStep = explicitQuery.next();
    expect(explicitStep.value?.anchor.source).toBe('source-height');
    expect(explicitStep.value!.anchor.offsetKm.distanceTo(explicit.offsetKm)).toBeLessThan(1e-9);
    expect(context.placeNames.metrics.raycasts).toBe(3);
    expect(analyticalCalls).toBe(0);
  });
});
