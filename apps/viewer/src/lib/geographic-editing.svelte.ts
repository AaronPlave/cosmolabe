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
 * Drawing is a small tool state (docs/design/surface-layers-ux.md), shown as a
 * floating bar: while a draw tool is on it owns clicks on the scene (camera
 * drags still orbit), so it never fights selection, the probe or measurement.
 * It draws into the layer being looked at when that is editable, else the
 * last-used editable layer on that body, else "My annotations · <Body>",
 * created on first use in the convention of the body's existing layers. A
 * finished shape ends the tool and is selected. Selecting an editable feature
 * shows its handles: shape editing follows the selection, with no mode.
 *
 * Layers are kept in this browser (localStorage), as the documented, bounded
 * `cosmolabe-geographic-edits` document; they appear in any scene with their
 * body. Export writes planetary GeoJSON with its conventions, and a companion
 * catalog that loads it through the ordinary path.
 */
import {
  GeographicEditSession, bodyFixedFrameName, bodyFixedToGeodetic, createGeographicEditLayer, createGeographicWorkingCopy, exportGeographicEditLayer,
  geodesicDistanceKm, geographicDatum, geographicEditCompanionCatalog, geographicEditFeatureRefId, geographicEditLayerToLayer,
  geographicPositionInConvention, importGeographicEditLayer, normalizeGeographicPosition, parseGeographicEditDocument,
  serializeGeographicEditDocument, GEOGRAPHIC_EDIT_MAX_LAYERS, GEOGRAPHIC_GEOJSON_EXTENSION,
  type GeographicCoordinates, type GeographicEditFeature, type GeographicEditLayer, type GeographicEditOperation,
  type GeographicGeometry, type GeographicLayer, type GeographicLayerLoad, type GeographicShapeParameters, type GeoPosition, type JsonValue,
} from '@cosmolabe/core';
import type { GeographicFeatureRef, UniverseRenderer } from '@cosmolabe/three';
import { excludeFromProbe, getRenderer, onViewerEvent, setProbeActive } from './viewer-state.svelte';
import { cancelMeasurementPick } from './spatial-measurements.svelte';
import { getUniverse } from './loader';
import { geo, geographicLayer, selectFeature, showSelectedDetails } from './geographic-layers.svelte';
import { resettable } from './session.svelte';

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
  /** The tool Draw starts with: the last one used. */
  lastTool: 'polygon' as DrawTool,
  draft: null as Draft | null,
  /** Vertex chosen for deletion, in the selected feature. */
  vertex: null as { layerId: string; featureId: string | number; part: number[]; index: number } | null,
  /** A layer created for this drawing session, removed again if nothing is drawn into it. */
  createdForDraft: null as string | null,
  /** The Feature view should put the cursor in the name (a shape was just drawn). */
  focusName: false,
  /** A rename or delete asked for from a layer's menu, shown in its Layer view. */
  layerAction: null as null | { id: string; kind: 'rename' | 'delete' },
  /** The New layer / Import form in Surface layers, while it is open. */
  form: null as null | { mode: 'new' } | { mode: 'import'; text: string; fileName: string },
  /** Last refusal or note. */
  message: '',
  /** The feature just deleted, which Undo (the panel's notice or Ctrl/⌘ Z) brings back until the next edit. */
  deleted: null as null | { layerId: string; name: string },
  /** The large feature whose points were asked for ("layer/feature"); others show only their move handle. */
  allPoints: null as string | null,
  /** Points on screen without a handle (thinned or over the limit), from the edit overlay. */
  hiddenPoints: 0,
  /** Why stored layers were partly ignored, from the last load. */
  problems: [] as string[],
  persistent: true,
});
resettable(edits);

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
  if (edits.vertex?.layerId === id) edits.vertex = null;
  if (geo.selected?.layerId === id) selectFeature(null);
  install(); save(); edits.revision++;
}

/** The conventions a new layer on `body` takes: those of the body's existing layers, on the body's reference shape. */
export function inferredCoordinates(body: string): GeographicCoordinates | null {
  const referenceShape = bodyReferenceShape(body);
  if (!referenceShape) return null;
  const existing = getUniverse()?.geographicLayers.layers.find((l) => l.body === body && l.ownership !== 'user');
  const c = existing?.coordinates;
  return { frame: getUniverse()?.frames.bodyFixedFrameFor(body) ?? bodyFixedFrameName(body), latitude: c?.latitude ?? 'planetocentric', longitudeDirection: c?.longitudeDirection ?? 'east', longitudeDomain: c?.longitudeDomain ?? '-180..180', referenceShape };
}

export const annotationLayerName = (body: string) => `My annotations · ${body}`;

