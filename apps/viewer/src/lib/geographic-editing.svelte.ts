/**
 * Drawing and editing planetary surface features (#200).
 *
 * Authored layers and working copies live here as core `GeographicEditSession`s
 * and are installed into the scene's geographic store under one owner, so the
 * renderer, Surface layers, styles and picking treat them like any other layer
 * (ownership `user`). Every edit goes through core, which refuses edits that
 * would leave a feature invalid; a refusal leaves the layer unchanged and its
 * reason is shown.
 *
 * Drawing is an explicit tool: while a draw tool is on it owns clicks on the
 * scene (camera drags still orbit), so it never fights selection, the probe or
 * measurement. Editing a feature's vertices is entered from its details, never
 * by clicking it.
 *
 * Layers are kept in this browser (localStorage), as the documented, bounded
 * `cosmolabe-geographic-edits` document; they appear in any scene with their
 * body. Export writes planetary GeoJSON with its conventions, and a companion
 * catalog that loads it through the ordinary path.
 */
import {
  GeographicEditSession, bodyFixedToGeodetic, createGeographicEditLayer, createGeographicWorkingCopy, exportGeographicEditLayer,
  geodesicDistanceKm, geographicDatum, geographicEditCompanionCatalog, geographicEditFeatureRefId, geographicEditLayerToLayer,
  geographicPositionInConvention, importGeographicEditLayer, normalizeGeographicPosition, parseGeographicEditDocument,
  serializeGeographicEditDocument, GEOGRAPHIC_EDIT_MAX_LAYERS, GEOGRAPHIC_GEOJSON_EXTENSION,
  type GeographicCoordinates, type GeographicEditFeature, type GeographicEditLayer, type GeographicEditOperation,
  type GeographicLayer, type GeographicLayerLoad, type GeographicShapeParameters, type GeoPosition, type JsonValue,
} from '@cosmolabe/core';
import type { GeographicFeatureRef, UniverseRenderer } from '@cosmolabe/three';
import { excludeFromProbe, getRenderer, onViewerEvent, setProbeActive } from './viewer-state.svelte';
import { cancelMeasurementPick } from './spatial-measurements.svelte';
import { getUniverse } from './loader';
import { geo, selectFeature } from './geographic-layers.svelte';
import { onToolClose } from './shell.svelte';

const STORAGE_KEY = 'cosmolabe-geographic-edits';
/** The scene-store owner for authored layers. */
export const EDIT_OWNER = 'cosmolabe:user-edits';
/** Two clicks this close in time and space finish a path or polygon. */
const DOUBLE_CLICK_MS = 350;
const DOUBLE_CLICK_PX = 6;

export type DrawTool = 'point' | 'line' | 'polygon' | 'circle' | 'ellipse';

export interface Draft {
  tool: DrawTool;
  /** Clicked positions in the target layer's declared convention. */
  vertices: GeoPosition[];
  /** The pointer's surface position, for the rubber band; null off the body. */
  hover: GeoPosition | null;
}

export const edits = $state({
  /** Bumped on every change to any authored layer. */
  revision: 0,
  /** Layer new features are drawn into. */
  target: null as string | null,
  tool: null as DrawTool | null,
  draft: null as Draft | null,
  /** The feature whose vertex handles are shown. */
  editing: null as { layerId: string; featureId: string | number } | null,
  /** Vertex chosen for deletion, in the feature being edited. */
  vertex: null as { part: number[]; index: number } | null,
  /** Last refusal or note. */
  message: '',
  /** Why stored layers were partly ignored, from the last load. */
  problems: [] as string[],
  persistent: true,
});

const sessions = new Map<string, GeographicEditSession>();
let lastPick = { at: 0, x: 0, y: 0 };

// ── Store and persistence ──

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeGeographicEditDocument([...sessions.values()].map((s) => s.layer)));
    edits.persistent = true;
  } catch (e) {
    edits.persistent = false;
    edits.message = e instanceof Error && /budget|at most/.test(e.message) ? e.message : 'This browser refused storage: edits last for this session only.';
  }
}

function restore(): void {
  let text: string | null = null;
  try { text = localStorage.getItem(STORAGE_KEY); } catch { /* unavailable */ }
  if (!text) return;
  const { layers, problems } = parseGeographicEditDocument(text);
  edits.problems = problems;
  for (const layer of layers) track(new GeographicEditSession(layer));
}

