import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Universe, parseGeographicGeoJson, type GeographicCoordinates, type GeographicLayer } from '@cosmolabe/core';
import { GeographicVectorLayer, UniverseRenderer, type GeographicFeatureRef } from '@cosmolabe/three';
import * as THREE from 'three';

/**
 * The Surface layers panel's state against a real Universe store and the real
 * renderer vector layer; only the camera flight and the scene binding are
 * stand-ins.
 */
const flyOverSurface = vi.fn((..._args: unknown[]) => true);
let loadHandler: (() => void) | null = null;
let renderer: ReturnType<typeof fakeRenderer> | null = null;
let universe: Universe | null = null;

vi.mock('../viewer-state.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../viewer-state.svelte')>()),
  getRenderer: () => renderer,
  flyOverSurface: (...args: unknown[]) => flyOverSurface(...args),
  onViewerEvent: (name: string, handler: () => void) => { if (name === 'load') loadHandler = handler; return () => {}; },
}));
vi.mock('../loader', () => ({ getUniverse: () => universe }));

const {
  geo, selectFeature, setLayerVisible, layerVisible, isolateLayer, isIsolated, showAllLayers, listedFeatures,
  browseLayer, syncSceneFilter, setInViewOnly, goToFeature, navigationUnavailable, clearGeographicSelection, findFeature, showSelectedDetails,
} = await import('../geographic-layers.svelte');
const { shell, closeAllTools } = await import('../shell.svelte');

const mars: GeographicCoordinates = {
  latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
};
function layer(id: string, features: unknown[], body = 'Mars'): GeographicLayer {
  return parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features }),
    { id, name: id, body, source: `${id}.geojson`, coordinates: mars }, { kind: 'catalog', identity: `https://x/${id}.geojson` });
}
const point = (id: string, lon: number, lat: number, properties: object = {}) =>
  ({ type: 'Feature', id, properties: { name: id, ...properties }, geometry: { type: 'Point', coordinates: [lon, lat] } });

