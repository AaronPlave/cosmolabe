/** Semantic automation over the same definitions and actions as the viewer panels. */
import { validateGeographicCoordinates, validateGeographicLayerStyle, geographicEditFeatureRefId } from '@cosmolabe/core';
import type { MeasurementDefinition } from '@cosmolabe/core';
import type { ViewerControl } from '@cosmolabe/control';
import { measurements, captureSharedMeasurements, installMeasurementDefinitions, selectMeasurement, removeMeasurement } from './spatial-measurements.svelte';
import { validateMeasurementLinkState, validateMeasurementReferences } from './measurement-link-state';
import { geo, geographicLayer, layerVisible, setLayerVisible, selectFeature, goToFeature, navigationUnavailable } from './geographic-layers.svelte';
import { layerStyle, setLayerStyle, flushLayerStyles } from './geographic-styles.svelte';
import { isEditable, applyEdit, edits, createLayer, matchesDrawFrame } from './geographic-editing.svelte';
import { getRenderer, getSceneUniverse, vs, sceneId } from './viewer-state.svelte';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bounded = (value: unknown, max = 32768) => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > max) throw new Error(`definition must be JSON data of at most ${max} characters`);
};
const inScene = (expected?: number) => {
  if (!getSceneUniverse()) throw new Error('No scene is loaded');
  if (expected !== undefined && expected !== sceneId()) throw new Error('the scene changed since this was read');
};
const currentMeasurements = () => captureSharedMeasurements() ?? { version: 1 as const, items: [] as MeasurementDefinition[] };

