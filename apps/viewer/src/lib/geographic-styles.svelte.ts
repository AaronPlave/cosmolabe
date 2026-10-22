/**
 * Geographic layer styles in the viewer (#199): the style each layer draws
 * with, the editor's revert point, and where styles are kept.
 *
 * A style is presentation only (core's `GeographicLayerStyle`); the imported
 * data is never modified. Styles are kept in this browser's localStorage,
 * keyed by the layer's catalog and stable layer ID, so they come back on reload
 * and when the same catalog is opened again; they are never written into the
 * catalog. Edits preview live through a short debounce, and the renderer
 * restyles a layer in place rather than rebuilding it.
 */
import {
  geographicStyleIsDefault, validateGeographicLayerStyle, GEOGRAPHIC_STYLE_VERSION,
  type GeographicFeatureStyleOverride, type GeographicLayer, type GeographicLayerStyle,
} from '@cosmolabe/core';
import type { GeographicFeatureRef } from '@cosmolabe/three';
import { getRenderer, onViewerEvent } from './viewer-state.svelte';
import { getUniverse } from './loader';

const STORAGE_KEY = 'cosmolabe-geographic-styles';
/** At most this many layers' styles are kept; the least recently edited go first. */
const MAX_STORED_LAYERS = 64;
/** And at most this much text in all. */
const MAX_STORED_BYTES = 256 * 1024;
/** Edits reach the renderer at most this often while a control is dragged. */
const PREVIEW_MS = 80;

interface StoredStyles {
  version: 1;
  layers: { [key: string]: { style: GeographicLayerStyle; updated: number } };
}

export const geoStyles = $state({
  /** Styles in effect, by layer ID. Absent means catalog defaults. */
  byLayer: {} as Record<string, GeographicLayerStyle>,
  /** The layer open in the style editor. */
  editing: null as string | null,
  /** Why a stored style was partly ignored, by layer ID. */
  warnings: {} as Record<string, string[]>,
  /** False when the browser refused storage; styles then last for this session. */
  persistent: true,
  /** Session draw order of vector layers, by body, earliest drawn on top. */
  order: [] as string[],
});

/** The style when the editor opened, for Revert. */
let snapshot: { layerId: string; style: GeographicLayerStyle | null } | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let pending = new Set<string>();

function storageKey(layer: GeographicLayer): string {
  return `${layer.source.catalog ?? layer.source.identity}::${layer.id}`;
}

function readStored(): StoredStyles {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as StoredStyles : null;
    if (parsed?.version === 1 && parsed.layers && typeof parsed.layers === 'object') return parsed;
  } catch { /* unreadable or unavailable: start empty */ }
  return { version: 1, layers: {} };
}

function writeStored(layer: GeographicLayer, style: GeographicLayerStyle | null): void {
  const stored = readStored();
  const key = storageKey(layer);
  if (!style || geographicStyleIsDefault(style)) delete stored.layers[key];
  else stored.layers[key] = { style, updated: Date.now() };
  // Keep the newest within both bounds.
  const keys = Object.keys(stored.layers).sort((a, b) => stored.layers[b].updated - stored.layers[a].updated);
  for (const old of keys.slice(MAX_STORED_LAYERS)) delete stored.layers[old];
  let text = JSON.stringify(stored);
  while (text.length > MAX_STORED_BYTES && Object.keys(stored.layers).length > 1) {
    const oldest = Object.keys(stored.layers).sort((a, b) => stored.layers[a].updated - stored.layers[b].updated)[0];
    delete stored.layers[oldest];
    text = JSON.stringify(stored);
  }
  try {
    localStorage.setItem(STORAGE_KEY, text);
    geoStyles.persistent = true;
  } catch {
    geoStyles.persistent = false;
  }
}

function layerOf(id: string): GeographicLayer | undefined {
  return getUniverse()?.geographicLayers.get(id);
}

