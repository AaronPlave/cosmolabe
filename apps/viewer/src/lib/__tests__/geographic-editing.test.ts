import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Universe, parseGeographicGeoJson, type GeographicCoordinates } from '@cosmolabe/core';
import { GeographicVectorLayer } from '@cosmolabe/three';

/** Editing state against a real Universe store and vector layer, and an in-memory localStorage. */
const loadHandlers: (() => void)[] = [];
let renderer: { geographicVectors: GeographicVectorLayer; setSurfacePointerTool: (tool: unknown) => void; events: { on: () => () => void } } | null = null;
/** The surface pointer tool the renderer currently holds. */
let pointerTool: unknown = null;
let universe: Universe | null = null;

vi.mock('../viewer-state.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../viewer-state.svelte')>()),
  getRenderer: () => renderer,
  onViewerEvent: (name: string, handler: () => void) => { if (name === 'load') loadHandlers.push(handler); return () => {}; },
}));
vi.mock('../loader', () => ({ getUniverse: () => universe, getCurrentRenderer: () => null }));

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}
const storage = new MemoryStorage();
vi.stubGlobal('localStorage', storage);

const editing = await import('../geographic-editing.svelte');
const shell = await import('../shell.svelte');
const geoLayers = await import('../geographic-layers.svelte');
const { edits, createLayer, applyEdit, makeWorkingCopy, editLayer, isEditable, undo, redo, deleteLayer, importLayerText, EDIT_OWNER } = editing;

const mars: GeographicCoordinates = {
  latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
};

function scene() {
  universe?.dispose();
  renderer?.geographicVectors.dispose();
  universe = new Universe();
  vi.spyOn(universe, 'getBody').mockImplementation(((name: string) => name === 'Mars' ? ({ name, radii: [3396.19, 3396.19, 3376.2] }) : undefined) as never);
  const science = parseGeographicGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'a', properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [[[77, 18], [78, 18], [78, 19], [77, 19], [77, 18]], [[77.2, 18.2], [77.4, 18.2], [77.4, 18.4], [77.2, 18.4], [77.2, 18.2]]] } },
  ] }), { id: 'science', name: 'Science', body: 'Mars', source: 's.geojson', coordinates: mars }, { kind: 'catalog', identity: 'https://x/s.geojson' });
  universe.geographicLayers.replaceCatalog('scene', [{ id: science.id, status: 'ready', layer: science, source: science.source, diagnostics: [] }]);
  renderer = { geographicVectors: new GeographicVectorLayer(universe, 1), setSurfacePointerTool: (tool: unknown) => { pointerTool = tool; }, events: { on: () => () => {} } };
  for (const handler of loadHandlers) handler();
}

beforeEach(() => {
  for (const layer of [...editing.editLayers()]) deleteLayer(layer.id);
  storage.data.clear();
  scene();
});

it('authors in the selected lunar frame and refuses picks from a different declared frame', () => {
  vi.mocked(universe!.getBody).mockImplementation(((name: string) => name === 'Moon' ? ({ name, radii: [1737.4, 1737.4, 1737.4] }) : undefined) as never);
  const selectedFrame = vi.spyOn(universe!.frames, 'bodyFixedFrameFor').mockReturnValue('MOON_ME_DE421');
  const coordinates = editing.inferredCoordinates('Moon')!;
  expect(coordinates.frame).toBe('MOON_ME_DE421');
  const id = createLayer({ body: 'Moon', name: 'Lunar notes', coordinates })!, layer = editLayer(id)!;
  let frame = 'MOON_ME_DE421';
  const pick = { pickScene: () => ({ kind: 'surface', point: { bodyName: 'Moon', frame, bodyFixedPositionKm: [1737.4, 0, 0] } }) } as unknown as Parameters<typeof editing.surfacePosition>[0];
  expect(editing.surfacePosition(pick, layer, 0, 0)).toEqual([0, 0]);
  frame = 'IAU_MOON';
  expect(editing.surfacePosition(pick, layer, 0, 0)).toBeNull();
  selectedFrame.mockRestore();
});

