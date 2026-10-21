/**
 * Geographic layer browsing (#198): which vector layers are on, which feature
 * is selected, and the list's search and filters. One selection is shared by
 * the 3D scene and the Surface layers panel — a click on either selects the
 * same `(layerId, featureId, bodyName)` reference, the renderer highlights it,
 * and the panel shows its details.
 *
 * Layer visibility and the scene filter are session presentation over the
 * imported data; the layers themselves are never modified. Everything resets
 * when a scene loads.
 */
import {
  geographicFeatureAnchor, geographicFeatureExtent, geographicGeometryPositions, geographicQueryEmpty,
  geographicQueryMatches, geographicSearchIndex,
  type GeographicFeature, type GeographicFieldFilter, type GeographicLayer, type GeographicLayerLoad,
  type GeographicSearchEntry, type Universe,
} from '@cosmolabe/core';
import { sameGeographicFeature, type GeographicFeatureRef } from '@cosmolabe/three';
import { flyOverSurface, getRenderer, onViewerEvent } from './viewer-state.svelte';
import { getUniverse } from './loader';
import { isToolOpen, onToolClose, openTool } from './shell.svelte';

export const geo = $state({
  /** Bumped by anything that changes what the panel shows: loads, visibility, filters. */
  revision: 0,
  selected: null as GeographicFeatureRef | null,
  hovered: null as GeographicFeatureRef | null,
  /** The layer whose features are listed. */
  activeLayerId: null as string | null,
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

/** Recompute which of the active layer's features are on screen, when the view has moved. */
function refreshInView(force = false): void {
  const renderer = getRenderer();
  const layer = geographicLayer(geo.activeLayerId);
  if (!renderer || !layer) { geo.inView = null; return; }
  const canvas = renderer.renderer.domElement;
  const key = `${layer.id}|${renderer.camera.matrixWorld.elements.join(',')}|${canvas.clientWidth}x${canvas.clientHeight}`;
  if (!force && key === viewKey) return;
  viewKey = key;
  const owners: number[] = [];
  const positions = layer.features.flatMap((feature, i) => {
    const all = geographicGeometryPositions(feature.geometry);
    const stride = Math.max(1, Math.ceil(all.length / VIEW_SAMPLES));
    const sample = [geographicFeatureAnchor(feature), ...all.filter((_, j) => j % stride === 0)];
    for (let k = 0; k < sample.length; k++) owners.push(i);
    return sample;
  });
  const projected = renderer.projectGeographicPositions(layer.body, positions, layer.datum);
  const visible = new Set<string>();
  projected?.forEach((p, i) => {
    if (p.facing && p.inFront && p.x >= 0 && p.y >= 0 && p.x <= canvas.clientWidth && p.y <= canvas.clientHeight) {
      visible.add(layer.features[owners[i]].id);
    }
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
  if (ref && options.reveal) geo.reveal++;
}

export function clearGeographicSelection(): boolean {
  if (!geo.selected) return false;
  selectFeature(null);
  return true;
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

// Subscribed at module scope rather than from the panel: a scene click must
// open the panel on the feature whether or not it is already open.
onViewerEvent('load', () => {
  resetForScene();
  const renderer = getRenderer();
  const scene = getUniverse();
  if (!renderer || !scene) return;
  const ready = scene.geographicLayers.layers;
  geo.activeLayerId = ready.length === 1 ? ready[0].id : null;
  unsubscribers.push(
    renderer.events.on('geographic:select', (ref) => { geo.selected = ref; }),
    renderer.events.on('geographic:click', (ref) => {
      // A scene click lists the feature's layer and scrolls to it.
      if (geo.activeLayerId !== ref.layerId) browseLayer(ref.layerId);
      geo.notice = '';
      geo.reveal++;
      if (!isToolOpen('layers')) openTool('layers');
    }),
    renderer.events.on('geographic:hover', (ref) => { geo.hovered = ref; }),
    scene.events.on('geographic:changed', () => { geo.revision++; }),
  );
});