function track(session: GeographicEditSession): void {
  sessions.set(session.layer.id, session);
  session.subscribe(() => { install(); save(); edits.revision++; });
}

/** Authored layers for the current scene's bodies, installed under one owner. */
function install(): void {
  const universe = getUniverse();
  if (!universe) return;
  const loads: GeographicLayerLoad[] = [];
  for (const session of sessions.values()) {
    if (!universe.getBody(session.layer.body)) continue;
    const layer = geographicEditLayerToLayer(session.layer);
    loads.push({ id: layer.id, source: layer.source, status: 'ready', layer, diagnostics: layer.diagnostics });
  }
  universe.geographicLayers.replaceCatalog(EDIT_OWNER, loads);
  universe.events.emit('geographic:changed', {});
}

export function editLayers(): GeographicEditLayer[] {
  void edits.revision;
  return [...sessions.values()].map((s) => s.layer);
}
export function editLayer(id: string | null): GeographicEditLayer | undefined {
  void edits.revision;
  return id ? sessions.get(id)?.layer : undefined;
}
export const isEditable = (layerId: string | null | undefined): boolean => !!layerId && sessions.has(layerId);

export function editFeature(layerId: string, featureId: string | number): GeographicEditFeature | undefined {
  return editLayer(layerId)?.features.find((f) => f.id === featureId);
}
/** The edit feature behind a scene/list reference, if the layer is editable. */
export function editFeatureOf(ref: GeographicFeatureRef | null): GeographicEditFeature | undefined {
  if (!ref || !isEditable(ref.layerId)) return undefined;
  return editLayer(ref.layerId)?.features.find((f) => geographicEditFeatureRefId(f.id) === ref.featureId);
}

// ── Layers ──

/** The reference shape a new layer on `body` uses: the body's radii, sphere or oblate only. */
export function bodyReferenceShape(body: string): GeographicCoordinates['referenceShape'] | null {
  const radii = getUniverse()?.getBody(body)?.radii;
  if (!radii || radii.length < 3 || !radii.every((r) => Number.isFinite(r) && r > 0)) return null;
  const [a, b, c] = radii;
  if (a === b && b === c) return { kind: 'sphere', radiusKm: a };
  if (a === b && c < a) return { kind: 'ellipsoid', radiiKm: [a, b, c] };
  return null;
}

export function createLayer(options: { body: string; name: string; coordinates: GeographicCoordinates }): string | null {
  if (sessions.size >= GEOGRAPHIC_EDIT_MAX_LAYERS) { edits.message = `At most ${GEOGRAPHIC_EDIT_MAX_LAYERS} edited layers are kept; export and delete one first.`; return null; }
  const slug = options.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layer';
  let id = `user:${options.body.toLowerCase()}:${slug}`;
  for (let n = 2; sessions.has(id) || getUniverse()?.geographicLayers.get(id); n++) id = `user:${options.body.toLowerCase()}:${slug}-${n}`;
  track(new GeographicEditSession(createGeographicEditLayer({ id, name: options.name.trim() || 'Untitled', body: options.body, coordinates: options.coordinates })));
  install(); save(); edits.revision++;
  edits.target = id;
  return id;
}

/**
 * An editable copy of a read-only layer. The original is hidden while the copy
 * shows (and the user is told), and is never modified.
 */
export function makeWorkingCopy(layer: GeographicLayer): string | null {
  if (sessions.size >= GEOGRAPHIC_EDIT_MAX_LAYERS) { edits.message = `At most ${GEOGRAPHIC_EDIT_MAX_LAYERS} edited layers are kept.`; return null; }
  let id = `${layer.id}:edits`;
  for (let n = 2; sessions.has(id); n++) id = `${layer.id}:edits-${n}`;
  track(new GeographicEditSession(createGeographicWorkingCopy(layer, { id })));
  install(); save(); edits.revision++;
  getRenderer()?.geographicVectors.setVisible(layer.id, false);
  geo.revision++;
  edits.target = id;
  edits.message = `Editing a copy of ${layer.name}. The original is hidden and unchanged; show it again in Surface layers.`;
  return id;
}

export function renameLayer(id: string, name: string): void {
  if (name.trim()) sessions.get(id)?.update({ name: name.trim() });
}

