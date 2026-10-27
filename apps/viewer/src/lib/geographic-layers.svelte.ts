/**
 * Geographic layer browsing (#198): which vector layers are on, which feature
 * is selected, and the list's search and filters. One selection is shared by
 * the 3D scene and the Surface layers panel — a click on either selects the
 * same `(layerId, featureId, bodyName)` reference, the renderer highlights it,
 * and the panel shows its details.
 *
 * The selection also decides what the panel shows (docs/design/surface-layers-ux.md):
 * the selected feature; else the imagery or layer being looked at; else the
 * list of layers. Back from a feature clears the selection and lands on its
 * layer; back from a layer returns to the list.
 *
 * Layer visibility and the scene filter are session presentation over the
 * imported data; the layers themselves are never modified. Everything resets
 * when a scene loads.
 */
import {
  geographicFeatureAnchor, geographicFeatureExtent, geographicGeometryPositions, geographicQueryEmpty,
  geographicQueryMatches, geographicSearchIndex,
  type BodyFixedPosition, type GeographicFeature, type GeographicFieldFilter, type GeographicLayer, type GeographicLayerLoad,
  type GeographicSearchEntry, type Universe,
} from '@cosmolabe/core';
import { sameGeographicFeature, type GeographicFeatureRef } from '@cosmolabe/three';
import * as THREE from 'three';
import { flyOverSurface, getRenderer, onViewerEvent, vs } from './viewer-state.svelte';
import { getUniverse } from './loader';
import { isToolOpen, onToolClose, openTool } from './shell.svelte';

export const geo = $state({
  /** Bumped by anything that changes what the panel shows: loads, visibility, filters. */
  revision: 0,
  selected: null as GeographicFeatureRef | null,
  hovered: null as GeographicFeatureRef | null,
  /** The layer whose features are listed. */
  activeLayerId: null as string | null,
  /** The body whose imagery is shown, instead of a layer. */
  imageryBody: null as string | null,
  /** Search across every layer, in the list of layers. */
  globalQuery: '',
  /** Open "About this layer" when the layer is next shown. */
  showAbout: false,
  /** The feature last shown, so the list returns to it after Back. */
  recent: null as GeographicFeatureRef | null,
  query: '',
  field: null as GeographicFieldFilter | null,
  /** List only features with a vertex or anchor in the current view. */
  inViewOnly: false,
  /** Also draw only the listed features in the scene (search and field filter; not the view). */
  sceneFilter: false,
  /** Feature IDs of the active layer in view, while `inViewOnly` is on. */
  inView: null as ReadonlySet<string> | null,
  /** Why the selection or visibility changed underneath the user, until the next action. */
  notice: '',
  /** Bumped when the list should scroll the selection into view. */
  reveal: 0,
});

// ── What the panel shows ──

export type SurfacePanelView =
  | { kind: 'feature'; layer: GeographicLayer; feature: GeographicFeature }
  | { kind: 'imagery'; body: string }
  | { kind: 'layer'; layer: GeographicLayer }
  | { kind: 'layers' };

/** The selection decides the view: feature, else imagery or layer, else the list. */
export function surfacePanelView(): SurfacePanelView {
  const found = findFeature(geo.selected);
  if (found) return { kind: 'feature', ...found };
  if (geo.imageryBody) return { kind: 'imagery', body: geo.imageryBody };
  const layer = geographicLayer(geo.activeLayerId);
  return layer ? { kind: 'layer', layer } : { kind: 'layers' };
}

/** Show one layer: its features, appearance and information. */
export function openLayer(id: string, options: { about?: boolean } = {}): void {
  if (geo.selected) selectFeature(null);
  geo.imageryBody = null;
  geo.showAbout = !!options.about;
  browseLayer(id);
}

export function openImagery(body: string): void {
  if (geo.selected) selectFeature(null);
  geo.imageryBody = body;
}

/** Back to the list of layers. */
export function showLayerList(): void {
  if (geo.selected) selectFeature(null);
  geo.imageryBody = null;
  browseLayer(null);
}

/** Back from a feature to its layer; the list scrolls back to it. */
export function backToLayer(): void {
  const ref = geo.selected;
  if (!ref) return;
  geo.recent = ref;
  selectFeature(null);
  if (geo.activeLayerId !== ref.layerId) browseLayer(ref.layerId);
}

