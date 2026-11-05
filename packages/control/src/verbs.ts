import type { MeasurementDefinition, GeographicLayerStyle, GeographicEditOperation, GeographicCoordinates } from '@cosmolabe/core';
/**
 * The verb table — one vocabulary, three faces.
 *
 * The typed `ViewerControl` interface is what an embed host drives. The
 * `verb arg…` text language is what a saved program, a scene script or a golden
 * is written in. A command palette is a third rendering of the same list. All
 * three are this table: dispatch is table-driven, with no `switch` anywhere to
 * drift from it.
 *
 * ## Vocabulary policy
 *
 * Cosmographia's `cosmoscripting.Cosmo()` is a Python host object, not a
 * language, so mirroring it fixes *spelling*, not scope. Three rules:
 *
 * - Cosmographia has the concept and a workable shape → take their name
 *   (`displayNote`, `setTimeRate`, `wait`, `pointAtObject`, `setFov`).
 * - Cosmographia is finer-grained than us → take their shape; finer-grained is
 *   strictly more expressive (`showTrajectory <object> on|off` beside our
 *   global `setLayer trajectories off`).
 * - We have something they don't → our name, no apology (`setLayer`,
 *   `viewpoint`, `select`, `setFrame` over our eight camera frames).
 *
 * The mapping table lives in `docs/scripting.md`.
 */
import type {
  CircleDirection,
  ScriptCancelSignal,
  ScriptReadinessRequest,
  FlightPath,
  ScriptTime,
  ScriptVec3,
  SurfaceView,
  VerbValue,
  ViewerControl,
} from './contracts.js';
import { composeView } from './compose.js';
import type { Predicate, StateDomain } from './outcome.js';
import { etFromCalendarString } from '@cosmolabe/core';

/**
 * The camera frames `setFrame` accepts.
 *
 * Duplicated from `CameraModeName` in `@cosmolabe/three` rather than imported:
 * this package is the vocabulary and takes no dependencies, least of all on a
 * renderer. The duplication is pinned, not trusted —
 * `apps/viewer/src/lib/__tests__/viewer-control.test.ts` asserts these ids are
 * exactly `Object.values(CameraModeName)`, in the one workspace that can see
 * both.
 */
export const FRAME_MODES = [
  { id: 'free-orbit', label: 'Free orbit' },
  { id: 'sc-fixed', label: 'Spacecraft-fixed' },
  { id: 'body-fixed', label: 'Body-fixed' },
  { id: 'lvlh', label: 'LVLH' },
  { id: 'chase', label: 'Chase' },
  { id: 'surface', label: 'Surface' },
  { id: 'surface-explorer', label: 'Surface explorer' },
  { id: 'instrument', label: 'Instrument' },
] as const;

/**
 * The layers `setLayer` accepts.
 *
 * Pinned against the viewer's `DISPLAY_OPTIONS` by the same test, for the same
 * reason.
 */
export const LAYERS = [
  { id: 'trajectories', label: 'trajectories' },
  { id: 'labels', label: 'labels' },
  { id: 'grid', label: 'grid' },
  { id: 'axes', label: 'axes' },
  { id: 'sensors', label: 'sensors' },
  { id: 'sensorLabels', label: 'sensor labels' },
] as const;

/** The paths `flyTo` accepts. */
export const FLIGHT_PATHS: readonly FlightPath[] = ['direct', 'overview'];

/** The views `gotoCoordinates` accepts. */
export const SURFACE_VIEWS: readonly SurfaceView[] = ['overhead', 'oblique', 'surface'];

const FRAME_MODE_IDS = FRAME_MODES.map((m) => m.id);
const LAYER_IDS = LAYERS.map((l) => l.id);

export type ParamType =
  /** Names a scene object. Passed to the host verbatim. */
  | 'activity'
  | 'object'
  /** Names a catalog viewpoint. Passed verbatim. */
  | 'viewpoint'
  /** A place's stable `ref` (`ScriptPlace.ref`). Passed verbatim. */
  | 'place'
  /** An imagery layer ID on the body the verb names. Passed verbatim. */
  | 'imagery'
  | 'event-query'
  | 'event-result'
  | 'instrument'
  | 'measurement'
  | 'geographic-layer'
  | 'geographic-feature'
  /** Free text — a note, a screenshot label. */
  | 'text'
  /** One of `values`. */
  | 'enum'
  | 'number'
  | 'boolean'
  | 'time'
  | 'vector';

export interface VerbParam {
  readonly name: string;
  readonly type: ParamType;
  readonly optional?: boolean;
  /** Allowed values, for `type: 'enum'`. */
  readonly values?: readonly string[];
}

/** A ready-made invocation, for a palette or a keymap to offer. */
export interface VerbPreset {
  /** Dotted id, stable across renamings of the label. */
  readonly id: string;
  readonly label: string;
  /** Argument text completing `<verb> <args>`; parses on its own. */
  readonly args: string;
}

export interface VerbSpec {
  readonly name: string;
  readonly params: readonly VerbParam[];
  readonly category: 'Scene' | 'Time' | 'Camera' | 'Display' | 'Capture' | 'Sequencing' | 'Analysis' | 'Authoring';
  /** Reversible local scene writes still require host authoring permission. */
  readonly sceneEdit?: boolean;
  readonly help: string;
  /** The `ViewerControl` method this verb needs. Missing on a host → located error. */
  readonly method: keyof ViewerControl;
  /**
   * What a `false` return means, so the error can suggest a real name.
   * Absent when `false` is not about a name (`setFov` out of range, say).
   */
  readonly resolvesName?: 'object' | 'viewpoint' | 'activity' | 'place' | 'imagery';
  readonly presets?: readonly VerbPreset[];
  /** Table-driven dispatch. `args` are already coerced to `params`' types. */
  invoke(host: ViewerControl, args: readonly VerbValue[], signal?: ScriptCancelSignal): unknown;
  /** What the operation changes and how its result is observed; required, so no write goes unclassified. */
  readonly contract: OperationContract;
}

/**
 * An operation's behaviour contract (#345), owned by the operation rather than
 * by any one caller. Ask, receipts, scripts' tests and the benchmark read it;
 * none of them keeps its own list of which names write, how to confirm them or
 * what they invalidate.
 */
export interface OperationContract {
  /** Capability ID namespace: `<namespace>.<name>` is the stable ID. */
  readonly namespace: string;
  /** State domains the operation changes. Empty for reads and pure sequencing (`wait`). */
  readonly writes: readonly StateDomain[];
  /**
   * The state it must leave, as predicates over shared reads, from its own
   * input (`data`: what the operation itself returned, for operations that
   * observe their own result). An empty list means the result cannot be
   * observed: the call is never reported verified.
   */
  readonly expect?: (args: Readonly<Record<string, unknown>>, host: ViewerControl, data?: unknown) => readonly Predicate[];
  /** Why the result cannot be observed, when there is no read for it. */
  readonly unobservable?: string;
  /** Reads a `state` predicate about this operation may call. */
  readonly observes?: readonly (keyof ViewerControl)[];
  /** Input variants that destroy saved state: exact-call confirmation, never a retry. */
  readonly destructive?: (args: Readonly<Record<string, unknown>>) => boolean;
  /** Same input twice leaves the same state. Writes are still never retried automatically. */
  readonly idempotent?: boolean;
  /** What a planner needs beyond the description; offered only while the operation is available. */
  readonly guide?: string;
}

/** Register an operation beside the built-in table (a plugin, a host feature). Returns its removal. */
export function registerVerb(spec: VerbSpec): () => void {
  if (VERBS.has(spec.name)) throw new Error(`Verb ${spec.name} is already registered`);
  // An operation without a contract is an unclassified mutation: refused, not guessed.
  if (!spec.contract || !Array.isArray(spec.contract.writes) || !spec.contract.namespace) throw new Error(`Verb ${spec.name} needs a contract: namespace, writes, and expect or unobservable`);
  if (spec.contract.writes.length && !spec.contract.expect && !spec.contract.unobservable) throw new Error(`Verb ${spec.name} writes ${spec.contract.writes.join(', ')}: its contract must say how the result is observed (expect) or why it cannot be (unobservable)`);
  (VERBS as Map<string, VerbSpec>).set(spec.name, spec);
  return () => { if (VERBS.get(spec.name) === spec) (VERBS as Map<string, VerbSpec>).delete(spec.name); };
}