export function deleteLayer(id: string): void {
  if (!sessions.delete(id)) return;
  if (edits.target === id) edits.target = null;
  if (edits.editing?.layerId === id) stopEditingFeature();
  install(); save(); edits.revision++;
}

// ── Operations ──

/** Apply one edit; on refusal show why and change nothing. Returns the new or edited feature's ID. */
export function applyEdit(layerId: string, op: GeographicEditOperation): string | number | null {
  const session = sessions.get(layerId);
  if (!session) return null;
  // Drafts and drags are reactive state; core keeps plain data it can clone and store.
  const result = session.apply($state.snapshot(op) as GeographicEditOperation);
  if (!result.ok) {
    edits.message = result.diagnostics.map((d) => d.message).join('; ');
    return null;
  }
  edits.message = result.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message).join('; ');
  return result.featureId ?? null;
}

export function undo(layerId = edits.target): boolean { return !!layerId && !!sessions.get(layerId)?.undo(); }
export function redo(layerId = edits.target): boolean { return !!layerId && !!sessions.get(layerId)?.redo(); }
export function canUndo(layerId = edits.target): boolean { void edits.revision; return !!layerId && !!sessions.get(layerId)?.canUndo; }
export function canRedo(layerId = edits.target): boolean { void edits.revision; return !!layerId && !!sessions.get(layerId)?.canRedo; }

export function setFeatureProperties(layerId: string, featureId: string | number, properties: { [key: string]: JsonValue }): boolean {
  return applyEdit(layerId, { type: 'set-properties', featureId, properties }) !== null;
}

export function deleteFeature(layerId: string, featureId: string | number): void {
  if (edits.editing?.featureId === featureId) stopEditingFeature();
  if (applyEdit(layerId, { type: 'delete', featureId }) !== null && geo.selected?.layerId === layerId) selectFeature(null);
}

export function duplicateFeature(layerId: string, featureId: string | number): void {
  const id = applyEdit(layerId, { type: 'duplicate', featureId });
  if (id !== null) selectFeature({ layerId, featureId: geographicEditFeatureRefId(id), bodyName: editLayer(layerId)!.body });
}

// ── Pointer to coordinates ──

/** The surface under a canvas point, in a layer's declared convention; null off its body. */
export function surfacePosition(renderer: UniverseRenderer, layer: GeographicEditLayer, x: number, y: number): GeoPosition | null {
  const hit = renderer.pickScene(x, y, 'probe', { renderedOnly: true });
  if (hit?.kind !== 'surface' || hit.point.bodyName !== layer.body) return null;
  const [xKm, yKm, zKm] = hit.point.bodyFixedPositionKm;
  // Through the layer's own datum, whatever latitude the hit was reported in; heights are not kept.
  const p = bodyFixedToGeodetic({ xKm, yKm, zKm }, geographicDatum(layer.coordinates));
  const [lon, lat] = geographicPositionInConvention({ latDeg: p.latDeg, lonDeg: p.lonDeg }, layer.coordinates);
  return [lon, lat];
}

// ── Drawing ──

/** Turn a draw tool on (or off with null). It owns scene clicks while on. */
export function setDrawTool(tool: DrawTool | null): void {
  const renderer = getRenderer();
  edits.draft = null;
  edits.message = '';
  if (!tool) {
    edits.tool = null;
    renderer?.setSurfacePointerTool(null);
    return;
  }
  const layer = editLayer(edits.target);
  if (!layer || !renderer) { edits.message = 'Choose or create a layer to draw into.'; return; }
  setProbeActive(false);
  cancelMeasurementPick();
  stopEditingFeature();
  edits.tool = tool;
  edits.draft = { tool, vertices: [], hover: null };
  renderer.setSurfacePointerTool({
    pick: (x, y) => drawPick(x, y),
    preview: (x, y) => {
      const target = editLayer(edits.target);
      if (!edits.draft || !target) return;
      edits.draft.hover = surfacePosition(renderer, target, x, y);
      renderer.setHoveredBody(null);
    },
  });
}

excludeFromProbe(() => { if (edits.tool) setDrawTool(null); });

// However Draw closes (its button, the rail, Escape or closing every tool), the
// draw tool gives scene clicks back and vertex editing ends; minimizing keeps them.
onToolClose('draw', () => {
  if (edits.tool || edits.draft) setDrawTool(null);
  stopEditingFeature();
});