/**
 * Where a new shape on `body` goes: the layer being looked at if it is
 * editable, else the last-used editable layer there, else the body's
 * annotations layer. Null when none exists yet.
 */
export function annotationTarget(body: string): string | null {
  const here = (id: string | null) => !!id && sessions.get(id)?.layer.body === body;
  if (here(geo.activeLayerId)) return geo.activeLayerId;
  if (here(edits.target)) return edits.target;
  return [...sessions.values()].find((s) => s.layer.body === body && s.layer.name === annotationLayerName(body))?.layer.id ?? null;
}

/** The annotation layer for `body`, created (and remembered as made for this draft) when there is none. */
function ensureAnnotationLayer(body: string): string | null {
  const existing = annotationTarget(body);
  if (existing) return existing;
  const coordinates = inferredCoordinates(body);
  if (!coordinates) { edits.message = `${body} has no sphere or oblate reference shape to draw on.`; return null; }
  const id = createLayer({ body, name: annotationLayerName(body), coordinates });
  edits.createdForDraft = id;
  return id;
}

/** The body Draw works on: the layer being looked at, else the tracked body, else the first one that can be drawn on. */
export function drawBody(): string | null {
  const active = geographicLayer(geo.activeLayerId);
  if (active) return active.body;
  const tracked = getRenderer()?.cameraController?.focusBody?.body.name;
  if (tracked && bodyReferenceShape(tracked)) return tracked;
  return getUniverse()?.geographicLayers.layers.find((l) => bodyReferenceShape(l.body))?.body ?? null;
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
  edits.deleted = null;
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
  if (edits.vertex?.featureId === featureId) edits.vertex = null;
  const feature = editFeature(layerId, featureId);
  const name = typeof feature?.properties?.name === 'string' && feature.properties.name ? feature.properties.name : 'feature';
  if (applyEdit(layerId, { type: 'delete', featureId }) === null) return;
  if (geo.selected?.layerId === layerId) selectFeature(null);
  // The selection, and the edit bar's Undo with it, is gone: offer Undo where the panel lands.
  edits.deleted = { layerId, name };
}

/** Bring back the feature just deleted. */
export function undoDelete(): boolean {
  const d = edits.deleted;
  edits.deleted = null;
  return !!d && undo(d.layerId);
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
  if (hit.point.frame && hit.point.frame !== (layer.coordinates.frame ?? bodyFixedFrameName(layer.body))) return null;
  const [xKm, yKm, zKm] = hit.point.bodyFixedPositionKm;
  // Through the layer's own datum, whatever latitude the hit was reported in; heights are not kept.
  const p = bodyFixedToGeodetic({ xKm, yKm, zKm }, geographicDatum(layer.coordinates));
  const [lon, lat] = geographicPositionInConvention({ latDeg: p.latDeg, lonDeg: p.lonDeg }, layer.coordinates);
  return [lon, lat];
}

// ── Drawing ──

/**
 * Turn a draw tool on (or off with null). It owns scene clicks while on. With
 * no layer to draw into yet, the body's annotations layer is chosen or made.
 */
export function setDrawTool(tool: DrawTool | null, body: string | null = null): void {
  const renderer = getRenderer();
  edits.draft = null;
  edits.message = '';
  if (!tool) {
    edits.tool = null;
    renderer?.setSurfacePointerTool(null);
    // A layer made for this drawing and left empty goes again.
    const made = edits.createdForDraft;
    edits.createdForDraft = null;
    if (made && sessions.get(made)?.layer.features.length === 0) deleteLayer(made);
    return;
  }
  if (!renderer) return;
  const where = body ?? (edits.tool ? editLayer(edits.target)?.body ?? null : null) ?? drawBody();
  const target = where ? ensureAnnotationLayer(where) : null;
  if (!target) { edits.message ||= 'There is no globe in this scene to draw on.'; return; }
  edits.target = target;
  setProbeActive(false);
  cancelMeasurementPick();
  // Drawing replaces the selection; a new shape is selected when finished.
  if (geo.selected) selectFeature(null);
  edits.vertex = null;
  edits.tool = tool;
  edits.lastTool = tool;
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

/** Start drawing with the last tool used, on the body in view. */
export function startDrawing(tool: DrawTool = edits.lastTool): void {
  setDrawTool(tool);
}

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
  // The shape is done: the tool ends and the new shape is selected, ready to name.
  edits.createdForDraft = null;
  setDrawTool(null);
  selectFeature({ layerId: layer.id, featureId: geographicEditFeatureRefId(id), bodyName: layer.body });
  edits.focusName = true;
  showSelectedDetails();
}

/** Drop the last placed vertex. */
export function removeLastVertex(): boolean {
  if (!edits.draft?.vertices.length) return false;
  edits.draft.vertices.pop();
  edits.message = '';
  return true;
}