/** The previous or next feature of the layer's current list, from the selected one. */
export function stepFeature(delta: -1 | 1): boolean {
  const layer = geographicLayer(geo.selected?.layerId ?? null);
  if (!layer) return false;
  const rows = listedFeatures(layer);
  const index = rows.findIndex((r) => r.feature.id === geo.selected!.featureId);
  const next = rows[index < 0 ? 0 : index + delta];
  if (!next) return false;
  selectFeature(featureRef(layer, next.feature));
  return true;
}

/** Where `stepFeature` can go: [has previous, has next]. */
export function featureSteps(): [boolean, boolean] {
  const layer = geographicLayer(geo.selected?.layerId ?? null);
  if (!layer) return [false, false];
  const rows = listedFeatures(layer);
  const index = rows.findIndex((r) => r.feature.id === geo.selected!.featureId);
  return index < 0 ? [rows.length > 0, rows.length > 0] : [index > 0, index < rows.length - 1];
}

/** At most this many matches are listed by the search across layers. */
export const GLOBAL_SEARCH_LIMIT = 50;

/** Features of every layer matching the search across layers, visible layers first. */
export function searchAllFeatures(text: string): { matches: { layer: GeographicLayer; entry: GeographicSearchEntry }[]; total: number } {
  void geo.revision;
  const query = { text, field: null };
  if (geographicQueryEmpty(query)) return { matches: [], total: 0 };
  const layers = [...(universe()?.geographicLayers.layers ?? [])].sort((a, b) => Number(layerVisible(b.id)) - Number(layerVisible(a.id)));
  const matches: { layer: GeographicLayer; entry: GeographicSearchEntry }[] = [];
  let total = 0;
  for (const layer of layers) {
    for (const entry of geographicSearchIndex(layer)) {
      if (!geographicQueryMatches(entry, query)) continue;
      total++;
      if (matches.length < GLOBAL_SEARCH_LIMIT) matches.push({ layer, entry });
    }
  }
  return { matches, total };
}

let unsubscribers: (() => void)[] = [];
/** Layers this module set a scene filter on, so it can clear exactly those. */
const filteredLayers = new Set<string>();

function universe(): Universe | null {
  void geo.revision;
  return getUniverse();
}

export function geographicLoads(): readonly GeographicLayerLoad[] {
  return universe()?.geographicLayers.loads ?? [];
}

export function geographicLayer(id: string | null): GeographicLayer | undefined {
  return id ? universe()?.geographicLayers.get(id) : undefined;
}

export function findFeature(ref: GeographicFeatureRef | null): { layer: GeographicLayer; feature: GeographicFeature } | null {
  const layer = geographicLayer(ref?.layerId ?? null);
  const feature = layer?.features.find((f) => f.id === ref!.featureId);
  return layer && feature && layer.body === ref!.bodyName ? { layer, feature } : null;
}

export const featureRef = (layer: GeographicLayer, feature: GeographicFeature): GeographicFeatureRef =>
  ({ layerId: layer.id, featureId: feature.id, bodyName: layer.body });

// ── Layers ──

export function layerVisible(id: string): boolean {
  void geo.revision;
  return getRenderer()?.geographicVectors.isVisible(id) ?? true;
}

export function setLayerVisible(id: string, visible: boolean): void {
  const renderer = getRenderer();
  if (!renderer) return;
  if (!visible && geo.selected?.layerId === id) geo.notice = 'Selection cleared: its layer was hidden.';
  renderer.geographicVectors.setVisible(id, visible);
  geo.revision++;
}

/** Ready layers drawn on the same body as `id`. */
function siblings(id: string): GeographicLayer[] {
  const body = geographicLayer(id)?.body;
  return (universe()?.geographicLayers.layers ?? []).filter((l) => l.body === body);
}

/** Show `id` and hide every other vector layer on its body. Imagery is untouched. */
export function isolateLayer(id: string): void {
  for (const layer of siblings(id)) setLayerVisible(layer.id, layer.id === id);
}

export function isIsolated(id: string): boolean {
  const others = siblings(id);
  return others.length > 1 && others.every((l) => layerVisible(l.id) === (l.id === id));
}