export const analysisControl: Pick<Required<ViewerControl>, 'listMeasurements' | 'getSelectedMeasurement' | 'upsertMeasurement' | 'restoreMeasurements' | 'removeMeasurement' | 'selectMeasurement' | 'showMeasurement' | 'listGeographicLayers' | 'listGeographicFeatures' | 'getSelectedGeographicFeature' | 'setGeographicLayerVisible' | 'setGeographicLayerStyle' | 'selectGeographicFeature' | 'clearGeographicSelection' | 'gotoGeographicFeature' | 'createAnnotationLayer' | 'editAnnotation'> = {
  listMeasurements: () => copy(currentMeasurements().items),
  getSelectedMeasurement: () => measurements.selectedId,
  upsertMeasurement: (definition, opts) => {
    inScene(opts?.scene); bounded(definition);
    const current = currentMeasurements();
    const items = current.items.filter(m => m.id !== definition.id);
    items.push(definition);
    return analysisControl.restoreMeasurements({ ...current, items }, 'replace', opts);
  },
  restoreMeasurements: (input, mode = 'merge', opts) => {
    inScene(opts?.scene); bounded(input);
    if (mode !== 'merge' && mode !== 'replace') throw new Error('mode must be merge or replace');
    const state = validateMeasurementLinkState(input);
    const current = currentMeasurements();
    const ids = new Set(state.items.map(m => m.id));
    const next = validateMeasurementLinkState({ version: 1,
      items: mode === 'replace' ? state.items : [...current.items.filter(m => !ids.has(m.id)), ...state.items],
      ...(state.selected ? { selected: state.selected } : mode === 'merge' && current.selected ? { selected: current.selected } : {}),
    });
    validateMeasurementReferences(next, getSceneUniverse()!, getRenderer()?.timeController.et ?? vs.et);
    installMeasurementDefinitions(next);
    return true;
  },
  removeMeasurement: (id, opts) => {
    inScene(opts?.scene);
    if (!measurements.items.some(m => m.id === id)) return false;
    removeMeasurement(id); return true;
  },
  selectMeasurement: (id, opts) => {
    inScene(opts?.scene);
    if (id !== null && !measurements.items.some(m => m.id === id)) return false;
    selectMeasurement(id); return true;
  },
  showMeasurement: (id, visible, opts) => {
    inScene(opts?.scene);
    if (typeof visible !== 'boolean') throw new Error('visible must be boolean');
    const state = currentMeasurements(), item = state.items.find(m => m.id === id);
    if (!item) return false;
    item.visible = visible;
    return analysisControl.restoreMeasurements(state, 'replace', opts);
  },
  listGeographicLayers: () => (getSceneUniverse()?.geographicLayers.loads ?? []).map(load => {
    const layer = load.layer;
    return {
      id: load.id, name: layer?.name ?? load.id, body: layer?.body ?? null, frame: layer?.frame ?? null,
      status: load.status, diagnostics: [...load.diagnostics.map(d => ({ code: d.code, severity: d.severity })), ...(getRenderer()?.geographicVectors?.diagnostics ?? []).filter(d => d.layerId === load.id).map(d => ({ code: d.code, severity: 'warning' as const }))],
      features: layer?.features.length ?? 0, visible: !!layer && layerVisible(layer.id), editable: !!layer && isEditable(layer.id),
      navigationUnavailable: layer ? vs.excludedPlaceLayers.includes(layer.id) ? 'Source is excluded.' : navigationUnavailable(layer) : 'The source failed to load or validate.',
      style: layer ? copy(layerStyle(layer.id)) : { version: 1 as const },
    };
  }),
  listGeographicFeatures: (id, opts) => {
    const layer = geographicLayer(id);
    if (!layer) return undefined;
    const offset = opts?.offset ?? 0, limit = opts?.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('offset must be nonnegative; limit must be 1–100');
    return { total: layer.features.length, features: layer.features.slice(offset, offset + limit).map(f => ({ id: f.id, name: typeof f.properties?.name === 'string' ? f.properties.name : f.id, type: f.geometry.type, sourceId: f.sourceId ?? null })) };
  },
  getSelectedGeographicFeature: () => geo.selected ? { layer: geo.selected.layerId, feature: geo.selected.featureId } : null,
  setGeographicLayerVisible: (id, visible, opts) => {
    inScene(opts?.scene);
    if (typeof visible !== 'boolean') throw new Error('visible must be boolean');
    if (!geographicLayer(id) || !getRenderer()) return false;
    setLayerVisible(id, visible); return true;
  },
  setGeographicLayerStyle: (id, input, opts) => {
    inScene(opts?.scene); bounded(input);
    if (!geographicLayer(id) || !getRenderer()) return false;
    const { style, warnings } = validateGeographicLayerStyle(input);
    if (input !== null && warnings.length) throw new Error(warnings.join('; '));
    setLayerStyle(id, input === null ? null : style, { persist: false });
    flushLayerStyles(); return true;
  },
  selectGeographicFeature: (id, feature, opts) => {
    inScene(opts?.scene);
    const layer = geographicLayer(id);
    if (!layer?.features.some(f => f.id === feature) || !getRenderer()) return false;
    if (vs.excludedPlaceLayers.includes(id)) throw new Error('Source is excluded.');
    selectFeature({ layerId: id, featureId: feature, bodyName: layer.body }); return true;
  },
  clearGeographicSelection: () => selectFeature(null),
  gotoGeographicFeature: (id, feature, opts) => {
    inScene(opts?.scene);
    const layer = geographicLayer(id);
    if (!layer?.features.some(f => f.id === feature)) return false;
    const reason = vs.excludedPlaceLayers.includes(id) ? 'Source is excluded.' : navigationUnavailable(layer);
    if (reason) throw new Error(reason);
    return goToFeature({ layerId: id, featureId: feature, bodyName: layer.body }, { cut: opts?.animate === false });
  },
  createAnnotationLayer: (body, name, coordinates, opts) => {
    inScene(opts?.scene); bounded(coordinates);
    if (!getSceneUniverse()?.getBody(body)) return false;
    const validated = validateGeographicCoordinates(coordinates);
    if (!matchesDrawFrame({ body, coordinates: validated })) throw new Error('Annotation coordinates do not match the rendered body frame');
    const id = createLayer({ body, name, coordinates: validated });
    if (!id) throw new Error(edits.message);
    return id;
  },
  editAnnotation: (id, operation, opts) => {
    inScene(opts?.scene); bounded(operation);
    if (!geographicLayer(id) || !isEditable(id)) return false;
    const type = operation?.type;
    if (!['add', 'replace-geometry', 'set-shape', 'move-vertex', 'insert-vertex', 'delete-vertex', 'translate', 'set-properties', 'duplicate', 'delete'].includes(type)) throw new Error('Unsupported annotation operation');
    const featureId = applyEdit(id, operation);
    if (featureId === null) throw new Error(edits.message || 'Annotation edit refused');
    return { featureId, ref: geographicEditFeatureRefId(featureId) };
  },
};