/** Escape: abandon the draft in progress, or leave the tool when there is none. A selected vertex is let go first. */
export function cancelDrawing(): boolean {
  if (edits.draft?.vertices.length) { edits.draft.vertices = []; edits.message = ''; return true; }
  if (edits.tool) { setDrawTool(null); return true; }
  if (edits.vertex) { edits.vertex = null; return true; }
  return false;
}

// ── Shape editing: follows the selection ──

/** The selected feature when it is editable and no draw tool is on: its handles show. */
export function editingFeature(): { layerId: string; featureId: string | number } | null {
  void edits.revision;
  if (edits.tool || !geo.selected) return null;
  const feature = editFeatureOf(geo.selected);
  return feature ? { layerId: geo.selected.layerId, featureId: feature.id } : null;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** Whether a large feature's points were asked for. */
export function showsAllPoints(layerId: string, featureId: string | number): boolean {
  return edits.allPoints === `${layerId}/${featureId}`;
}
export function setShowAllPoints(layerId: string, featureId: string | number, on: boolean): void {
  edits.allPoints = on ? `${layerId}/${featureId}` : null;
}

/** The vertex chosen in the feature being edited, if any. */
export function selectedVertex(): { part: number[]; index: number } | null {
  const e = editingFeature(), v = edits.vertex;
  return e && v && v.layerId === e.layerId && v.featureId === e.featureId ? { part: v.part, index: v.index } : null;
}

export function deleteSelectedVertex(): boolean {
  const e = editingFeature(), v = selectedVertex();
  if (!e || !v) return false;
  if (applyEdit(e.layerId, { type: 'delete-vertex', featureId: e.featureId, vertex: v }) !== null) edits.vertex = null;
  return true;
}

// ── Copying one feature ──

/**
 * Copy one read-only feature into the annotations layer of its body, in that
 * layer's convention; the original is never changed. The copy is selected.
 */
export function copyFeatureToAnnotations(ref: GeographicFeatureRef): boolean {
  const source = geographicLayer(ref.layerId);
  const feature = source?.features.find((f) => f.id === ref.featureId);
  if (!source || !feature) return false;
  const target = ensureAnnotationLayer(source.body);
  const layer = target ? editLayer(target) : undefined;
  if (!layer) return false;
  edits.createdForDraft = null;
  const position = (p: { latDeg: number; lonDeg: number }): GeoPosition => {
    const [lon, lat] = geographicPositionInConvention({ latDeg: p.latDeg, lonDeg: p.lonDeg }, layer.coordinates);
    return [lon, lat];
  };
  const g = feature.geometry;
  let geometry: GeographicGeometry<GeoPosition>;
  switch (g.type) {
    case 'Point': geometry = { type: 'Point', coordinates: position(g.coordinates) }; break;
    case 'MultiPoint': geometry = { type: 'MultiPoint', coordinates: g.coordinates.map(position) }; break;
    case 'LineString': geometry = { type: 'LineString', coordinates: g.coordinates.map(position) }; break;
    case 'MultiLineString': geometry = { type: 'MultiLineString', coordinates: g.coordinates.map((r) => r.map(position)) }; break;
    case 'Polygon': geometry = { type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(position)) }; break;
    case 'MultiPolygon': geometry = { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map((r) => r.map(position))) }; break;
  }
  const properties = { ...(structuredClone(feature.properties ?? {}) as { [key: string]: JsonValue }), copiedFrom: `${source.id} / ${feature.id}` };
  const id = applyEdit(layer.id, { type: 'add', geometry, properties });
  if (id === null) return false;
  edits.target = layer.id;
  selectFeature({ layerId: layer.id, featureId: geographicEditFeatureRefId(id), bodyName: layer.body });
  edits.message = `Copied to ${layer.name}; ${source.name} is unchanged.`;
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
    // Importing is not choosing where to draw: new shapes keep going where they went.
    const skipped = diagnostics.filter((d) => d.code === 'skipped-feature').length;
    edits.message = `Imported ${plural(layer.features.length, 'feature')}${skipped ? `; ${plural(skipped, 'invalid feature')} left out` : ''}.`
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
  edits.vertex = null;
  edits.createdForDraft = null;
  edits.form = null;
  edits.layerAction = null;
  edits.message = '';
  install();
  edits.revision++;
  // Keep drawing into the same layer; otherwise offer the first one this scene can show.
  const universe = getUniverse();
  const here = [...sessions.values()].map((x) => x.layer).filter((l) => universe?.getBody(l.body));
  if (!edits.target || !here.some((l) => l.id === edits.target)) edits.target = here[0]?.id ?? null;
});