export function showAllLayers(bodyName: string): void {
  for (const layer of universe()?.geographicLayers.layers ?? []) if (layer.body === bodyName) setLayerVisible(layer.id, true);
}

/** Why Fly/Frame cannot reach this layer's body, or null when they can. */
export function navigationUnavailable(layer: GeographicLayer): string | null {
  void geo.revision;
  const bm = getRenderer()?.getBodyMesh(layer.body);
  if (!bm) return `${layer.body} is not in this scene.`;
  if (bm.body.geometryType !== 'Globe') return `${layer.body} is not drawn as a globe, so it has no latitude/longitude surface to fly over.`;
  return null;
}

// ── Features: search, filter, view ──

export function browseLayer(id: string | null): void {
  if (geo.activeLayerId === id) return;
  clearSceneFilters();
  geo.activeLayerId = id;
  geo.query = '';
  geo.field = null;
  geo.inView = null;
  geo.revision++;
}

/** The field filter, or null while it is still incomplete (no value chosen yet). */
function activeField(): GeographicFieldFilter | null {
  const f = geo.field;
  if (!f) return null;
  if (f.kind === 'category' && f.values.length === 0) return null;
  if (f.kind === 'text' && !f.contains.trim()) return null;
  if (f.kind === 'range' && f.min === undefined && f.max === undefined) return null;
  return f;
}

export function listedFeatures(layer: GeographicLayer): GeographicSearchEntry[] {
  void geo.revision;
  const query = { text: geo.query, field: activeField() };
  const inView = geo.inViewOnly ? geo.inView : null;
  const index = geographicSearchIndex(layer);
  if (geographicQueryEmpty(query) && !inView) return index as GeographicSearchEntry[];
  return index.filter((entry) => (!inView || inView.has(entry.feature.id)) && geographicQueryMatches(entry, query));
}

let sceneFilterTimer: ReturnType<typeof setTimeout> | undefined;
/** Apply the list's search and field filter to the scene, after typing settles. */
export function syncSceneFilter(): void {
  clearTimeout(sceneFilterTimer);
  sceneFilterTimer = setTimeout(() => {
    const layer = geographicLayer(geo.activeLayerId);
    const renderer = getRenderer();
    if (!renderer) return;
    const query = { text: geo.query, field: activeField() };
    if (!layer || !geo.sceneFilter || geographicQueryEmpty(query)) { clearSceneFilters(); return; }
    const ids = new Set(geographicSearchIndex(layer).filter((e) => geographicQueryMatches(e, query)).map((e) => e.feature.id));
    if (geo.selected?.layerId === layer.id && !ids.has(geo.selected.featureId)) geo.notice = 'Selection cleared: the scene filter hides it.';
    renderer.geographicVectors.setFeatureFilter(layer.id, ids);
    filteredLayers.add(layer.id);
  }, 150);
}

export function clearSceneFilters(): void {
  clearTimeout(sceneFilterTimer);
  const vectors = getRenderer()?.geographicVectors;
  for (const id of filteredLayers) vectors?.setFeatureFilter(id, null);
  filteredLayers.clear();
}

/** At most this many vertices per feature are projected for the in-view test. */
const VIEW_SAMPLES = 16;
let viewTimer: ReturnType<typeof setInterval> | undefined;
let viewKey = '';