/** Push pending styles to the renderer after the debounce; persist them at the same time. */
function flush(): void {
  clearTimeout(previewTimer);
  previewTimer = undefined;
  const renderer = getRenderer();
  for (const id of pending) {
    const style = geoStyles.byLayer[id] ?? null;
    renderer?.geographicVectors.setStyle(id, style ? $state.snapshot(style) as GeographicLayerStyle : null);
    const layer = layerOf(id);
    if (layer) writeStored(layer, style ? $state.snapshot(style) as GeographicLayerStyle : null);
  }
  pending = new Set();
}

function schedule(id: string): void {
  pending.add(id);
  if (previewTimer === undefined) previewTimer = setTimeout(flush, PREVIEW_MS);
}

export function layerStyle(id: string): GeographicLayerStyle {
  return geoStyles.byLayer[id] ?? { version: GEOGRAPHIC_STYLE_VERSION };
}

/** Replace a layer's style; null or a default style returns it to the catalog defaults. */
export function setLayerStyle(id: string, style: GeographicLayerStyle | null): void {
  if (!style || geographicStyleIsDefault(style)) delete geoStyles.byLayer[id];
  else geoStyles.byLayer[id] = style;
  delete geoStyles.warnings[id];
  schedule(id);
}

/** Change part of a layer's style. */
export function updateLayerStyle(id: string, change: (style: GeographicLayerStyle) => void): void {
  const next = structuredClone($state.snapshot(layerStyle(id))) as GeographicLayerStyle;
  change(next);
  setLayerStyle(id, next);
}

export function hasLocalStyle(id: string): boolean {
  return !!geoStyles.byLayer[id];
}

export function featureOverrideCount(id: string): number {
  return Object.keys(geoStyles.byLayer[id]?.features ?? {}).length;
}

/** One feature's own colour and opacity, or null when it follows the layer. */
export function featureOverride(ref: GeographicFeatureRef | null): GeographicFeatureStyleOverride | null {
  return ref ? geoStyles.byLayer[ref.layerId]?.features?.[ref.featureId] ?? null : null;
}

/** Set or clear (null) one feature's own colour and opacity. An empty one is removed. */
export function setFeatureOverride(ref: GeographicFeatureRef, override: GeographicFeatureStyleOverride | null): void {
  updateLayerStyle(ref.layerId, (style) => {
    const features = { ...style.features };
    if (!override || (override.color === undefined && override.opacity === undefined)) delete features[ref.featureId];
    else features[ref.featureId] = override;
    style.features = Object.keys(features).length ? features : undefined;
  });
}

// ── Presets and common adjustments ──

/**
 * Restrained colours for surface annotations, readable for common colour-vision
 * deficiencies (Okabe–Ito hues) and against both imagery and plain globes.
 */
export const STYLE_PRESETS: readonly { label: string; color: string }[] = [
  { label: 'Sky', color: '#56b4e9' },
  { label: 'Orange', color: '#e69f00' },
  { label: 'Green', color: '#009e73' },
  { label: 'Yellow', color: '#f0e442' },
  { label: 'Pink', color: '#cc79a7' },
  { label: 'White', color: '#ffffff' },
];

/** One colour for every part of the layer: points, lines, outlines and fill. Colouring by a property stops. */
export function setLayerColor(id: string, color: string): void {
  updateLayerStyle(id, (s) => {
    s.rule = null;
    s.point = { ...s.point, color };
    s.line = { ...s.line, color };
    s.polygon = { ...s.polygon, fillColor: color, outlineColor: color };
  });
}

/** The colour the common control shows: what lines, outlines or points draw with. */
export function layerColor(layer: GeographicLayer): string {
  const style = geoStyles.byLayer[layer.id];
  return style?.line?.color ?? style?.polygon?.outlineColor ?? style?.point?.color ?? style?.polygon?.fillColor
    ?? layer.definition.display?.color ?? '#59c5dd';
}

/** Line width for lines and polygon outlines together. */
export function setLayerLineWidth(id: string, widthPx: number): void {
  updateLayerStyle(id, (s) => {
    s.line = { ...s.line, widthPx };
    s.polygon = { ...s.polygon, outlineWidthPx: widthPx };
  });
}