function fakeRenderer(scene: Universe) {
  const events = new Map<string, (payload: unknown) => void>();
  const geographicVectors = new GeographicVectorLayer(scene, 1, (ref) => events.get('geographic:select')?.(ref));
  // Mars turns about its pole by `spin`; a resting camera 10,000 km out looks at it along +X.
  const spin = new THREE.Quaternion();
  const mars = { visible: true, body: { geometryType: 'Globe' }, position: new THREE.Vector3(), terrainDatum: null,
    bodyToWorldQuaternion: (q: THREE.Quaternion) => q.copy(spin) };
  const bodyMeshes = new Map<string, object>([['Mars', mars], ['Phobos', { body: { geometryType: 'Mesh' } }]]);
  const camera = new THREE.PerspectiveCamera(60, 2, 1, 1e6);
  camera.position.set(10000, 0, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const view = { bodyMeshes, camera, scaleFactor: 1, renderer: { domElement: { clientWidth: 800, clientHeight: 400 } } };
  const projected: number[] = [];
  return {
    geographicVectors, spin, camera, projected, scaleFactor: 1, renderer: view.renderer,
    getBodyMesh: (name: string) => bodyMeshes.get(name) as never,
    projectGeographicPositions: (...args: Parameters<UniverseRenderer['projectGeographicPositions']>) => {
      projected.push(args[1].length);
      return UniverseRenderer.prototype.projectGeographicPositions.apply(view as unknown as UniverseRenderer, args);
    },
    events: { on: (name: string, handler: (payload: unknown) => void) => { events.set(name, handler); return () => events.delete(name); } },
    emit: (name: string, payload: unknown) => events.get(name)?.(payload),
    /** What `begin()` does each frame: apply visibility/filter changes. */
    frame: () => { geographicVectors.begin(); geographicVectors.end(); },
  };
}

const ref = (layerId: string, featureId: string, bodyName = 'Mars'): GeographicFeatureRef => ({ layerId, featureId, bodyName });

beforeEach(() => {
  vi.useFakeTimers();
  universe = new Universe();
  const science = layer('science', [
    point('a', 77.4, 18.4, { kind: 'rock', sol: 10 }),
    point('b', 77.5, 18.5, { kind: 'site', sol: 20 }),
    { type: 'Feature', id: 'route', properties: { name: 'Traverse', kind: 'route' }, geometry: { type: 'LineString', coordinates: [[359, 1], [1, 3]] } },
  ]);
  const regions = layer('regions', [point('c', 10, 10)]);
  const phobos = layer('phobos', [point('d', 10, 10)], 'Phobos');
  universe.geographicLayers.replaceCatalog('scene', [science, regions, phobos].map(l => ({ id: l.id, status: 'ready' as const, layer: l, source: l.source, diagnostics: [] })));
  renderer = fakeRenderer(universe);
  closeAllTools();
  loadHandler!();
});
afterEach(() => {
  renderer?.geographicVectors.dispose();
  universe?.dispose();
  vi.useRealTimers();
  flyOverSurface.mockClear();
});

describe('geographic selection shared by scene and list', () => {
  it('follows scene selection without opening the panel; the callout opens it on the feature’s layer', () => {
    renderer!.emit('geographic:select', ref('regions', 'string:c'));
    renderer!.emit('geographic:click', ref('regions', 'string:c'));
    expect(geo.selected).toEqual(ref('regions', 'string:c'));
    expect(shell.openTools).not.toContain('layers');
    expect(findFeature(geo.selected)?.feature.id).toBe('string:c');
    showSelectedDetails();
    expect(shell.openTools).toContain('layers');
    expect(geo.activeLayerId).toBe('regions');
    // With the panel open, a scene click lists the clicked feature's layer.
    renderer!.emit('geographic:click', ref('science', 'string:a'));
    expect(geo.activeLayerId).toBe('science');
  });

  it('selecting from the list highlights it in the scene without moving the camera', () => {
    selectFeature(ref('science', 'string:a'));
    expect(renderer!.geographicVectors.selectedFeature).toEqual(ref('science', 'string:a'));
    expect(flyOverSurface).not.toHaveBeenCalled();
    expect(clearGeographicSelection()).toBe(true);
    expect(renderer!.geographicVectors.selectedFeature).toBeNull();
    expect(clearGeographicSelection()).toBe(false);
  });

  it('shows a hidden layer before selecting its feature, and says so', () => {
    setLayerVisible('science', false);
    selectFeature(ref('science', 'string:a'));
    expect(layerVisible('science')).toBe(true);
    expect(geo.notice).toMatch(/Showing science/);
  });

  it('clears the selection, with a reason, when its layer is hidden', () => {
    selectFeature(ref('science', 'string:a'));
    renderer!.frame();
    setLayerVisible('science', false);
    renderer!.frame();
    expect(geo.selected).toBeNull();
    expect(geo.notice).toMatch(/layer was hidden/);
  });

  it('forgets everything when a new scene loads', () => {
    selectFeature(ref('science', 'string:a'));
    geo.query = 'rock';
    loadHandler!();
    expect(geo.selected).toBeNull();
    expect(geo.query).toBe('');
    expect(geo.activeLayerId).toBeNull();
  });
});

describe('layer visibility', () => {
  it('isolates one vector layer on its body and restores the others', () => {
    isolateLayer('regions');
    expect(layerVisible('regions')).toBe(true);
    expect(layerVisible('science')).toBe(false);
    expect(layerVisible('phobos')).toBe(true); // another body is untouched
    expect(isIsolated('regions')).toBe(true);
    showAllLayers('Mars');
    expect(layerVisible('science')).toBe(true);
    expect(isIsolated('regions')).toBe(false);
  });
});

describe('feature list search and filters', () => {
  const names = () => listedFeatures(universe!.geographicLayers.get('science')!).map(e => e.name);

  it('searches and filters, ignoring an incomplete property filter', () => {
    browseLayer('science');
    expect(names()).toEqual(['a', 'b', 'Traverse']);
    geo.query = 'traverse';
    expect(names()).toEqual(['Traverse']);
    geo.query = '';
    geo.field = { key: 'kind', kind: 'category', values: [] };
    expect(names()).toHaveLength(3);
    geo.field = { key: 'kind', kind: 'category', values: ['rock'] };
    expect(names()).toEqual(['a']);
    geo.field = { key: 'sol', kind: 'range', min: 15 };
    expect(names()).toEqual(['b']);
  });

  it('applies the search to the scene only when asked, and clears a selection it hides', () => {
    browseLayer('science');
    selectFeature(ref('science', 'string:a'));
    renderer!.frame();
    geo.query = 'site';
    syncSceneFilter();
    vi.advanceTimersByTime(200);
    expect(renderer!.geographicVectors.featureFilter('science')).toBeNull();
    geo.sceneFilter = true;
    syncSceneFilter();
    vi.advanceTimersByTime(200);
    expect(renderer!.geographicVectors.featureFilter('science')).toEqual(new Set(['string:b']));
    renderer!.frame();
    expect(geo.selected).toBeNull();
    expect(geo.notice).toMatch(/scene filter/);
    // Browsing another layer drops the old layer's scene filter.
    browseLayer('regions');
    expect(renderer!.geographicVectors.featureFilter('science')).toBeNull();
  });

  it('drops the scene filter however the panel closes', async () => {
    const { openTool, closeTool } = await import('../shell.svelte');
    openTool('layers');
    browseLayer('science');
    geo.query = 'site';
    geo.sceneFilter = true;
    syncSceneFilter();
    vi.advanceTimersByTime(200);
    expect(renderer!.geographicVectors.featureFilter('science')).not.toBeNull();
    closeTool('layers');
    expect(renderer!.geographicVectors.featureFilter('science')).toBeNull();
    expect(geo.sceneFilter).toBe(false);
  });
});

describe('in view', () => {
  it('follows the body turning under a resting camera, and does not project features past the horizon', () => {
    browseLayer('science');
    // Unturned, the camera looks at 0°E: the route (359–1°E) is in view, the targets near 77°E are past the horizon.
    setInViewOnly(true);
    expect(geo.inView).toEqual(new Set(['string:route']));
    // Turn Mars so 77°E faces the camera; the camera itself does not move.
    renderer!.spin.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -77.45 * Math.PI / 180);
    vi.advanceTimersByTime(450);
    expect(geo.inView).toEqual(new Set(['string:a', 'string:b']));
    // Only the two targets (anchor and vertex each) were projected; the route was culled.
    expect(renderer!.projected.at(-1)).toBe(4);
    // Turn back: the targets leave and the route returns.
    renderer!.spin.identity();
    vi.advanceTimersByTime(450);
    expect(geo.inView).toEqual(new Set(['string:route']));
    setInViewOnly(false);
  });
});