function drawPick(x: number, y: number): void {
  const renderer = getRenderer();
  const layer = editLayer(edits.target);
  const draft = edits.draft;
  if (!renderer || !layer || !draft) return;
  const now = performance.now();
  const double = now - lastPick.at < DOUBLE_CLICK_MS && Math.hypot(x - lastPick.x, y - lastPick.y) < DOUBLE_CLICK_PX;
  lastPick = { at: now, x, y };
  if (double && (draft.tool === 'line' || draft.tool === 'polygon')) { finishDraft(); return; }
  const position = surfacePosition(renderer, layer, x, y);
  if (!position) { edits.message = `Click on ${layer.body} to place a vertex.`; return; }
  edits.message = '';
  draft.vertices.push(position);
  if (draft.tool === 'point') finishDraft();
  else if (draft.tool === 'circle' && draft.vertices.length === 2) finishDraft();
  else if (draft.tool === 'ellipse' && draft.vertices.length === 3) finishDraft();
}

/** Semantic parameters from a circle/ellipse draft's clicks: centre, then major axis end, then minor extent. */
export function draftShape(layer: GeographicEditLayer, draft: Draft, pointer: GeoPosition | null = draft.hover): GeographicShapeParameters | null {
  const points = [...draft.vertices, ...(pointer ? [pointer] : [])];
  if (points.length < 2) return null;
  const datum = geographicDatum(layer.coordinates);
  const center = normalizeGeographicPosition(points[0], layer.coordinates);
  const major = normalizeGeographicPosition(points[1], layer.coordinates);
  const semiMajorKm = geodesicDistanceKm(center, major, datum);
  if (!(semiMajorKm > 0)) return null;
  const c = [points[0][0], points[0][1]] as [number, number];
  if (draft.tool === 'circle') return { kind: 'circle', center: c, semiMajorKm, semiMinorKm: semiMajorKm, bearingDeg: 0 };
  // Bearing of the major axis at the centre, from the local east/north offsets.
  const dLon = ((major.lonDeg - center.lonDeg + 540) % 360) - 180;
  const bearingDeg = (Math.atan2(dLon * Math.cos(center.latDeg * Math.PI / 180), major.latDeg - center.latDeg) * 180 / Math.PI + 360) % 360;
  const minor = points[2] ? Math.min(semiMajorKm, geodesicDistanceKm(center, normalizeGeographicPosition(points[2], layer.coordinates), datum)) : semiMajorKm / 2;
  return { kind: 'ellipse', center: c, semiMajorKm, semiMinorKm: Math.max(minor, semiMajorKm / 1000), bearingDeg };
}

/** Add the draft as a feature (Enter, double-click or the last click of a point/circle/ellipse). */
export function finishDraft(): void {
  const layer = editLayer(edits.target);
  const draft = edits.draft;
  if (!layer || !draft) return;
  const v = draft.vertices;
  let op: GeographicEditOperation | null = null;
  if (draft.tool === 'point' && v.length) op = { type: 'add', geometry: { type: 'Point', coordinates: v[0] } };
  else if (draft.tool === 'line' && v.length >= 2) op = { type: 'add', geometry: { type: 'LineString', coordinates: v } };
  else if (draft.tool === 'polygon' && v.length >= 3) op = { type: 'add', geometry: { type: 'Polygon', coordinates: [[...v, [...v[0]] as GeoPosition]] } };
  else if (draft.tool === 'circle' || draft.tool === 'ellipse') {
    const shape = draftShape(layer, draft, null);
    if (shape) op = { type: 'add', shape };
  }
  if (!op) {
    edits.message = draft.tool === 'line' ? 'A path needs at least two vertices.' : draft.tool === 'polygon' ? 'A polygon needs at least three vertices.' : 'Keep clicking to define the shape.';
    return;
  }
  op = { ...op, properties: { name: `${draft.tool === 'line' ? 'Path' : draft.tool[0].toUpperCase() + draft.tool.slice(1)} ${layer.nextId}` } } as GeographicEditOperation;
  const id = applyEdit(layer.id, op);
  // A refused draft (for example a self-intersecting polygon) stays, so it can be fixed with Backspace.
  if (id === null) return;
  edits.draft = { tool: draft.tool, vertices: [], hover: draft.hover };
  selectFeature({ layerId: layer.id, featureId: geographicEditFeatureRefId(id), bodyName: layer.body });
}