describe('authored layers in the scene', () => {
  it('installs an authored layer as a user-owned scene layer and keeps it in this browser', () => {
    const id = createLayer({ body: 'Mars', name: 'Jezero notes', coordinates: mars })!;
    expect(id).toBe('user:mars:jezero-notes');
    expect(applyEdit(id, { type: 'add', geometry: { type: 'Point', coordinates: [77.5, 18.5] } })).toBe('user-1');
    const layer = universe!.geographicLayers.get(id)!;
    expect(layer.ownership).toBe('user');
    expect(layer.features.map((f) => f.id)).toEqual(['string:user-1']);
    const stored = JSON.parse(storage.getItem('cosmolabe-geographic-edits')!);
    expect(stored.format).toBe('cosmolabe-geographic-edits');
    expect(stored.layers[0].features[0].geometry.coordinates).toEqual([77.5, 18.5]);
    expect(universe!.geographicLayers.loads.some((l) => l.id === id)).toBe(true);
    expect(EDIT_OWNER).toBe('cosmolabe:user-edits');
  });

  it('comes back in the next scene with the same body, exactly', () => {
    const id = createLayer({ body: 'Mars', name: 'Notes', coordinates: mars })!;
    applyEdit(id, { type: 'add', geometry: { type: 'LineString', coordinates: [[77.1, 18.1], [77.2, 18.3]] } });
    const before = editLayer(id);
    scene();
    expect(universe!.geographicLayers.get(id)?.features).toHaveLength(1);
    expect(editLayer(id)).toEqual(before);
    expect(edits.target).toBe(id);
  });

  it('reports a refused edit and keeps the layer unchanged, with undo and redo', () => {
    const id = createLayer({ body: 'Mars', name: 'Notes', coordinates: mars })!;
    expect(applyEdit(id, { type: 'add', geometry: { type: 'Polygon', coordinates: [[[77, 18], [78, 19], [78, 18], [77, 19], [77, 18]]] } })).toBeNull();
    expect(edits.message).toMatch(/self-intersects/);
    expect(editLayer(id)!.features).toEqual([]);
    applyEdit(id, { type: 'add', geometry: { type: 'Point', coordinates: [77, 18] } });
    expect(undo(id)).toBe(true);
    expect(universe!.geographicLayers.get(id)!.features).toHaveLength(0);
    expect(redo(id)).toBe(true);
    expect(universe!.geographicLayers.get(id)!.features).toHaveLength(1);
  });

  it('accepts reactive drafts: what reaches core is plain data it can clone', () => {
    const id = createLayer({ body: 'Mars', name: 'Notes', coordinates: mars })!;
    edits.draft = { tool: 'line', vertices: [[77.1, 18.1], [77.2, 18.2]], hover: null };
    expect(applyEdit(id, { type: 'add', geometry: { type: 'LineString', coordinates: edits.draft.vertices } })).toBe('user-1');
    expect(applyEdit(id, { type: 'move-vertex', featureId: 'user-1', vertex: { part: [], index: 0 }, position: [77.15, 18.1] })).toBe('user-1');
    edits.draft = null;
  });
});

describe('working copies', () => {
  it('copies a read-only layer, hides the original and never changes it', () => {
    const source = universe!.geographicLayers.get('science')!;
    const before = JSON.stringify(source.features);
    const id = makeWorkingCopy(source)!;
    expect(id).toBe('science:edits');
    expect(isEditable(id)).toBe(true);
    expect(isEditable('science')).toBe(false);
    expect(renderer!.geographicVectors.isVisible('science')).toBe(false);
    expect(edits.message).toMatch(/original is hidden and unchanged/);
    const copy = universe!.geographicLayers.get(id)!;
    expect(copy.features.map((f) => f.id)).toEqual(['string:a']);
    expect((copy.features[0].geometry as { coordinates: unknown[] }).coordinates).toHaveLength(2);
    applyEdit(id, { type: 'set-properties', featureId: 'a', properties: { name: 'changed' } });
    expect(JSON.stringify(universe!.geographicLayers.get('science')!.features)).toBe(before);
  });
});

describe('import', () => {
  it('imports exported planetary GeoJSON and refuses plain GeoJSON without conventions', () => {
    expect(importLayerText(JSON.stringify({ type: 'FeatureCollection', features: [] }))).toBeNull();
    expect(edits.message).toMatch(/WGS84/);
    const text = JSON.stringify({ type: 'FeatureCollection', 'cosmolabe:geographic': { version: 1, body: 'Mars', coordinates: mars, layer: { id: 'user:mars:x', name: 'X' } },
      features: [{ type: 'Feature', id: 'user-4', properties: {}, geometry: { type: 'Point', coordinates: [10, 10] } }] });
    const id = importLayerText(text)!;
    expect(editLayer(id)!.nextId).toBe(5);
    expect(universe!.geographicLayers.get(id)!.features).toHaveLength(1);
  });

  it('imports plain GeoJSON in the body and convention the user chose, without reprojecting', () => {
    const plain = JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', id: 7, properties: { name: 'Crater', active: true, depth: null }, geometry: { type: 'Point', coordinates: [-77.5, 18.4] } },
    ] });
    expect(editing.importNeedsConventions(plain)).toBe(true);
    expect(editing.importNeedsConventions('{"type":"FeatureCollection","features":[],"cosmolabe:geographic":{}}')).toBe(false);
    expect(editing.importNeedsConventions('not json')).toBe(false);
    const west: GeographicCoordinates = { ...mars, latitude: 'planetographic', longitudeDirection: 'west', longitudeDomain: '-180..180' };
    const id = importLayerText(plain, { body: 'Mars', name: 'craters', coordinates: west })!;
    const layer = editLayer(id)!;
    expect(layer).toMatchObject({ body: 'Mars', name: 'craters', coordinates: west });
    expect(layer.features[0]).toMatchObject({ id: 7, properties: { name: 'Crater', active: true, depth: null }, geometry: { coordinates: [-77.5, 18.4] } });
    // West-positive -77.5 is 77.5°E in the scene.
    const [f] = universe!.geographicLayers.get(id)!.features;
    expect((f.geometry.coordinates as { lonDeg: number }).lonDeg).toBeCloseTo(77.5, 9);
  });
});