// ── Editor session ──

export function openStyleEditor(id: string | null): void {
  if (geoStyles.editing === id) return;
  flush();
  geoStyles.editing = id;
  snapshot = id ? { layerId: id, style: geoStyles.byLayer[id] ? structuredClone($state.snapshot(geoStyles.byLayer[id])) as GeographicLayerStyle : null } : null;
}

/** True when the open editor has changes since it opened. */
export function editedSinceOpen(): boolean {
  const id = geoStyles.editing;
  if (!id || !snapshot || snapshot.layerId !== id) return false;
  return JSON.stringify(snapshot.style ?? null) !== JSON.stringify(geoStyles.byLayer[id] ? $state.snapshot(geoStyles.byLayer[id]) : null);
}

/** Undo every change since the editor opened. */
export function revertStyleEdits(): void {
  if (!snapshot || snapshot.layerId !== geoStyles.editing) return;
  setLayerStyle(snapshot.layerId, snapshot.style ? structuredClone(snapshot.style) : null);
  flush();
}

/** Back to the catalog's display defaults, single features' colours included. */
export function resetLayerStyle(id: string): void {
  setLayerStyle(id, null);
  flush();
}

// ── Draw order ──

/** The renderer's order before any move: the user's own layers over published data. */
const defaultOrder = (layers: readonly GeographicLayer[]) =>
  [...layers].sort((a, b) => (a.ownership === 'user' ? 0 : 1) - (b.ownership === 'user' ? 0 : 1)).map((l) => l.id);

/** Move a vector layer up (drawn over) or down among the layers on its body, for this session. */
export function moveLayer(id: string, up: boolean): void {
  const universe = getUniverse();
  const layer = layerOf(id);
  if (!universe || !layer) return;
  const all = defaultOrder(universe.geographicLayers.layers);
  const current = [...geoStyles.order.filter((x) => all.includes(x)), ...all.filter((x) => !geoStyles.order.includes(x))];
  const siblings = current.filter((x) => layerOf(x)?.body === layer.body);
  const at = siblings.indexOf(id), to = at + (up ? -1 : 1);
  if (at < 0 || to < 0 || to >= siblings.length) return;
  const swap = siblings[to];
  const i = current.indexOf(id), j = current.indexOf(swap);
  [current[i], current[j]] = [current[j], current[i]];
  geoStyles.order = current;
  getRenderer()?.geographicVectors.setLayerOrder(current);
}

/** Position among the layers on its body, 0 drawn on top, and how many there are. */
export function layerRank(id: string): { index: number; count: number } {
  const universe = getUniverse();
  const layer = layerOf(id);
  if (!universe || !layer) return { index: 0, count: 0 };
  const all = defaultOrder(universe.geographicLayers.layers);
  const current = [...geoStyles.order.filter((x) => all.includes(x)), ...all.filter((x) => !geoStyles.order.includes(x))];
  const siblings = current.filter((x) => layerOf(x)?.body === layer.body);
  return { index: siblings.indexOf(id), count: siblings.length };
}

// ── Scene binding ──

// A loaded layer takes the style last kept for its catalog and ID, validated:
// a stored style from an older build or another tab cannot break drawing.
onViewerEvent('load', () => {
  clearTimeout(previewTimer);
  previewTimer = undefined;
  pending = new Set();
  snapshot = null;
  geoStyles.byLayer = {};
  geoStyles.warnings = {};
  geoStyles.editing = null;
  geoStyles.order = [];
  const universe = getUniverse();
  const renderer = getRenderer();
  if (!universe || !renderer) return;
  const stored = readStored();
  for (const layer of universe.geographicLayers.layers) {
    const entry = stored.layers[storageKey(layer)];
    if (!entry) continue;
    const { style, warnings } = validateGeographicLayerStyle(entry.style);
    if (warnings.length) geoStyles.warnings[layer.id] = warnings;
    if (geographicStyleIsDefault(style)) continue;
    geoStyles.byLayer[layer.id] = style;
    renderer.geographicVectors.setStyle(layer.id, style);
  }
});