type Vec3 = [number, number, number];
const unitNormal = (p: BodyFixedPosition): Vec3 => {
  const lat = p.latDeg * Math.PI / 180, lon = p.lonDeg * Math.PI / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

interface ViewSample { id: string; positions: BodyFixedPosition[]; axis: Vec3; radius: number }
/** Per immutable layer: each feature's anchor and strided vertices, and the cap (axis, angular radius) bounding them. */
const viewSamples = new WeakMap<GeographicLayer, ViewSample[]>();
function samplesOf(layer: GeographicLayer): ViewSample[] {
  let samples = viewSamples.get(layer);
  if (!samples) {
    samples = layer.features.map((feature) => {
      const all = geographicGeometryPositions(feature.geometry);
      const stride = Math.max(1, Math.ceil(all.length / VIEW_SAMPLES));
      const anchor = geographicFeatureAnchor(feature);
      const positions = [anchor, ...all.filter((_, j) => j % stride === 0)];
      const axis = unitNormal(anchor);
      // Every vertex, not only the sampled ones, bounds the cap.
      const radius = all.reduce((r, p) => Math.max(r, angle(axis, unitNormal(p))), 0);
      return { id: feature.id, positions, axis, radius };
    });
    viewSamples.set(layer, samples);
  }
  return samples;
}

/**
 * Recompute which of the active layer's features are on screen, when the view
 * has moved: the camera, the canvas, or the body itself (it turns under a
 * resting camera). Features whose bounding cap lies wholly past the horizon
 * are not projected at all.
 */
function refreshInView(force = false): void {
  const renderer = getRenderer();
  const layer = geographicLayer(geo.activeLayerId);
  const bm = layer ? renderer?.getBodyMesh(layer.body) : undefined;
  if (!renderer || !layer || !bm) { geo.inView = null; return; }
  const canvas = renderer.renderer.domElement;
  const rotation = bm.bodyToWorldQuaternion(new THREE.Quaternion());
  const key = [layer.id, renderer.camera.matrixWorld.elements.join(','), bm.position.toArray().join(','),
    rotation.toArray().join(','), `${canvas.clientWidth}x${canvas.clientHeight}`].join('|');
  if (!force && key === viewKey) return;
  viewKey = key;
  // The camera in the body's own axes, in km.
  const camera = renderer.camera.position.clone().sub(bm.position).divideScalar(renderer.scaleFactor).applyQuaternion(rotation.invert());
  const distance = camera.length();
  const shape = layer.datum.referenceShape;
  // The smaller radius sees the larger horizon, so nothing visible is culled.
  const radius = shape.kind === 'sphere' ? shape.radiusKm : Math.min(shape.radiiKm[0], shape.radiiKm[2]);
  const direction: Vec3 = [camera.x / distance, camera.y / distance, camera.z / distance];
  const horizon = distance > radius ? Math.acos(radius / distance) + 2 * Math.PI / 180 : Math.PI;
  const owners: string[] = [];
  const positions: BodyFixedPosition[] = [];
  for (const sample of samplesOf(layer)) {
    if (angle(sample.axis, direction) - sample.radius > horizon) continue;
    for (const p of sample.positions) { positions.push(p); owners.push(sample.id); }
  }
  // At decoded terrain height: over a deep floor the datum can be far above what is drawn.
  const projected = positions.length ? renderer.projectGeographicPositions(layer.body, positions, layer.datum, { sampleTerrain: true }) : [];
  const visible = new Set<string>();
  projected?.forEach((p, i) => {
    if (p.facing && p.inFront && p.x >= 0 && p.y >= 0 && p.x <= canvas.clientWidth && p.y <= canvas.clientHeight) visible.add(owners[i]);
  });
  geo.inView = visible;
}

export function setInViewOnly(on: boolean): void {
  geo.inViewOnly = on;
  clearInterval(viewTimer);
  viewKey = '';
  if (on) {
    refreshInView(true);
    // A view-dependent list follows the camera without recomputing every frame.
    viewTimer = setInterval(() => refreshInView(), 400);
  } else geo.inView = null;
}

// ── Selection ──

/**
 * Select a feature from the list or a host. Selecting never moves the camera
 * (docs/navigation.md). A feature on a hidden layer shows its layer first,
 * since a selection must be one the scene can draw and pick.
 */
export function selectFeature(ref: GeographicFeatureRef | null, options: { reveal?: boolean } = {}): void {
  const renderer = getRenderer();
  if (!renderer) return;
  geo.notice = '';
  if (ref && !renderer.geographicVectors.isVisible(ref.layerId)) {
    setLayerVisible(ref.layerId, true);
    geo.notice = `Showing ${geographicLayer(ref.layerId)?.name ?? ref.layerId} to select its feature.`;
  }
  renderer.geographicVectors.setSelected(ref);
  geo.selected = ref;
  if (ref) followSelection(ref);
  if (ref && options.reveal) geo.reveal++;
}

/** The panel's layer is the selected feature's, so Back lands there. */
function followSelection(ref: GeographicFeatureRef): void {
  geo.imageryBody = null;
  if (geo.activeLayerId !== ref.layerId) browseLayer(ref.layerId);
}

/**
 * Whether the selected feature is also a named place (#191): Places indexes
 * every named point, and a click on one selects it there too. Escape then
 * leaves it to the Places order (panels first, then the place and this
 * selection together), as before this panel existed.
 */
export function selectionIsPlace(ref: GeographicFeatureRef | null = geo.selected): boolean {
  return !!ref && !!vs.places?.places.some((p) => p.layer.id === ref.layerId && p.feature.id === ref.featureId);
}

export function clearGeographicSelection(): boolean {
  if (!geo.selected) return false;
  selectFeature(null);
  return true;
}

/** Open Surface layers on the selected feature. */
export function showSelectedDetails(): void {
  const ref = geo.selected;
  if (!ref) return;
  if (!isToolOpen('layers')) openTool('layers');
  followSelection(ref);
}

export function hoverFeature(ref: GeographicFeatureRef | null): void {
  if (sameGeographicFeature(geo.hovered, ref)) return;
  geo.hovered = ref;
  getRenderer()?.geographicVectors.setHovered(ref);
}

// ── Navigation ──

/** Smallest framed span, so a point does not put the camera on the ground. */
const MIN_FRAME_SPAN_KM = 3;

/** Fly (or with `cut`, Frame) to look down over a feature's extent. */
export function goToFeature(ref: GeographicFeatureRef, options: { cut?: boolean } = {}): boolean {
  const found = findFeature(ref);
  if (!found) return false;
  const { layer, feature } = found;
  const reason = navigationUnavailable(layer);
  if (reason) { geo.notice = reason; return false; }
  const extent = geographicFeatureExtent(feature);
  const area = extent.kind === 'polar'
    ? { latDeg: extent.pole === 'north' ? 90 : -90, lonDeg: 0, northSpanDeg: 2 * (90 - Math.abs(extent.boundaryLatDeg)), eastSpanDeg: 0 }
    : (() => {
      const anchor = geographicFeatureAnchor(feature);
      const east = extent.east < extent.west ? extent.east + 360 : extent.east;
      return { latDeg: anchor.latDeg, lonDeg: anchor.lonDeg, northSpanDeg: extent.north - extent.south, eastSpanDeg: east - extent.west };
    })();
  return flyOverSurface(layer.body, area, { datum: layer.datum, minSpanKm: MIN_FRAME_SPAN_KM, ...(options.cut ? { seconds: 0 } : {}) });
}

// ── Scene binding ──

function resetForScene(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
  clearInterval(viewTimer);
  clearTimeout(sceneFilterTimer);
  filteredLayers.clear();
  viewKey = '';
  geo.selected = null;
  geo.hovered = null;
  geo.activeLayerId = null;
  geo.imageryBody = null;
  geo.globalQuery = '';
  geo.showAbout = false;
  geo.recent = null;
  geo.query = '';
  geo.field = null;
  geo.inViewOnly = false;
  geo.sceneFilter = false;
  geo.inView = null;
  geo.notice = '';
  geo.revision++;
}

// However the panel closes, the scene filter and the in-view polling go with
// it; minimizing keeps them.
onToolClose('layers', () => {
  geo.sceneFilter = false;
  clearSceneFilters();
  if (geo.inViewOnly) setInViewOnly(false);
});

// Subscribed at module scope rather than from the panel, which may be closed.
onViewerEvent('load', () => {
  resetForScene();
  const renderer = getRenderer();
  const scene = getUniverse();
  if (!renderer || !scene) return;
  const ready = scene.geographicLayers.layers;
  geo.activeLayerId = ready.length === 1 ? ready[0].id : null;
  unsubscribers.push(
    // A scene click selects without opening anything over the scene; an open
    // panel shows the feature. The callout opens a closed panel.
    renderer.events.on('geographic:select', (ref) => { geo.selected = ref; if (ref) followSelection(ref); }),
    renderer.events.on('geographic:click', () => { geo.notice = ''; }),
    renderer.events.on('geographic:hover', (ref) => { geo.hovered = ref; }),
    scene.events.on('geographic:changed', () => { geo.revision++; }),
  );
});