describe('drawing flow', () => {
  it('draws into "My annotations · Mars", made on first use in the body\'s convention, and selects the finished shape', () => {
    editing.startDrawing('point');
    expect(pointerTool).not.toBeNull();
    const id = edits.target!;
    expect(editLayer(id)).toMatchObject({ name: 'My annotations · Mars', body: 'Mars', coordinates: { longitudeDomain: '0..360', longitudeDirection: 'east' } });
    edits.draft!.vertices.push([77.5, 18.5]);
    editing.finishDraft();
    // The tool ends; the shape is selected, its handles show, and the name waits for typing.
    expect(edits.tool).toBeNull();
    expect(pointerTool).toBeNull();
    expect(geoLayers.geo.selected).toEqual({ layerId: id, featureId: 'string:user-1', bodyName: 'Mars' });
    expect(editing.editingFeature()).toEqual({ layerId: id, featureId: 'user-1' });
    expect(edits.focusName).toBe(true);
    expect(shell.isToolOpen('layers')).toBe(true);
    // Drawing again uses the same layer.
    editing.startDrawing('line');
    expect(edits.target).toBe(id);
    editing.setDrawTool(null);
  });

  it('removes a layer it made when nothing was drawn, and keeps one that has shapes', () => {
    editing.startDrawing();
    const id = edits.target!;
    expect(edits.tool).toBe(edits.lastTool);
    editing.cancelDrawing();
    expect(editLayer(id)).toBeUndefined();
    expect(edits.tool).toBeNull();
  });

  it('draws into the layer being looked at when it is editable', () => {
    const notes = createLayer({ body: 'Mars', name: 'Notes', coordinates: mars })!;
    geoLayers.openLayer(notes);
    editing.startDrawing('point');
    expect(edits.target).toBe(notes);
    expect(edits.createdForDraft).toBeNull();
    editing.setDrawTool(null);
    expect(editLayer(notes)).toBeDefined();
  });

  it('shape editing follows the selection: handles for your own features, none while drawing or for read-only ones', () => {
    const id = createLayer({ body: 'Mars', name: 'Notes', coordinates: mars })!;
    applyEdit(id, { type: 'add', geometry: { type: 'LineString', coordinates: [[77, 18], [77.2, 18.2], [77.4, 18.1]] } });
    geoLayers.selectFeature({ layerId: id, featureId: 'string:user-1', bodyName: 'Mars' });
    expect(editing.editingFeature()).toEqual({ layerId: id, featureId: 'user-1' });
    edits.vertex = { layerId: id, featureId: 'user-1', part: [], index: 1 };
    expect(editing.deleteSelectedVertex()).toBe(true);
    expect(editLayer(id)!.features[0].geometry.coordinates).toHaveLength(2);
    geoLayers.selectFeature({ layerId: 'science', featureId: 'string:a', bodyName: 'Mars' });
    expect(editing.editingFeature()).toBeNull();
    editing.startDrawing('point');
    expect(editing.editingFeature()).toBeNull();
    editing.setDrawTool(null);
  });

  it('copies one read-only feature into annotations, in that layer\'s convention, leaving the original unchanged', () => {
    const before = JSON.stringify(universe!.geographicLayers.get('science')!.features);
    expect(editing.copyFeatureToAnnotations({ layerId: 'science', featureId: 'string:a', bodyName: 'Mars' })).toBe(true);
    const id = annotationsId();
    const copy = editLayer(id)!.features[0];
    expect(copy.properties).toMatchObject({ name: 'A', copiedFrom: 'science / string:a' });
    expect(copy.geometry.type).toBe('Polygon');
    expect((copy.geometry.coordinates as number[][][])[1]).toHaveLength(5);
    expect(geoLayers.geo.selected?.layerId).toBe(id);
    expect(JSON.stringify(universe!.geographicLayers.get('science')!.features)).toBe(before);
    // A whole-layer copy is still there, from the layer's menu.
    expect(isEditable(id)).toBe(true);
  });

  const annotationsId = () => editing.editLayers().find((l) => l.name === 'My annotations · Mars')!.id;
});