describe('navigation', () => {
  it('flies over a seam-crossing feature’s extent, or cuts for Frame', () => {
    expect(goToFeature(ref('science', 'string:route'))).toBe(true);
    const [body, area, options] = flyOverSurface.mock.calls[0] as [string, { latDeg: number; lonDeg: number; northSpanDeg: number; eastSpanDeg: number }, { seconds?: number; minSpanKm: number }];
    expect(body).toBe('Mars');
    expect(area.lonDeg).toBeCloseTo(0, 6);
    expect(area.eastSpanDeg).toBeCloseTo(2, 6);
    expect(area.northSpanDeg).toBeGreaterThan(1.9);
    expect(options.seconds).toBeUndefined();
    expect(options.minSpanKm).toBeGreaterThan(0);
    goToFeature(ref('science', 'string:a'), { cut: true });
    expect(flyOverSurface.mock.calls[1][2]).toMatchObject({ seconds: 0 });
  });

  it('explains why a body cannot be flown over', () => {
    expect(navigationUnavailable(universe!.geographicLayers.get('phobos')!)).toMatch(/not drawn as a globe/);
    expect(goToFeature(ref('phobos', 'string:d', 'Phobos'))).toBe(false);
    expect(flyOverSurface).not.toHaveBeenCalled();
    expect(geo.notice).toMatch(/Phobos/);
  });
});