// Contract helpers: predicates over the shared reads.
const s = (v: unknown) => typeof v === 'string' ? v : '';
const parsed = (v: unknown): Record<string, unknown> => { try { const o = JSON.parse(String(v)); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const state = (read: keyof ViewerControl, args: readonly unknown[], path: string, equals: unknown): Predicate => ({ p: 'state', read, args, path, equals });
const opaque = (namespace: string, writes: readonly StateDomain[], unobservable: string): OperationContract => ({ namespace, writes, unobservable, expect: () => [] });
const RELATIVE = 'a relative camera move has no absolute end state; state the intended view (inView, range) as a goal';
const eventRef = (v: unknown) => parsed(v) as { query?: string; id?: string };

// Coerced-argument accessors. `parse` has already checked arity and type, so
// these assert rather than validate — a mismatch here is a bug in the table
// (a `params` entry and an `invoke` that disagree), not bad input.
const str = (v: VerbValue): string => v as string;
const optStr = (v: VerbValue): string | undefined => v as string | undefined;
const num = (v: VerbValue): number => v as number;
const optNum = (v: VerbValue): number | undefined => v as number | undefined;
const bool = (v: VerbValue): boolean => v as boolean;
const time = (v: VerbValue): ScriptTime => v as ScriptTime;
const vec = (v: VerbValue): ScriptVec3 => v as ScriptVec3;
const optVec = (v: VerbValue): ScriptVec3 | undefined => v as ScriptVec3 | undefined;

const FRAME_PRESETS: readonly VerbPreset[] = FRAME_MODES.map((m) => ({
  id: `frame.${m.id}`,
  label: `${m.label} frame`,
  args: m.id,
}));

// Both directions, because a palette entry's label depends on which way the
// layer is currently set — which the port's read side is what finally makes
// derivable (`vs.showTrajectories ? 'Hide trajectories' : 'Show trajectories'`).
const LAYER_PRESETS: readonly VerbPreset[] = LAYERS.flatMap((l) => [
  { id: `layer.${l.id}.on`, label: `Show ${l.label}`, args: `${l.id} on` },
  { id: `layer.${l.id}.off`, label: `Hide ${l.label}`, args: `${l.id} off` },
]);

const CIRCLE_DIRECTIONS: readonly (readonly [string, CircleDirection])[] = [
  ['Right', 'right'],
  ['Left', 'left'],
  ['Up', 'up'],
  ['Down', 'down'],
];

/** JSON is a bounded data token, parsed without eval and validated by the shared domain action. */
function data<T>(value: VerbValue): T {
  if (typeof value !== 'string' || value.length > 32768) throw new Error('JSON data must be a string of at most 32768 characters');
  return JSON.parse(value) as T;
}
const measurement = { name: 'id', type: 'measurement' } as const;
const geoLayer = { name: 'layer', type: 'geographic-layer' } as const;
const geoFeature = { name: 'feature', type: 'geographic-feature' } as const;
const json = { name: 'json', type: 'text' } as const;
const visible = { name: 'visible', type: 'boolean' } as const;
const modernVerbs: readonly VerbSpec[] = [
  { name: 'pinGroundPoint', contract: { namespace: 'spatial', writes: ['probe'], idempotent: true, expect: a => [{ p: 'probeUnder', object: s(a.object), ...(a.policy ? { policy: a.policy as 'reference' | 'rendered' | 'terrain' } : {}) }, { p: 'probeDrawn' }], guide: 'A pick marker on the ground under a vehicle: pinGroundPoint with its exact entity name and no policy (rendered, the drawn ground) computes the current radial sub-point on its active parent (not camera pixels or named sites). It is transient display, needs no saved layer, and is a snapshot, not a follower: a point the person asks for afterwards ("place a point", "save it") is a saved annotation at the pin, made with geographic.editAnnotation (describe it for its notes), not the pin again. Report the epoch, source/datum and whether the surface is a reference shape or physical terrain.' }, category: 'Display', method: 'pinGroundPoint', params: [{ name: 'object', type: 'object' }, { name: 'policy', type: 'enum', values: ['rendered','reference','terrain'], optional: true }], help: 'Pin the entity’s current radial sub-point on its active parent through native Point Probe. Reversible display, no saved layer. rendered (the default) is the ground as drawn: use it for "on the ground"; reference is the ellipsoid only, when the person asks for the reference shape; terrain refuses without physical terrain evidence. Preserves camera/time. Inspect getProbePoint afterward.', invoke: (h,a) => { const r = h.pinGroundPoint!(str(a[0]), optStr(a[1]) as import('./contracts.js').ScriptSurfacePolicy | undefined); if (r.status !== 'available') throw new Error(`Ground projection ${r.status}: ${r.reason}`); return r; } },
  { name: 'clearProbePoint', contract: { namespace: 'spatial', writes: ['probe'], idempotent: true, observes: ['getProbePoint'], expect: () => [state('getProbePoint', [], '', null)] }, category: 'Display', method: 'clearProbePoint', params: [], help: 'Clear the transient Point Probe pin without changing saved annotations.', invoke: h => h.clearProbePoint!() },

  { name: 'selectPlace', contract: { namespace: 'places', writes: ['selection'], idempotent: true, expect: a => [{ p: 'place', id: s(a.place) || null }] }, category: 'Scene', method: 'selectPlace', params: [{ name: 'place', type: 'place' }], help: 'Inspect a stable place without moving the camera; empty ref clears selection.', invoke: (h,a) => h.selectPlace!(str(a[0]) || null) },
  { name: 'setPlaceSourceEnabled', contract: { namespace: 'places', writes: ['places'], idempotent: true, observes: ['listPlaceSources'], expect: a => [state('listPlaceSources', [], `[id=${s(a.layer)}].enabled`, a.enabled)] }, category: 'Display', method: 'setPlaceSourceEnabled', params: [geoLayer, { name: 'enabled', type: 'boolean' }], help: 'Include or exclude an exact place source in shared search and navigation.', invoke: (h,a) => h.setPlaceSourceEnabled!(str(a[0]), bool(a[1])) },
  { name: 'showPlaceLabels', contract: { namespace: 'places', writes: ['places'], idempotent: true, observes: ['listPlaceSources'], expect: a => [state('listPlaceSources', [], `[id=${s(a.layer)}].labelsVisible`, a.visible)] }, category: 'Display', method: 'showPlaceLabels', params: [geoLayer, visible], help: 'Show or hide source labels independently of search inclusion.', invoke: (h,a) => h.showPlaceLabels!(str(a[0]), bool(a[1])) },
  { name: 'upsertMeasurement', contract: { namespace: 'measurements', writes: ['measurements'], idempotent: true, observes: ['listMeasurements'], expect: a => { const id = parsed(a.json).id; return typeof id === 'string' ? [state('listMeasurements', [], `[id=${id}].id`, id)] : []; } }, sceneEdit: true, category: 'Authoring', method: 'upsertMeasurement', params: [json], help: 'Upsert a validated semantic measurement by stable ID; preserve other definitions. JSON: {id,kind:distance|direction|angle|velocity|axes|vector-angle,source,target,vertex:null,visible:true}; entity endpoints are {kind:entity,bodyName:exact scene name}. Entity distances are centre distances, not terrain clearance.', invoke: (h,a) => h.upsertMeasurement!(data<MeasurementDefinition>(a[0])) },
  { name: 'restoreMeasurements', contract: { namespace: 'measurements', writes: ['measurements'], destructive: a => a.mode === 'replace', observes: ['listMeasurements'], expect: a => { const items = parsed(a.json).items; return Array.isArray(items) ? items.slice(0, 8).flatMap(i => typeof i?.id === 'string' ? [state('listMeasurements', [], `[id=${i.id}].id`, i.id)] : []) : []; } }, sceneEdit: true, category: 'Authoring', method: 'restoreMeasurements', params: [json, { name: 'mode', type: 'enum', values: ['merge','replace'], optional: true }], help: 'Restore version 1 measurement definitions; merge by default. Explicit replace is destructive and requires confirmation.', invoke: (h,a) => h.restoreMeasurements!(data(a[0]), optStr(a[1]) as 'merge' | 'replace' | undefined) },
  { name: 'removeMeasurement', contract: { namespace: 'measurements', writes: ['measurements'], destructive: () => true, observes: ['listMeasurements'], expect: a => [state('listMeasurements', [], `[id=${s(a.id)}].id`, null)] }, category: 'Authoring', method: 'removeMeasurement', params: [measurement], help: 'Remove one saved measurement by ID.', invoke: (h,a) => h.removeMeasurement!(str(a[0])) },
  { name: 'selectMeasurement', contract: { namespace: 'measurements', writes: ['selection'], idempotent: true, observes: ['getSelectedMeasurement'], expect: a => [state('getSelectedMeasurement', [], '', s(a.id) || null)] }, category: 'Analysis', method: 'selectMeasurement', params: [measurement], help: 'Select a measurement; an empty ID clears selection.', invoke: (h,a) => h.selectMeasurement!(str(a[0]) || null) },
  { name: 'showMeasurement', contract: { namespace: 'measurements', writes: ['measurements'], idempotent: true, observes: ['listMeasurements'], expect: a => [state('listMeasurements', [], `[id=${s(a.id)}].visible`, a.visible)] }, category: 'Display', method: 'showMeasurement', params: [measurement, visible], help: 'Show or hide a saved measurement.', invoke: (h,a) => h.showMeasurement!(str(a[0]), bool(a[1])) },
  { name: 'showGeographicLayer', contract: { namespace: 'geographic', writes: ['geographic'], idempotent: true, observes: ['listGeographicLayers'], expect: a => [state('listGeographicLayers', [], `[id=${s(a.layer)}].visible`, a.visible)] }, category: 'Display', method: 'setGeographicLayerVisible', params: [geoLayer, visible], help: 'Show or hide one geographic layer.', invoke: (h,a) => h.setGeographicLayerVisible!(str(a[0]), bool(a[1])) },
  { name: 'setGeographicLayerStyle', contract: { namespace: 'geographic', writes: ['geographic'], idempotent: true, observes: ['listGeographicLayers'], expect: a => Object.entries(parsed(a.json)).map(([k, v]) => state('listGeographicLayers', [], `[id=${s(a.layer)}].style.${k}`, v)) }, category: 'Display', method: 'setGeographicLayerStyle', params: [geoLayer, json], help: 'Apply a validated version 1 layer style; null restores catalog style. Does not save local preferences.', invoke: (h,a) => h.setGeographicLayerStyle!(str(a[0]), data<GeographicLayerStyle | null>(a[1])) },
  { name: 'selectGeographicFeature', contract: { namespace: 'geographic', writes: ['selection'], idempotent: true, expect: a => [{ p: 'featureSelected', layer: s(a.layer), feature: s(a.feature) }] }, category: 'Scene', method: 'selectGeographicFeature', params: [geoLayer, geoFeature], help: 'Select a stable feature without moving the camera.', invoke: (h,a) => h.selectGeographicFeature!(str(a[0]), str(a[1])) },
  { name: 'clearGeographicSelection', contract: { namespace: 'geographic', writes: ['selection'], idempotent: true, observes: ['getSelectedGeographicFeature'], expect: () => [state('getSelectedGeographicFeature', [], '', null)] }, category: 'Scene', method: 'clearGeographicSelection', params: [], help: 'Clear geographic feature selection.', invoke: h => h.clearGeographicSelection!() },
  { name: 'gotoGeographicFeature', contract: opaque('geographic', ['camera'], 'feature-extent framing has no projection read'), category: 'Camera', method: 'gotoGeographicFeature', params: [geoLayer, geoFeature, { name: 'animate', type: 'boolean', optional: true }], help: 'Use the existing feature extent navigation; off cuts to the view.', invoke: (h,a) => h.gotoGeographicFeature!(str(a[0]), str(a[1]), { animate: a[2] as boolean | undefined }) },
  { name: 'createAnnotationLayer', contract: { namespace: 'geographic', writes: ['geographic'], observes: ['listGeographicLayers'], expect: a => [state('listGeographicLayers', [], `[name=${s(a.name)}].body`, s(a.body))], guide: 'No editable layer is not an impossibility: create one with the conventions getSpatialContext returns for the body, then read getSpatialContext again for the new layer ID.' }, sceneEdit: true, category: 'Authoring', method: 'createAnnotationLayer', params: [{ name: 'body', type: 'object' }, { name: 'name', type: 'text' }, json], help: 'Create an annotation layer. Use explicit body/frame/coordinate conventions. JSON coordinates: {frame:body-fixed frame,latitude:planetocentric,longitudeDirection:east,longitudeDomain:-180..180,referenceShape:{kind:ellipsoid,radiiKm:[x,y,z]}}. Angles are degrees. Use body frame from layer/surface inventory; never invent a transform.', invoke: (h,a) => h.createAnnotationLayer!(str(a[0]), str(a[1]), data<GeographicCoordinates>(a[2])) },
  { name: 'editAnnotation', contract: { namespace: 'geographic', writes: ['geographic'], destructive: a => { const op = parsed(a.json); return !op.type || op.type === 'delete'; }, observes: ['listGeographicFeatures'], expect: a => { const op = parsed(a.json) as { type?: string; geometry?: { type?: string; coordinates?: unknown } }; const c = op.geometry?.coordinates; return (op.type === 'add' || op.type === 'replace-geometry') && op.geometry?.type === 'Point' && Array.isArray(c) ? [state('listGeographicFeatures', [s(a.layer), { limit: 100 }], `features[point=${c.join(',')}].type`, 'Point')] : []; }, guide: 'Saving a point at a pin: copy the converted [longitude, latitude] from getProbePoint annotation (never geodetic latitudes into a planetocentric layer), add exactly one Point; select it only when the person asks. Reuse a matching saved point unless another is asked for, and keep the pin.' }, sceneEdit: true, category: 'Authoring', method: 'editAnnotation', params: [geoLayer, json], help: 'Edit a saved annotation. Apply one bounded edit with normal validation and undo. Catalog layers remain read-only; delete requires confirmation. JSON operations: {type:add,geometry:{type:Point,coordinates:[longitude,latitude]},properties:{name:text}}, {type:delete,featureId:original sourceId}, {type:replace-geometry,featureId,geometry}, or {type:set-properties,featureId,properties}. Use the original typed sourceId, not its prefixed reference.', invoke: (h,a) => h.editAnnotation!(str(a[0]), data<GeographicEditOperation>(a[1])) },
  { name: 'setSurfaceAppearance', contract: { namespace: 'surface', writes: ['surface'], idempotent: true, observes: ['getSurfaceAppearance'], expect: a => [...Object.entries(parsed(a.json)).map(([k, v]) => state('getSurfaceAppearance', [s(a.body)], `settings.${k}`, v)), { p: 'ready', kind: 'terrain', body: s(a.body) }], guide: 'Colouring terrain by elevation means baseColor elevation (a palette only shows in that mode); enabling an imagery layer is a separate choice. A setting that holds while terrain data is not yet drawn is partial, not done.' }, category: 'Display', method: 'setSurfaceAppearance', params: [{ name: 'body', type: 'object' }, json], help: 'Patch supported physical terrain appearance. JSON may contain hillshade:boolean, contours:boolean, baseColor:imagery|elevation|neutral, palette:terrain|blue-gold|grayscale, minKm:number, maxKm:number, imageryAmount:number, azimuthDeg:number, elevationDeg:number, contrast:number. Read current settings first. A palette only appears when baseColor is elevation: select that mode for requested elevation coloring. Enabling an imagery layer is separate from choosing the base color; clarify genuinely conflicting final-style requests. Changes no terrain geometry or scientific data.', invoke: (h,a) => h.setSurfaceAppearance!(str(a[0]), data(a[1])) },
  { name: 'waitUntilReady', contract: { namespace: 'readiness', writes: [], idempotent: true }, category: 'Sequencing', method: 'waitUntilReady', params: [json, { name: 'timeoutSeconds', type: 'number', optional: true }], help: 'Wait for an explicit observed readiness predicate, failing transparently unless ready; no wall-clock fallback. JSON event predicate: {kind:event,reference:{scene,query,id,revision},et:number,policy:timeline|native-draw}. Others: {kind:assets}, {kind:terrain,body}, {kind:imagery,body,layer}, {kind:cube-base,body}.', invoke: async (h,a,signal) => {
    const result = await h.waitUntilReady!(data<ScriptReadinessRequest>(a[0]), { timeoutMs: a[1] === undefined ? undefined : num(a[1]) * 1000, signal });
    if (result.status !== 'ready') throw new Error(`${result.status}: ${result.missing.join('; ')}`);
    return result;
  } },
];

export const VERB_LIST: readonly VerbSpec[] = [
  ...modernVerbs,
  { name: 'selectActivity', contract: { namespace: 'activities', writes: ['selection'], idempotent: true, expect: a => [{ p: 'activity', id: s(a.activity) }] }, params: [{ name: 'activity', type: 'activity' }], category: 'Time', method: 'selectActivity', resolvesName: 'activity',
    help: 'Select an activity by stable ID without seeking or moving the camera.', invoke: (h, a) => h.selectActivity!(str(a[0])) },
  { name: 'seekActivity', contract: { namespace: 'activities', writes: ['time'], idempotent: true, expect: (a, h) => { const act = h.listActivities?.().find(x => x.id === a.activity); const et = a.edge === 'end' ? act?.end : act?.start; return et === undefined || h.isPlaying() ? [] : [{ p: 'epoch', et }]; }, guide: 'Seeking does not pause. To show an activity, pause first, then select and seek it, then frame its vehicle or its referenced viewpoint; seeking alone does not present it. Leave playback running only when asked to play.' }, params: [{ name: 'activity', type: 'activity' }, { name: 'edge', type: 'enum', values: ['start', 'end'], optional: true }],
    category: 'Time', method: 'seekActivity', resolvesName: 'activity', help: 'Seek an activity edge; both edges of a milestone mean its one epoch.',
    invoke: (h, a) => h.seekActivity!(str(a[0]), optStr(a[1]) as 'start' | 'end' | undefined) },
  { name: 'navigateActivity', contract: opaque('activities', ['selection'], 'which activity comes next is the viewer\'s ordering; read the selected activity'), params: [{ name: 'direction', type: 'enum', values: ['previous', 'next'] }, { name: 'vehicle', type: 'object', optional: true }, { name: 'kind', type: 'enum', values: ['flight', 'drive', 'hop', 'descent', 'landing', 'phase', 'other'], optional: true }],
    category: 'Time', method: 'navigateActivity', help: 'Select previous/next in start/end/ID order, optionally within a vehicle and kind. Does not seek.',
    invoke: (h, a) => h.navigateActivity!(str(a[0]) as 'previous' | 'next', { vehicle: optStr(a[1]), kind: optStr(a[2]) }) },

  // ── Scene ──
  {
    name: 'gotoObject',
    contract: { namespace: 'camera', writes: ['camera'], expect: a => [{ p: 'inView', object: s(a.object) }] },
    params: [
      { name: 'object', type: 'object' },
      { name: 'seconds', type: 'number', optional: true },
    ],
    category: 'Scene',
    method: 'gotoObject',
    resolvesName: 'object',
    help: 'Jump to an object; give seconds to fly there directly instead.',
    invoke: (host, a) =>
      host.gotoObject(str(a[0]), a[1] === undefined ? undefined : { seconds: num(a[1]) }),
  },
  {
    name: 'select',
    contract: { namespace: 'scene', writes: ['selection'], idempotent: true, expect: a => [{ p: 'selected', object: s(a.object) }] },
    params: [{ name: 'object', type: 'object' }],
    category: 'Scene',
    method: 'select',
    resolvesName: 'object',
    help: 'Select an object — what the info panel shows.',
    invoke: (host, a) => host.select(str(a[0])),
  },
  {
    name: 'deselect',
    contract: { namespace: 'scene', writes: ['selection'], idempotent: true, expect: () => [{ p: 'selected', object: null }] },
    params: [],
    category: 'Scene',
    method: 'deselect',
    help: 'Clear the selection.',
    invoke: (host) => host.deselect(),
  },
  {
    name: 'track',
    contract: { namespace: 'camera', writes: ['camera'], idempotent: true, expect: a => [{ p: 'tracked', object: s(a.object) }] },
    params: [{ name: 'object', type: 'object' }],
    category: 'Camera',
    method: 'track',
    resolvesName: 'object',
    help: 'Make an object the camera’s anchor without moving the camera.',
    invoke: (host, a) => host.track(str(a[0])),
  },
  {
    name: 'untrack',
    contract: { namespace: 'camera', writes: ['camera'], idempotent: true, expect: () => [{ p: 'tracked', object: null }] },
    params: [],
    category: 'Camera',
    method: 'untrack',
    help: 'Release the tracked object. The camera stays where it is.',
    invoke: (host) => host.untrack(),
  },
  {
    name: 'frameObject',
    contract: { namespace: 'camera', writes: ['camera'], idempotent: true, expect: (a, h) => { const o = s(a.object) || h.getTracked(); return o ? [{ p: 'tracked', object: o }, { p: 'inView', object: o }] : []; } },
    params: [{ name: 'object', type: 'object', optional: true }],
    category: 'Camera',
    method: 'frameObject',
    resolvesName: 'object',
    help: 'Cut to a view that fits an object (default: the tracked one), and track it.',
    invoke: (host, a) => host.frameObject(optStr(a[0])),
  },
  {
    name: 'flyTo',
    contract: { namespace: 'camera', writes: ['camera'], expect: a => [{ p: 'tracked', object: s(a.object) }, { p: 'inView', object: s(a.object) }] },
    params: [
      { name: 'object', type: 'object' },
      { name: 'path', type: 'enum', values: FLIGHT_PATHS, optional: true },
      { name: 'seconds', type: 'number', optional: true },
    ],
    category: 'Camera',
    method: 'flyTo',
    resolvesName: 'object',
    help: `Fly to an object and track it (${FLIGHT_PATHS.join(' or ')}). Returns at once; follow with wait.`,
    invoke: (host, a) =>
      host.flyTo(str(a[0]), {
        ...(a[1] === undefined ? {} : { path: str(a[1]) as FlightPath }),
        ...(a[2] === undefined ? {} : { seconds: num(a[2]) }),
      }),
  },
  {
    name: 'jumpTo',
    contract: { namespace: 'camera', writes: ['camera'], idempotent: true, expect: a => [{ p: 'tracked', object: s(a.object) }, { p: 'inView', object: s(a.object) }] },
    params: [{ name: 'object', type: 'object' }],
    category: 'Camera',
    method: 'jumpTo',
    resolvesName: 'object',
    help: 'Cut to the view a flight to an object would land on, and track it.',
    invoke: (host, a) => host.jumpTo(str(a[0])),
  },
  {
    name: 'gotoCoordinates',
    contract: opaque('places', ['camera'], 'a surface coordinate view has no projection read'),
    params: [
      { name: 'object', type: 'object' },
      { name: 'latitude', type: 'number' },
      { name: 'longitude', type: 'number' },
      { name: 'view', type: 'enum', values: SURFACE_VIEWS, optional: true },
      { name: 'seconds', type: 'number', optional: true },
      { name: 'rangeKm', type: 'number', optional: true },
    ],
    category: 'Camera',
    method: 'gotoCoordinates',
    resolvesName: 'object',
    help: `Go to a place on a body by planetocentric latitude and east longitude, in degrees (${SURFACE_VIEWS.join(', ')}). Cuts; give seconds to fly.`,
    invoke: (host, a) =>
      host.gotoCoordinates(str(a[0]), num(a[1]), num(a[2]), {
        ...(a[3] === undefined ? {} : { view: str(a[3]) as SurfaceView }),
        ...(a[4] === undefined ? {} : { seconds: num(a[4]) }),
        ...(a[5] === undefined ? {} : { rangeKm: num(a[5]) }),
      }),
  },
  {
    name: 'stopFlight',
    contract: { namespace: 'camera', writes: ['camera'], idempotent: true, observes: ['getFlight'], expect: () => [state('getFlight', [], '', null)] },
    params: [],
    category: 'Camera',
    method: 'stopFlight',
    help: 'End a flight where it is, tracking what it was flying to.',
    invoke: (host) => host.stopFlight(),
  },
  {
    name: 'pointAtObject',
    contract: { namespace: 'camera', writes: ['camera'], expect: a => [{ p: 'inView', object: s(a.object) }] },
    params: [{ name: 'object', type: 'object' }],
    category: 'Camera',
    method: 'pointAtObject',
    resolvesName: 'object',
    help: 'Aim the camera at an object while still orbiting what it tracks.',
    invoke: (host, a) => host.pointAtObject(str(a[0])),
  },
  {
    name: 'viewpoint',
    contract: opaque('camera', ['camera', 'time'], 'an authored viewpoint pose has no read to compare against'),
    params: [{ name: 'name', type: 'viewpoint' }],
    category: 'Camera',
    method: 'viewpoint',
    resolvesName: 'viewpoint',
    help: 'Apply a named catalog viewpoint, seeking the clock if it declares an epoch.',
    invoke: (host, a) => host.viewpoint(str(a[0])),
  },
  {
    name: 'gotoPlace',
    contract: { namespace: 'places', writes: ['camera', 'selection'], expect: a => [{ p: 'place', id: s(a.place) }], guide: 'For landing areas, search places for landing/site records as well as the crater name, and resolve viewpoints and activities, before choosing: a named crater, an overview viewpoint and a mission waypoint differ. Say when a waypoint is synthetic or a demo; never present it as an observed landing.' },
    params: [
      { name: 'place', type: 'place' },
      { name: 'how', type: 'enum', values: ['fly', 'jump'], optional: true },
    ],
    category: 'Camera',
    method: 'gotoPlace',
    resolvesName: 'place',
    help: 'Fly (or jump) to a named place by its stable ref, and select it.',
    invoke: (host, a) => host.gotoPlace!(str(a[0]), { animate: optStr(a[1]) !== 'jump' }),
  },
  {
    name: 'setFrame',
    contract: { namespace: 'camera', writes: ['camera'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], 'frame.mode', a.mode), ...(a.object ? [state('getViewerState', [], 'frame.body', a.object)] : [])] },
    params: [
      { name: 'mode', type: 'enum', values: FRAME_MODE_IDS },
      { name: 'object', type: 'object', optional: true },
    ],
    category: 'Camera',
    method: 'setFrame',
    resolvesName: 'object',
    presets: FRAME_PRESETS,
    help: `Switch camera frame (${FRAME_MODE_IDS.join(', ')}), optionally onto an object.`,
    invoke: (host, a) => host.setFrame(str(a[0]), optStr(a[1])),
  },
  {
    name: 'clearLookAt',
    contract: { namespace: 'camera', writes: ['camera'], idempotent: true, observes: ['getViewerState'], expect: () => [state('getViewerState', [], 'lookAt', null)] },
    params: [],
    category: 'Camera',
    method: 'clearLookAt',
    help: 'Stop aiming at an object. The orbit centre returns to what is tracked.',
    invoke: (host) => host.clearLookAt(),
  },
  {
    // eye, target, up — the order catalog `Viewpoint` JSON and
    // `camera-view-io.ts` already use, so the three serializations of a camera
    // in this repo at least agree on the order of their fields.
    name: 'setCamera',
    contract: opaque('camera', ['camera'], 'a raw pose is not compared exactly after floating-origin rebasing'),
    params: [
      { name: 'position', type: 'vector' },
      { name: 'target', type: 'vector', optional: true },
      { name: 'up', type: 'vector', optional: true },
    ],
    category: 'Camera',
    method: 'setCamera',
    help: 'Place the camera: eye position, the point it looks at, and up — all in km.',
    invoke: (host, a) => host.setCamera(vec(a[0]), optVec(a[1]), optVec(a[2])),
  },
  // Cosmographia's four names rather than one `circleCenter <direction>`: a
  // ported script is then a respelling, `circleCenterRight(360, 5)` →
  // `circleCenterRight 360 5`, with nothing to rearrange.
  ...CIRCLE_DIRECTIONS.map(
    ([suffix, direction]): VerbSpec => ({
      name: `circleCenter${suffix}`,
      contract: opaque('camera', ['camera'], RELATIVE),
      params: [
        { name: 'degrees', type: 'number' },
        { name: 'seconds', type: 'number', optional: true },
      ],
      category: 'Camera',
      method: 'circleCenter',
      help: `Swing the camera ${direction} around what it orbits by an angle. Instant by default; give seconds to animate.`,
      invoke: (host, a) =>
        host.circleCenter(direction, num(a[0]), a[1] === undefined ? undefined : { seconds: num(a[1]) }),
    }),
  ),
  {
    name: 'dolly',
    contract: opaque('camera', ['camera'], RELATIVE),
    params: [
      { name: 'km', type: 'number' },
      { name: 'seconds', type: 'number', optional: true },
    ],
    category: 'Camera',
    method: 'dolly',
    help: 'Move the camera away from what it orbits by this many km (toward it if negative). Instant unless given seconds.',
    invoke: (host, a) => host.dolly(num(a[0]), a[1] === undefined ? undefined : { seconds: num(a[1]) }),
  },
  {
    name: 'crane',
    contract: opaque('camera', ['camera'], RELATIVE),
    params: [
      { name: 'km', type: 'number' },
      { name: 'seconds', type: 'number', optional: true },
    ],
    category: 'Camera',
    method: 'crane',
    help: 'Raise the camera and its view by this many km along the view up (lower if negative). Instant unless given seconds.',
    invoke: (host, a) => host.crane(num(a[0]), a[1] === undefined ? undefined : { seconds: num(a[1]) }),
  },
  {
    name: 'composeView',
    contract: { namespace: 'camera', writes: ['camera'], expect: a => [{ p: 'tracked', object: s(a.anchor) }, ...[a.anchor, a.target, a.also].filter((o): o is string => typeof o === 'string').map(o => ({ p: 'inView' as const, object: o }))], guide: 'To bring another object into a close-up ("rotate around X so I can see Y", "keep X close but show Y"), composeView with X as anchor and Y as target keeps distance, time and selection. Frame X first only when it is not tracked. Do not alternate framing, dolly in and out, or guess circleCenter angles. If X fills the view or Y is hidden, give that tradeoff in one sentence and offer to move out.' },
    params: [
      { name: 'anchor', type: 'object' },
      { name: 'target', type: 'object' },
      { name: 'also', type: 'object', optional: true },
    ],
    category: 'Camera',
    method: 'getViewComposition',
    help: 'Swing the camera around the tracked anchor until target (and also) are in view beside it, keeping distance, clock and selection. Refuses, without moving, when the anchor fills the view; reports objects still hidden behind others.',
    invoke: (host, a) => { composeView(host, str(a[0]), [str(a[1]), ...(a[2] === undefined ? [] : [str(a[2])])]); },
  },
  {
    name: 'setFov',
    contract: { namespace: 'camera', writes: ['camera'], idempotent: true, observes: ['getCamera'], expect: a => [state('getCamera', [], 'fov', a.degrees)] },
    params: [{ name: 'degrees', type: 'number' }],
    category: 'Camera',
    method: 'setFov',
    help: 'Set the vertical field of view, in degrees.',
    invoke: (host, a) => host.setFov(num(a[0])),
  },

  // ── Display ──
  {
    name: 'setObjectVisible',
    contract: { namespace: 'display', writes: ['display'], idempotent: true, observes: ['getViewComposition'], expect: a => [state('getViewComposition', [[s(a.object)]], `objects[object=${s(a.object)}].drawEnabled`, a.visible)] },
    params: [
      { name: 'object', type: 'object' },
      { name: 'visible', type: 'boolean' },
    ],
    category: 'Display',
    method: 'setObjectVisible',
    resolvesName: 'object',
    help: 'Show or hide an object — mesh, trajectory, label, sensors and all.',
    invoke: (host, a) => host.setObjectVisible(str(a[0]), bool(a[1])),
  },
  {
    name: 'showTrajectory',
    contract: { namespace: 'display', writes: ['display'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], `objects[name=${s(a.object)}].trajectory`, a.visible)] },
    params: [
      { name: 'object', type: 'object' },
      { name: 'visible', type: 'boolean' },
    ],
    category: 'Display',
    method: 'showTrajectory',
    resolvesName: 'object',
    help: "Show or hide one object's trajectory line.",
    invoke: (host, a) => host.showTrajectory(str(a[0]), bool(a[1])),
  },
  {
    name: 'showLabel',
    contract: { namespace: 'display', writes: ['display'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], `objects[name=${s(a.object)}].label`, a.visible)] },
    params: [
      { name: 'object', type: 'object' },
      { name: 'visible', type: 'boolean' },
    ],
    category: 'Display',
    method: 'showLabel',
    resolvesName: 'object',
    help: "Show or hide one object's label.",
    invoke: (host, a) => host.showLabel(str(a[0]), bool(a[1])),
  },
  {
    name: 'setLayer',
    contract: { namespace: 'display', writes: ['display'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], `layers.${s(a.layer)}`, a.on)] },
    params: [
      { name: 'layer', type: 'enum', values: LAYER_IDS },
      { name: 'on', type: 'boolean' },
    ],
    category: 'Display',
    method: 'setLayer',
    presets: LAYER_PRESETS,
    help: `Show or hide a whole layer (${LAYER_IDS.join(', ')}).`,
    invoke: (host, a) => host.setLayer(str(a[0]), bool(a[1])),
  },

  {
    name: 'restoreViewState', contract: { ...opaque('bookmarks', ['camera', 'time', 'selection', 'display', 'events', 'measurements'], 'a whole-state restore has no single read to compare against'), destructive: () => true }, params: [{ name: 'definition', type: 'text' }], category: 'Authoring', method: 'restoreViewState',
    help: 'Restore existing ViewState v1 in the same catalog. Explicit analysis envelopes replace; absent ones preserve.',
    invoke: (host, a, signal) => host.restoreViewState!(data(a[0]), { signal }),
  },
  {
    name: 'selectInstrument', contract: { namespace: 'instruments', writes: ['instruments'], idempotent: true, observes: ['getInstrument'], expect: a => [state('getInstrument', [], 'sensor', s(a.name) || null)] }, params: [{ name: 'name', type: 'instrument' }], category: 'Display', method: 'selectInstrument',
    help: 'Open an existing synthetic instrument feed; empty name closes it. Does not manufacture pointing or observations.',
    invoke: (host, a) => host.selectInstrument!(str(a[0]) || null),
  },
  {
    name: 'saveBookmark', contract: { namespace: 'bookmarks', writes: ['bookmarks'], observes: ['listBookmarks'], expect: a => [state('listBookmarks', [], `[name=${s(a.name)}].name`, s(a.name))] }, sceneEdit: true, params: [{ name: 'name', type: 'text' }], category: 'Authoring', method: 'saveBookmark',
    help: 'Save the current camera using the session viewpoint model; catalog/default names are protected.', invoke: (host, a) => host.saveBookmark!(str(a[0])),
  },
  {
    name: 'upsertBookmark', contract: { namespace: 'bookmarks', writes: ['bookmarks'], idempotent: true, observes: ['listBookmarks'], expect: a => { const n = parsed(a.definition).name; return typeof n === 'string' ? [state('listBookmarks', [], `[name=${n}].name`, n)] : []; } }, sceneEdit: true, params: [{ name: 'definition', type: 'text' }], category: 'Authoring', method: 'upsertBookmark',
    help: 'Merge one portable session viewpoint definition by name, preserving unrelated views.', invoke: (host, a) => host.upsertBookmark!(data(a[0])),
  },
  {
    name: 'removeBookmark', contract: { namespace: 'bookmarks', writes: ['bookmarks'], destructive: () => true, observes: ['listBookmarks'], expect: a => [state('listBookmarks', [], `[name=${s(a.name)}].name`, null)] }, params: [{ name: 'name', type: 'text' }], category: 'Authoring', method: 'removeBookmark',
    help: 'Remove one session viewpoint; catalog/default views are protected.', invoke: (host, a) => host.removeBookmark!(str(a[0])),
  },
  {
    name: 'upsertProfile', category: 'Analysis', method: 'upsertProfile', params: [{ name: 'definition', type: 'text' }],
    contract: { namespace: 'profiles', writes: ['analysis'], idempotent: true, observes: ['getProfile'],
      expect: a => { const d = parsed(a.definition); if (typeof d.id !== 'string') return []; return [
        { p: 'state', read: 'getProfile', args: [d.id], path: 'definition', equals: { id: d.id, profile: d.profile, ...(d.label === undefined ? {} : { label: d.label }), ...(d.enabled === undefined ? {} : { enabled: d.enabled }), ...(d.visible === undefined ? {} : { visible: d.visible }) }, subset: true },
        ...(d.enabled === false || d.visible === false ? [] : [state('getProfile', [d.id], 'status', 'available')]),
      ]; }, guide: 'For a distance profile or continuous timeline graph, use profiles, including after an Event Finder failure. Get getProfileOptions, resolve exact scene names, then upsertProfile and read getProfile. Partial/unavailable is not verified visual success. A profile never seeks or frames the scene. Range is center-to-center distance, not physical surface height or clearance; do not offer it as clearance without explicit acceptance. Display samples need positions, not SPICE GF coverage; sampled minima are not certified contact events.' },
    help: 'Create/update/show/hide the existing continuous timeline profile by stable scene ID, without moving time or camera. definition is JSON text {id,label?,profile:{quantity:range|relative-speed|range-rate|phase-angle,bodies:{observer,target,illuminator?},window?:{start,end}},enabled?:true,visible?:true}. Times are ET seconds past J2000. Defaults inherit shared relationship/window; omitted flags retain state (new: true). Range is center-to-center distance, never physical clearance. Read getProfile for actual timeline presence, sample gaps and visibility.',
    invoke: (h,a) => h.upsertProfile!(data(a[0])),
  },
  { name: 'removeProfile', category: 'Analysis', method: 'removeProfile', params: [{ name: 'id', type: 'text' }],
    contract: { namespace: 'profiles', writes: ['analysis'], observes: ['getProfile'], expect: a => [state('getProfile', [s(a.id)], 'status', 'missing-profile')] },
    help: 'Remove one continuous timeline visualization by its exact profile ID. Does not move time or camera.', invoke: (h,a) => h.removeProfile!(str(a[0])) },
  {
    name: 'upsertEventQuery', contract: { namespace: 'events', writes: ['events'], idempotent: true, observes: ['getEventQueryInfo'], expect: a => { const d = parsed(a.definition); return typeof d.id === 'string' ? [{ p: 'state', read: 'getEventQueryInfo', args: [d.id], path: 'definition', equals: { enabled: d.enabled, visible: d.visible, query: d.query }, subset: true }] : []; }, guide: '"When did X fly past Y", "closest approach" and "all flybys" ask for computed encounters, not authored viewpoint dates. Get getEventSearchOptions for the exact pair and use its supported window and coverage; catalog dates do not prove coverage. "All" means every local minimum (scope local) over that whole coverage. Keep the kind\'s default step unless the person asks otherwise: a longer step can miss approaches. Coverage can be several windows and one search must fit inside one: for the closest or all approaches over the loaded data, search each coverage window and compare.' }, sceneEdit: true, params: [{ name: 'definition', type: 'text' }], category: 'Analysis', method: 'upsertEventQuery',
    help: 'Set up an Event Finder search. definition is JSON text {"id","label","enabled":true,"visible":true,"query":{"id","kind":"closest-approach","bodies":{"observer","target"},"window":{"start","end"} in ET seconds,"step" seconds,"abcorr":"NONE","params":{"scope":"local"|"global"}}}; roles, kinds and a supported window come from getEventSearchOptions. Create or replace by stable ID; cached results are invalidated.',
    invoke: (host, a) => host.upsertEventQuery!(data(a[0])),
  },
  {
    name: 'openEventQuery', contract: opaque('events', ['events'], 'the open search panel has no read'), params: [{ name: 'id', type: 'event-query' }], category: 'Analysis', method: 'openEventQuery',
    help: 'Open an existing configured search for inspection/editing without seeking time.', invoke: (host, a) => host.openEventQuery!(str(a[0])),
  },
  {
    name: 'removeEventQuery', contract: { namespace: 'events', writes: ['events'], destructive: () => true, observes: ['getEventQueryInfo'], expect: a => [state('getEventQueryInfo', [s(a.id)], 'definition', null)] }, params: [{ name: 'id', type: 'event-query' }], category: 'Authoring', method: 'removeEventQuery',
    help: 'Remove one configured event query and its computed results.', invoke: (host, a) => host.removeEventQuery!(str(a[0])),
  },
  {
    name: 'runEventQuery', contract: { namespace: 'events', writes: ['events'], expect: a => [{ p: 'eventRun', query: s(a.id) }] }, params: [{ name: 'id', type: 'event-query' }, { name: 'timeoutMs', type: 'number', optional: true }], category: 'Analysis', method: 'runEventQuery',
    help: 'Run an existing Event Finder search; refuse failure, cancellation, timeout or scene replacement.',
    invoke: async (host, a, signal) => { const result = await host.runEventQuery!(str(a[0]), { timeoutMs: optNum(a[1]), signal }); if (result.status !== 'complete') throw new Error(result.error?.message ?? `Event search ${result.status}`); },
  },
  {
    name: 'cancelEventQuery', contract: opaque('events', ['events'], 'cancelling has no distinct end state when nothing is running'), params: [], category: 'Analysis', method: 'cancelEventQuery',
    help: 'Cancel the existing Event Finder search.', invoke: host => host.cancelEventQuery!(),
  },
  {
    name: 'focusEventResult', contract: { namespace: 'events', writes: ['events', 'time'], expect: a => { const r = eventRef(a.reference); return r.query ? [{ p: 'eventSelected', query: r.query, ...(r.id ? { id: r.id } : {}) }] : []; } }, params: [{ name: 'reference', type: 'text' }, { name: 'anchor', type: 'enum', values: ['inspect', 'start', 'middle', 'end'], optional: true }], category: 'Analysis', method: 'focusEventResult',
    help: 'reference is JSON text of the entire {scene,query,id,revision} reference from getEventResultPage, never a bare ID. anchor middle seeks; inspect preserves time. Refuse stale references; camera framing stays separate. Use waitUntilReady with an event predicate before deterministic capture.',
    invoke: (host, a, signal) => { const result = host.focusEventResult!(data(a[0]), optStr(a[1]) as 'inspect' | 'start' | 'middle' | 'end' | undefined, { signal }); if (!['observed', 'partial'].includes(result.status)) throw new Error(`Event focus ${result.status}`); },
  },
  {
    name: 'presentEventResult', contract: { namespace: 'events', writes: ['events', 'time', 'camera'], expect: a => { const r = eventRef(a.reference); const framing = a.framing === 'target' ? 'target' as const : 'pair' as const; return r.query ? [{ p: 'eventSelected', query: r.query, ...(r.id ? { id: r.id } : {}) }, { p: 'paused', value: true }, { p: 'eventEpoch', query: r.query }, { p: 'eventFramed', query: r.query, framing }, { p: 'eventDrawn', query: r.query }] : []; }, guide: 'To show a computed result, presentEventResult with the exact run reference: it pauses, seeks and frames the encounter in one operation; focusEventResult only selects. A range minimum is a flyby only when its result says encounter true; when the person asks for a flyby or encounter and no result qualifies, say so plainly and do not present a distant minimum as one.' }, params: [{ name: 'reference', type: 'text' }, { name: 'framing', type: 'enum', values: ['pair','target'], optional: true }], category: 'Camera', method: 'presentEventResult',
    help: 'Show a computed encounter: JSON reference is the exact {scene,query,id,revision} from a ranked result page. Pauses, seeks its middle epoch, fits observer and target together (pair, default), and observes native draw state. target frames only the target. Respects cancellation/manual takeover. No solver or new query. Partial draw is not visible-pixels proof.',
    invoke: async (host, a, signal) => { const result = await host.presentEventResult!(data(a[0]), optStr(a[1]) as 'pair' | 'target' | undefined, { signal }); if (!['observed','partial'].includes(result.status)) throw new Error(`Event presentation ${result.status}`); },
  },
  {
    name: 'selectEventResult', contract: { namespace: 'events', writes: ['events', 'time'], expect: a => [{ p: 'eventSelected', query: s(a.query), id: s(a.id) }] }, params: [{ name: 'query', type: 'event-query' }, { name: 'id', type: 'event-result' }, { name: 'anchor', type: 'enum', values: ['inspect', 'start', 'middle', 'end'], optional: true }], category: 'Analysis', method: 'selectEventResult',
    help: 'Inspect or seek an exact query/result pair through Event Finder selection.', invoke: (host, a) => host.selectEventResult!(str(a[0]), str(a[1]), optStr(a[2]) as 'inspect' | 'start' | 'middle' | 'end' | undefined),
  },
  {
    name: 'showImagery',
    contract: { namespace: 'surface', writes: ['imagery'], idempotent: true, observes: ['getImagery'], expect: a => [state('getImagery', [s(a.object)], `layers[id=${s(a.layer)}].visible`, a.visible)] },
    params: [
      { name: 'object', type: 'object' },
      { name: 'layer', type: 'imagery' },
      { name: 'visible', type: 'boolean' },
    ],
    category: 'Display',
    method: 'setImageryVisible',
    resolvesName: 'imagery',
    help: "Show or hide one layer of a body's imagery stack, by layer ID.",
    invoke: (host, a) => host.setImageryVisible!(str(a[0]), str(a[1]), bool(a[2])),
  },
  {
    name: 'moveImageryLayer',
    contract: { namespace: 'surface', writes: ['imagery'], idempotent: true, observes: ['getImagery'], expect: a => [state('getImagery', [s(a.object)], `layers.${a.index}.id`, s(a.layer))] },
    params: [{ name: 'object', type: 'object' }, { name: 'layer', type: 'imagery' }, { name: 'index', type: 'number' }],
    category: 'Display', method: 'moveImageryLayer', resolvesName: 'imagery',
    help: 'Move an imagery overlay to a bottom-to-top index. The mandatory base stays at zero.',
    invoke: (host, a) => host.moveImageryLayer!(str(a[0]), str(a[1]), num(a[2])),
  },
  {
    name: 'setImageryOpacity',
    contract: { namespace: 'surface', writes: ['imagery'], idempotent: true, observes: ['getImagery'], expect: a => [state('getImagery', [s(a.object)], `layers[id=${s(a.layer)}].opacity`, a.opacity)] },
    params: [
      { name: 'object', type: 'object' },
      { name: 'layer', type: 'imagery' },
      { name: 'opacity', type: 'number' },
    ],
    category: 'Display',
    method: 'setImageryOpacity',
    resolvesName: 'imagery',
    help: "Set one imagery layer's opacity, 0 to 1.",
    invoke: (host, a) => host.setImageryOpacity!(str(a[0]), str(a[1]), num(a[2])),
  },
  {
    name: 'showBodyGrid', contract: { namespace: 'grids', writes: ['grid'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], `grid.perBody.${s(a.object)}.visible`, a.visible)] }, params: [{ name: 'object', type: 'object' }, { name: 'visible', type: 'boolean' }],
    category: 'Display', method: 'showBodyGrid', resolvesName: 'object', help: 'Show or hide a body surface grid using shared viewer state.',
    invoke: (host, a) => host.showBodyGrid?.(str(a[0]), bool(a[1])),
  },
  {
    name: 'showBodyGridLabels', contract: { namespace: 'grids', writes: ['grid'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], `grid.perBody.${s(a.object)}.labels`, a.visible)] }, params: [{ name: 'object', type: 'object' }, { name: 'visible', type: 'boolean' }],
    category: 'Display', method: 'showBodyGridLabels', resolvesName: 'object', help: 'Show or hide one body’s coordinate labels independently of lines.',
    invoke: (host, a) => host.showBodyGridLabels?.(str(a[0]), bool(a[1])),
  },
  {
    name: 'setGridScope', contract: { namespace: 'grids', writes: ['grid'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], 'grid.scope', a.scope)] }, params: [{ name: 'scope', type: 'enum', values: ['tracked', 'bodies', 'all'] }, { name: 'bodies', type: 'text', optional: true }],
    category: 'Display', method: 'setGridScope', help: 'Grid target: tracked body, comma-separated pinned bodies, or all eligible bodies.',
    invoke: (host, a) => host.setGridScope?.(str(a[0]) as 'tracked' | 'bodies' | 'all', optStr(a[1])),
  },
  {
    name: 'setGridDensity', contract: { namespace: 'grids', writes: ['grid'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], 'grid.density', a.density), ...(a.degrees !== undefined ? [state('getViewerState', [], 'grid.spacingDeg', a.degrees)] : [])] }, params: [{ name: 'density', type: 'enum', values: ['auto', 'manual'] }, { name: 'degrees', type: 'number', optional: true }],
    category: 'Display', method: 'setGridDensity', help: 'Auto density or manual angular spacing in degrees.',
    invoke: (host, a) => host.setGridDensity?.(str(a[0]) as 'auto' | 'manual', optNum(a[1])),
  },
  {
    name: 'setGridLabels', contract: { namespace: 'grids', writes: ['grid'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], 'grid.labels', a.visible)] }, params: [{ name: 'visible', type: 'boolean' }], category: 'Display', method: 'setGridLabels',
    help: 'Show coordinate labels independently of grid lines.', invoke: (host, a) => host.setGridLabels?.(bool(a[0])),
  },
  {
    name: 'setGridOpacity', contract: { namespace: 'grids', writes: ['grid'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], 'grid.opacity', a.opacity)] }, params: [{ name: 'opacity', type: 'number' }], category: 'Display', method: 'setGridOpacity',
    help: 'Grid lines and coordinate-caption opacity, from 0 to 1.', invoke: (host, a) => host.setGridOpacity?.(num(a[0])),
  },
  {
    name: 'setGridCoordinateFrame', contract: { namespace: 'grids', writes: ['grid'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], 'grid.coordinateFrame', a.visible)] }, params: [{ name: 'visible', type: 'boolean' }], category: 'Display', method: 'setGridCoordinateFrame',
    help: 'Place coordinate labels at viewport-border crossings in close overhead views; zoomed-out views retain surface labels.', invoke: (host, a) => host.setGridCoordinateFrame?.(bool(a[0])),
  },
  {
    name: 'setGridMinorLines', contract: { namespace: 'grids', writes: ['grid'], idempotent: true, observes: ['getViewerState'], expect: a => [state('getViewerState', [], 'grid.minorLines', a.visible)] }, params: [{ name: 'visible', type: 'boolean' }], category: 'Display', method: 'setGridMinorLines',
    help: 'Show fainter intermediate surface grid lines.', invoke: (host, a) => host.setGridMinorLines?.(bool(a[0])),
  },

  // ── Time ──
  {
    name: 'setTimelineWindow', params: [{ name: 'start', type: 'time' }, { name: 'end', type: 'time' }], category: 'Time', method: 'setTimelineWindow',
    help: 'Show [start, end] on the timeline, growing its range if needed. Moves neither the clock nor the scene.',
    contract: { namespace: 'time', writes: ['time'], idempotent: true, observes: ['getTimelineWindow'], expect: a => {
      const et = (v: unknown) => typeof v === 'number' ? v : (() => { try { return etFromCalendarString(String(v)); } catch { return NaN; } })();
      const [start, end] = [et(a.start), et(a.end)];
      return Number.isFinite(start) && Number.isFinite(end) ? [{ p: 'state', read: 'getTimelineWindow', path: 'start', equals: start, within: 1 }, { p: 'state', read: 'getTimelineWindow', path: 'end', equals: end, within: 1 }] : [];
    } },
    invoke: (host, a) => host.setTimelineWindow!(time(a[0]), time(a[1])),
  },
  {
    name: 'setTime',
    contract: { namespace: 'time', writes: ['time'], idempotent: true, expect: (a, h) => h.isPlaying() ? [] : [typeof a.when === 'number' ? { p: 'epoch', et: a.when } : { p: 'epoch', utc: s(a.when) }] },
    params: [{ name: 'when', type: 'time' }],
    category: 'Time',
    method: 'setTime',
    help: 'Seek the clock. A calendar string, or a number of seconds past J2000.',
    invoke: (host, a) => host.setTime(time(a[0])),
  },
  {
    name: 'setTimeRate',
    contract: { namespace: 'time', writes: ['time'], idempotent: true, expect: a => [{ p: 'rate', value: a.rate as number }] },
    params: [{ name: 'rate', type: 'number' }],
    category: 'Time',
    method: 'setTimeRate',
    help: 'Set playback rate, in scene-seconds per wall-second.',
    invoke: (host, a) => host.setTimeRate(num(a[0])),
  },
  {
    name: 'setPlaying',
    contract: { namespace: 'time', writes: ['time'], idempotent: true, expect: a => [{ p: 'paused', value: !a.on }] },
    params: [{ name: 'on', type: 'boolean' }],
    category: 'Time',
    method: 'setPlaying',
    presets: [
      { id: 'time.play', label: 'Play', args: 'on' },
      { id: 'time.pause', label: 'Pause', args: 'off' },
    ],
    help: 'Start or stop playback.',
    invoke: (host, a) => host.setPlaying(bool(a[0])),
  },
  {
    name: 'runTo',
    contract: opaque('time', ['time'], 'a relative clock advance has no absolute end state'),
    params: [{ name: 'seconds', type: 'number' }],
    category: 'Time',
    method: 'runTo',
    help: 'Advance scene time by exactly this many seconds. Deterministic.',
    invoke: (host, a) => host.runTo(num(a[0])),
  },

  // ── Sequencing and output ──
  {
    name: 'wait',
    contract: { namespace: 'display', writes: [] },
    params: [{ name: 'seconds', type: 'number' }],
    category: 'Sequencing',
    method: 'wait',
    help: 'Sleep this many WALL-CLOCK seconds so streamed data settles. Not deterministic.',
    invoke: (host, a) => host.wait?.(num(a[0])),
  },
  {
    name: 'displayNote',
    contract: { namespace: 'display', writes: ['display'], observes: ['getViewerState'], unobservable: 'a timed caption is an event, not view state', expect: a => a.seconds === undefined ? [state('getViewerState', [], 'note', s(a.text))] : [] },
    params: [
      { name: 'text', type: 'text' },
      { name: 'seconds', type: 'number', optional: true },
    ],
    category: 'Display',
    method: 'displayNote',
    help: 'Show a caption over the viewport. Omit the duration to leave it up.',
    invoke: (host, a) => host.displayNote(str(a[0]), optNum(a[1])),
  },
  {
    name: 'screenshot',
    contract: { ...opaque('capture', ['capture'], 'a capture produces output outside viewer state'), guide: 'Capture only after waitUntilReady with an explicit readiness predicate at a paused epoch; stop on timeout, cancellation or a stale scene.' },
    params: [{ name: 'label', type: 'text', optional: true }],
    category: 'Capture',
    method: 'screenshot',
    help: 'Capture the current frame.',
    invoke: (host, a) => host.screenshot?.(optStr(a[0])),
  },
  {
    name: 'record',
    contract: opaque('capture', ['capture'], 'recording produces output outside viewer state'),
    params: [{ name: 'on', type: 'boolean' }],
    category: 'Capture',
    method: 'record',
    presets: [
      { id: 'record.start', label: 'Start recording', args: 'on' },
      { id: 'record.stop', label: 'Stop recording', args: 'off' },
    ],
    help: 'Start or stop video recording.',
    invoke: (host, a) => host.record?.(bool(a[0])),
  },
];

/** The registry: the built-in table plus anything `registerVerb` added. */
export const VERBS: ReadonlyMap<string, VerbSpec> = new Map(VERB_LIST.map((v) => [v.name, v]));

/** Every verb name, in table order. */
export const VERB_NAMES: readonly string[] = VERB_LIST.map((v) => v.name);

/** `gotoObject <object> [seconds]` — the one-line usage a help list shows. */
export function verbUsage(spec: VerbSpec): string {
  const params = spec.params.map((p) =>
    p.optional ? `[${p.name}]` : `<${p.name}>`,
  );
  return [spec.name, ...params].join(' ');
}