/** Drop the last placed vertex. */
export function removeLastVertex(): boolean {
  if (!edits.draft?.vertices.length) return false;
  edits.draft.vertices.pop();
  edits.message = '';
  return true;
}

/** Escape: abandon the draft in progress, or leave the tool when there is none. */
export function cancelDrawing(): boolean {
  if (edits.draft?.vertices.length) { edits.draft.vertices = []; edits.message = ''; return true; }
  if (edits.tool) { setDrawTool(null); return true; }
  if (edits.editing) { stopEditingFeature(); return true; }
  return false;
}

// ── Vertex editing ──

export function startEditingFeature(layerId: string, featureId: string | number): void {
  setDrawTool(null);
  edits.editing = { layerId, featureId };
  edits.vertex = null;
  edits.target = layerId;
}
export function stopEditingFeature(): void {
  edits.editing = null;
  edits.vertex = null;
}

export function deleteSelectedVertex(): boolean {
  const e = edits.editing, v = edits.vertex;
  if (!e || !v) return false;
  if (applyEdit(e.layerId, { type: 'delete-vertex', featureId: e.featureId, vertex: v }) !== null) edits.vertex = null;
  return true;
}

// ── Export and import ──

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
const fileBase = (layer: GeographicEditLayer) => layer.id.replace(/[^a-z0-9.-]+/gi, '-');

export function exportLayer(id: string): void {
  const layer = editLayer(id);
  if (!layer) return;
  download(`${fileBase(layer)}.geojson`, exportGeographicEditLayer(layer), 'application/geo+json');
}
export function exportCompanionCatalog(id: string): void {
  const layer = editLayer(id);
  if (!layer) return;
  download(`${fileBase(layer)}.catalog.json`, JSON.stringify(geographicEditCompanionCatalog(layer, `${fileBase(layer)}.geojson`), null, 2), 'application/json');
}

/** Import planetary GeoJSON exported here (or plain GeoJSON with an explicit body and convention) as an editable layer. */
/**
 * Whether this text is a GeoJSON FeatureCollection that does not say which
 * body or convention it uses, so importing it needs the user to choose them.
 */
export function importNeedsConventions(text: string): boolean {
  try {
    const data = JSON.parse(text) as { type?: unknown; features?: unknown; [key: string]: unknown };
    return data?.type === 'FeatureCollection' && Array.isArray(data.features) && !(GEOGRAPHIC_GEOJSON_EXTENSION in data);
  } catch { return false; }
}

export function importLayerText(text: string, fallback?: { body: string; name: string; coordinates: GeographicCoordinates }): string | null {
  try {
    const { layer, diagnostics } = importGeographicEditLayer(text, fallback ? { id: `user:${fallback.body.toLowerCase()}:import`, ...fallback } : undefined);
    let id = layer.id;
    for (let n = 2; sessions.has(id); n++) id = `${layer.id}-${n}`;
    if (sessions.size >= GEOGRAPHIC_EDIT_MAX_LAYERS) throw new Error(`At most ${GEOGRAPHIC_EDIT_MAX_LAYERS} edited layers are kept`);
    track(new GeographicEditSession({ ...layer, id }));
    install(); save(); edits.revision++;
    edits.target = id;
    const skipped = diagnostics.filter((d) => d.code === 'skipped-feature').length;
    edits.message = `Imported ${layer.features.length} features${skipped ? `; ${skipped} invalid features left out` : ''}.`
      + (getUniverse()?.getBody(layer.body) ? '' : ` ${layer.body} is not in this scene; the layer shows when it is.`);
    return id;
  } catch (e) {
    edits.message = e instanceof Error ? e.message : String(e);
    return null;
  }
}

// ── Scene binding ──

restore();

// Each scene gets the authored layers for its bodies; drafts and handles do not carry over.
onViewerEvent('load', () => {
  edits.tool = null;
  edits.draft = null;
  edits.editing = null;
  edits.vertex = null;
  edits.message = '';
  install();
  edits.revision++;
  // Keep drawing into the same layer; otherwise offer the first one this scene can show.
  const universe = getUniverse();
  const here = [...sessions.values()].map((x) => x.layer).filter((l) => universe?.getBody(l.body));
  if (!edits.target || !here.some((l) => l.id === edits.target)) edits.target = here[0]?.id ?? null;
});
