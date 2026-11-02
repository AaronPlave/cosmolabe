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
}

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
  { name: 'pinGroundPoint', category: 'Display', method: 'pinGroundPoint', params: [{ name: 'object', type: 'object' }, { name: 'policy', type: 'enum', values: ['reference','rendered','terrain'], optional: true }], help: 'Pin the entity’s current radial sub-point on its active parent through native Point Probe. Reversible display, no saved layer. rendered uses the drawn authoritative surface; reference is explicitly ellipsoid-only; terrain refuses without physical terrain evidence. Preserves camera/time. Inspect getProbePoint afterward.', invoke: (h,a) => { const r = h.pinGroundPoint!(str(a[0]), optStr(a[1]) as import('./contracts.js').ScriptSurfacePolicy | undefined); if (r.status !== 'available') throw new Error(`Ground projection ${r.status}: ${r.reason}`); return r; } },
  { name: 'clearProbePoint', category: 'Display', method: 'clearProbePoint', params: [], help: 'Clear the transient Point Probe pin without changing saved annotations.', invoke: h => h.clearProbePoint!() },

  { name: 'selectPlace', category: 'Scene', method: 'selectPlace', params: [{ name: 'place', type: 'place' }], help: 'Inspect a stable place without moving the camera; empty ref clears selection.', invoke: (h,a) => h.selectPlace!(str(a[0]) || null) },
  { name: 'setPlaceSourceEnabled', category: 'Display', method: 'setPlaceSourceEnabled', params: [geoLayer, { name: 'enabled', type: 'boolean' }], help: 'Include or exclude an exact place source in shared search and navigation.', invoke: (h,a) => h.setPlaceSourceEnabled!(str(a[0]), bool(a[1])) },
  { name: 'showPlaceLabels', category: 'Display', method: 'showPlaceLabels', params: [geoLayer, visible], help: 'Show or hide source labels independently of search inclusion.', invoke: (h,a) => h.showPlaceLabels!(str(a[0]), bool(a[1])) },
  { name: 'upsertMeasurement', category: 'Authoring', method: 'upsertMeasurement', params: [json], help: 'Upsert a validated semantic measurement by stable ID; preserve other definitions. JSON: {id,kind:distance|direction|angle|velocity|axes|vector-angle,source,target,vertex:null,visible:true}; entity endpoints are {kind:entity,bodyName:exact scene name}. Entity distances are centre distances, not terrain clearance.', invoke: (h,a) => h.upsertMeasurement!(data<MeasurementDefinition>(a[0])) },
  { name: 'restoreMeasurements', category: 'Authoring', method: 'restoreMeasurements', params: [json, { name: 'mode', type: 'enum', values: ['merge','replace'], optional: true }], help: 'Restore version 1 measurement definitions; merge by default, replace only when explicit.', invoke: (h,a) => h.restoreMeasurements!(data(a[0]), optStr(a[1]) as 'merge' | 'replace' | undefined) },
  { name: 'removeMeasurement', category: 'Authoring', method: 'removeMeasurement', params: [measurement], help: 'Remove one saved measurement by ID.', invoke: (h,a) => h.removeMeasurement!(str(a[0])) },
  { name: 'selectMeasurement', category: 'Analysis', method: 'selectMeasurement', params: [measurement], help: 'Select a measurement; an empty ID clears selection.', invoke: (h,a) => h.selectMeasurement!(str(a[0]) || null) },
  { name: 'showMeasurement', category: 'Display', method: 'showMeasurement', params: [measurement, visible], help: 'Show or hide a saved measurement.', invoke: (h,a) => h.showMeasurement!(str(a[0]), bool(a[1])) },
  { name: 'showGeographicLayer', category: 'Display', method: 'setGeographicLayerVisible', params: [geoLayer, visible], help: 'Show or hide one geographic layer.', invoke: (h,a) => h.setGeographicLayerVisible!(str(a[0]), bool(a[1])) },
  { name: 'setGeographicLayerStyle', category: 'Display', method: 'setGeographicLayerStyle', params: [geoLayer, json], help: 'Apply a validated version 1 layer style; null restores catalog style. Does not save local preferences.', invoke: (h,a) => h.setGeographicLayerStyle!(str(a[0]), data<GeographicLayerStyle | null>(a[1])) },
  { name: 'selectGeographicFeature', category: 'Scene', method: 'selectGeographicFeature', params: [geoLayer, geoFeature], help: 'Select a stable feature without moving the camera.', invoke: (h,a) => h.selectGeographicFeature!(str(a[0]), str(a[1])) },
  { name: 'clearGeographicSelection', category: 'Scene', method: 'clearGeographicSelection', params: [], help: 'Clear geographic feature selection.', invoke: h => h.clearGeographicSelection!() },
  { name: 'gotoGeographicFeature', category: 'Camera', method: 'gotoGeographicFeature', params: [geoLayer, geoFeature, { name: 'animate', type: 'boolean', optional: true }], help: 'Use the existing feature extent navigation; off cuts to the view.', invoke: (h,a) => h.gotoGeographicFeature!(str(a[0]), str(a[1]), { animate: a[2] as boolean | undefined }) },
  { name: 'createAnnotationLayer', category: 'Authoring', method: 'createAnnotationLayer', params: [{ name: 'body', type: 'object' }, { name: 'name', type: 'text' }, json], help: 'Create a user annotation layer with explicit body/frame/coordinate conventions. JSON coordinates: {frame:body-fixed frame,latitude:planetocentric,longitudeDirection:east,longitudeDomain:-180..180,referenceShape:{kind:ellipsoid,radiiKm:[x,y,z]}}. Angles are degrees. Use body frame from layer/surface inventory; never invent a transform.', invoke: (h,a) => h.createAnnotationLayer!(str(a[0]), str(a[1]), data<GeographicCoordinates>(a[2])) },
  { name: 'editAnnotation', category: 'Authoring', method: 'editAnnotation', params: [geoLayer, json], help: 'Apply one bounded core annotation edit, with normal validation and undo. Catalog layers remain read-only. JSON operations: {type:add,geometry:{type:Point,coordinates:[longitude,latitude]},properties:{name:text}}, {type:delete,featureId:original sourceId}, {type:replace-geometry,featureId,geometry}, or {type:set-properties,featureId,properties}. Use the original typed sourceId, not its prefixed reference.', invoke: (h,a) => h.editAnnotation!(str(a[0]), data<GeographicEditOperation>(a[1])) },
  { name: 'setSurfaceAppearance', category: 'Display', method: 'setSurfaceAppearance', params: [{ name: 'body', type: 'object' }, json], help: 'Patch supported physical terrain appearance. JSON may contain hillshade:boolean, contours:boolean, baseColor:imagery|elevation|neutral, palette:terrain|blue-gold|grayscale, minKm:number, maxKm:number, imageryAmount:number, azimuthDeg:number, elevationDeg:number, contrast:number. Read current settings first. A palette only appears when baseColor is elevation: select that mode for requested elevation coloring. Enabling an imagery layer is separate from choosing the base color; clarify genuinely conflicting final-style requests. Changes no terrain geometry or scientific data.', invoke: (h,a) => h.setSurfaceAppearance!(str(a[0]), data(a[1])) },
  { name: 'waitUntilReady', category: 'Sequencing', method: 'waitUntilReady', params: [json, { name: 'timeoutSeconds', type: 'number', optional: true }], help: 'Wait for an explicit observed readiness predicate, failing transparently unless ready; no wall-clock fallback. JSON event predicate: {kind:event,reference:{scene,query,id,revision},et:number,policy:timeline|native-draw}. Others: {kind:assets}, {kind:terrain,body}, {kind:imagery,body,layer}, {kind:cube-base,body}.', invoke: async (h,a,signal) => {
    const result = await h.waitUntilReady!(data<ScriptReadinessRequest>(a[0]), { timeoutMs: a[1] === undefined ? undefined : num(a[1]) * 1000, signal });
    if (result.status !== 'ready') throw new Error(`${result.status}: ${result.missing.join('; ')}`);
    return result;
  } },
];

export const VERB_LIST: readonly VerbSpec[] = [
  ...modernVerbs,
  { name: 'selectActivity', params: [{ name: 'activity', type: 'activity' }], category: 'Time', method: 'selectActivity', resolvesName: 'activity',
    help: 'Select an activity by stable ID without seeking or moving the camera.', invoke: (h, a) => h.selectActivity!(str(a[0])) },
  { name: 'seekActivity', params: [{ name: 'activity', type: 'activity' }, { name: 'edge', type: 'enum', values: ['start', 'end'], optional: true }],
    category: 'Time', method: 'seekActivity', resolvesName: 'activity', help: 'Seek an activity edge; both edges of a milestone mean its one epoch.',
    invoke: (h, a) => h.seekActivity!(str(a[0]), optStr(a[1]) as 'start' | 'end' | undefined) },
  { name: 'navigateActivity', params: [{ name: 'direction', type: 'enum', values: ['previous', 'next'] }, { name: 'vehicle', type: 'object', optional: true }, { name: 'kind', type: 'enum', values: ['flight', 'drive', 'hop', 'descent', 'landing', 'phase', 'other'], optional: true }],
    category: 'Time', method: 'navigateActivity', help: 'Select previous/next in start/end/ID order, optionally within a vehicle and kind. Does not seek.',
    invoke: (h, a) => h.navigateActivity!(str(a[0]) as 'previous' | 'next', { vehicle: optStr(a[1]), kind: optStr(a[2]) }) },

  // ── Scene ──
  {
    name: 'gotoObject',
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
    params: [{ name: 'object', type: 'object' }],
    category: 'Scene',
    method: 'select',
    resolvesName: 'object',
    help: 'Select an object — what the info panel shows.',
    invoke: (host, a) => host.select(str(a[0])),
  },
  {
    name: 'deselect',
    params: [],
    category: 'Scene',
    method: 'deselect',
    help: 'Clear the selection.',
    invoke: (host) => host.deselect(),
  },
  {
    name: 'track',
    params: [{ name: 'object', type: 'object' }],
    category: 'Camera',
    method: 'track',
    resolvesName: 'object',
    help: 'Make an object the camera’s anchor without moving the camera.',
    invoke: (host, a) => host.track(str(a[0])),
  },
  {
    name: 'untrack',
    params: [],
    category: 'Camera',
    method: 'untrack',
    help: 'Release the tracked object. The camera stays where it is.',
    invoke: (host) => host.untrack(),
  },
  {
    name: 'frameObject',
    params: [{ name: 'object', type: 'object', optional: true }],
    category: 'Camera',
    method: 'frameObject',
    resolvesName: 'object',
    help: 'Cut to a view that fits an object (default: the tracked one), and track it.',
    invoke: (host, a) => host.frameObject(optStr(a[0])),
  },
  {
    name: 'flyTo',
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
    params: [{ name: 'object', type: 'object' }],
    category: 'Camera',
    method: 'jumpTo',
    resolvesName: 'object',
    help: 'Cut to the view a flight to an object would land on, and track it.',
    invoke: (host, a) => host.jumpTo(str(a[0])),
  },
  {
    name: 'gotoCoordinates',
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
    params: [],
    category: 'Camera',
    method: 'stopFlight',
    help: 'End a flight where it is, tracking what it was flying to.',
    invoke: (host) => host.stopFlight(),
  },
  {
    name: 'pointAtObject',
    params: [{ name: 'object', type: 'object' }],
    category: 'Camera',
    method: 'pointAtObject',
    resolvesName: 'object',
    help: 'Aim the camera at an object while still orbiting what it tracks.',
    invoke: (host, a) => host.pointAtObject(str(a[0])),
  },
  {
    name: 'viewpoint',
    params: [{ name: 'name', type: 'viewpoint' }],
    category: 'Camera',
    method: 'viewpoint',
    resolvesName: 'viewpoint',
    help: 'Apply a named catalog viewpoint, seeking the clock if it declares an epoch.',
    invoke: (host, a) => host.viewpoint(str(a[0])),
  },
  {
    name: 'gotoPlace',
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
    name: 'setFov',
    params: [{ name: 'degrees', type: 'number' }],
    category: 'Camera',
    method: 'setFov',
    help: 'Set the vertical field of view, in degrees.',
    invoke: (host, a) => host.setFov(num(a[0])),
  },

  // ── Display ──
  {
    name: 'setObjectVisible',
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
    name: 'restoreViewState', params: [{ name: 'definition', type: 'text' }], category: 'Authoring', method: 'restoreViewState',
    help: 'Restore existing ViewState v1 in the same catalog. Explicit analysis envelopes replace; absent ones preserve.',
    invoke: (host, a, signal) => host.restoreViewState!(data(a[0]), { signal }),
  },
  {
    name: 'selectInstrument', params: [{ name: 'name', type: 'instrument' }], category: 'Display', method: 'selectInstrument',
    help: 'Open an existing synthetic instrument feed; empty name closes it. Does not manufacture pointing or observations.',
    invoke: (host, a) => host.selectInstrument!(str(a[0]) || null),
  },
  {
    name: 'saveBookmark', params: [{ name: 'name', type: 'text' }], category: 'Authoring', method: 'saveBookmark',
    help: 'Save the current camera using the session viewpoint model; catalog/default names are protected.', invoke: (host, a) => host.saveBookmark!(str(a[0])),
  },
  {
    name: 'upsertBookmark', params: [{ name: 'definition', type: 'text' }], category: 'Authoring', method: 'upsertBookmark',
    help: 'Merge one portable session viewpoint definition by name, preserving unrelated views.', invoke: (host, a) => host.upsertBookmark!(data(a[0])),
  },
  {
    name: 'removeBookmark', params: [{ name: 'name', type: 'text' }], category: 'Authoring', method: 'removeBookmark',
    help: 'Remove one session viewpoint; catalog/default views are protected.', invoke: (host, a) => host.removeBookmark!(str(a[0])),
  },
  {
    name: 'upsertEventQuery', params: [{ name: 'definition', type: 'text' }], category: 'Authoring', method: 'upsertEventQuery',
    help: 'Create or replace a validated Event Finder definition by stable ID; cached results are invalidated.',
    invoke: (host, a) => host.upsertEventQuery!(data(a[0])),
  },
  {
    name: 'openEventQuery', params: [{ name: 'id', type: 'event-query' }], category: 'Analysis', method: 'openEventQuery',
    help: 'Open an existing configured search for inspection/editing without seeking time.', invoke: (host, a) => host.openEventQuery!(str(a[0])),
  },
  {
    name: 'removeEventQuery', params: [{ name: 'id', type: 'event-query' }], category: 'Authoring', method: 'removeEventQuery',
    help: 'Remove one configured event query and its computed results.', invoke: (host, a) => host.removeEventQuery!(str(a[0])),
  },
  {
    name: 'runEventQuery', params: [{ name: 'id', type: 'event-query' }, { name: 'timeoutMs', type: 'number', optional: true }], category: 'Analysis', method: 'runEventQuery',
    help: 'Run an existing Event Finder search; refuse failure, cancellation, timeout or scene replacement.',
    invoke: async (host, a, signal) => { const result = await host.runEventQuery!(str(a[0]), { timeoutMs: optNum(a[1]), signal }); if (result.status !== 'complete') throw new Error(result.error?.message ?? `Event search ${result.status}`); },
  },
  {
    name: 'cancelEventQuery', params: [], category: 'Analysis', method: 'cancelEventQuery',
    help: 'Cancel the existing Event Finder search.', invoke: host => host.cancelEventQuery!(),
  },
  {
    name: 'focusEventResult', params: [{ name: 'reference', type: 'text' }, { name: 'anchor', type: 'enum', values: ['inspect', 'start', 'middle', 'end'], optional: true }], category: 'Analysis', method: 'focusEventResult',
    help: 'reference is JSON text of the entire {scene,query,id,revision} reference from getEventResultPage, never a bare ID. anchor middle seeks; inspect preserves time. Refuse stale references; camera framing stays separate. Use waitUntilReady with an event predicate before deterministic capture.',
    invoke: (host, a, signal) => { const result = host.focusEventResult!(data(a[0]), optStr(a[1]) as 'inspect' | 'start' | 'middle' | 'end' | undefined, { signal }); if (!['observed', 'partial'].includes(result.status)) throw new Error(`Event focus ${result.status}`); },
  },
  {
    name: 'presentEventResult', params: [{ name: 'reference', type: 'text' }, { name: 'framing', type: 'enum', values: ['pair','target'], optional: true }], category: 'Camera', method: 'presentEventResult',
    help: 'Show a computed encounter: JSON reference is the exact {scene,query,id,revision} from a ranked result page. Pauses, seeks its middle epoch, fits observer and target together (pair, default), and observes native draw state. target frames only the target. Respects cancellation/manual takeover. No solver or new query. Partial draw is not visible-pixels proof.',
    invoke: async (host, a, signal) => { const result = await host.presentEventResult!(data(a[0]), optStr(a[1]) as 'pair' | 'target' | undefined, { signal }); if (!['observed','partial'].includes(result.status)) throw new Error(`Event presentation ${result.status}`); },
  },
  {
    name: 'selectEventResult', params: [{ name: 'query', type: 'event-query' }, { name: 'id', type: 'event-result' }, { name: 'anchor', type: 'enum', values: ['inspect', 'start', 'middle', 'end'], optional: true }], category: 'Analysis', method: 'selectEventResult',
    help: 'Inspect or seek an exact query/result pair through Event Finder selection.', invoke: (host, a) => host.selectEventResult!(str(a[0]), str(a[1]), optStr(a[2]) as 'inspect' | 'start' | 'middle' | 'end' | undefined),
  },
  {
    name: 'showImagery',
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
    params: [{ name: 'object', type: 'object' }, { name: 'layer', type: 'imagery' }, { name: 'index', type: 'number' }],
    category: 'Display', method: 'moveImageryLayer', resolvesName: 'imagery',
    help: 'Move an imagery overlay to a bottom-to-top index. The mandatory base stays at zero.',
    invoke: (host, a) => host.moveImageryLayer!(str(a[0]), str(a[1]), num(a[2])),
  },
  {
    name: 'setImageryOpacity',
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
    name: 'showBodyGrid', params: [{ name: 'object', type: 'object' }, { name: 'visible', type: 'boolean' }],
    category: 'Display', method: 'showBodyGrid', resolvesName: 'object', help: 'Show or hide a body surface grid using shared viewer state.',
    invoke: (host, a) => host.showBodyGrid?.(str(a[0]), bool(a[1])),
  },
  {
    name: 'showBodyGridLabels', params: [{ name: 'object', type: 'object' }, { name: 'visible', type: 'boolean' }],
    category: 'Display', method: 'showBodyGridLabels', resolvesName: 'object', help: 'Show or hide one body’s coordinate labels independently of lines.',
    invoke: (host, a) => host.showBodyGridLabels?.(str(a[0]), bool(a[1])),
  },
  {
    name: 'setGridScope', params: [{ name: 'scope', type: 'enum', values: ['tracked', 'bodies', 'all'] }, { name: 'bodies', type: 'text', optional: true }],
    category: 'Display', method: 'setGridScope', help: 'Grid target: tracked body, comma-separated pinned bodies, or all eligible bodies.',
    invoke: (host, a) => host.setGridScope?.(str(a[0]) as 'tracked' | 'bodies' | 'all', optStr(a[1])),
  },
  {
    name: 'setGridDensity', params: [{ name: 'density', type: 'enum', values: ['auto', 'manual'] }, { name: 'degrees', type: 'number', optional: true }],
    category: 'Display', method: 'setGridDensity', help: 'Auto density or manual angular spacing in degrees.',
    invoke: (host, a) => host.setGridDensity?.(str(a[0]) as 'auto' | 'manual', optNum(a[1])),
  },
  {
    name: 'setGridLabels', params: [{ name: 'visible', type: 'boolean' }], category: 'Display', method: 'setGridLabels',
    help: 'Show coordinate labels independently of grid lines.', invoke: (host, a) => host.setGridLabels?.(bool(a[0])),
  },
  {
    name: 'setGridOpacity', params: [{ name: 'opacity', type: 'number' }], category: 'Display', method: 'setGridOpacity',
    help: 'Grid lines and coordinate-caption opacity, from 0 to 1.', invoke: (host, a) => host.setGridOpacity?.(num(a[0])),
  },
  {
    name: 'setGridCoordinateFrame', params: [{ name: 'visible', type: 'boolean' }], category: 'Display', method: 'setGridCoordinateFrame',
    help: 'Place coordinate labels at viewport-border crossings in close overhead views; zoomed-out views retain surface labels.', invoke: (host, a) => host.setGridCoordinateFrame?.(bool(a[0])),
  },
  {
    name: 'setGridMinorLines', params: [{ name: 'visible', type: 'boolean' }], category: 'Display', method: 'setGridMinorLines',
    help: 'Show fainter intermediate surface grid lines.', invoke: (host, a) => host.setGridMinorLines?.(bool(a[0])),
  },

  // ── Time ──
  {
    name: 'setTime',
    params: [{ name: 'when', type: 'time' }],
    category: 'Time',
    method: 'setTime',
    help: 'Seek the clock. A calendar string, or a number of seconds past J2000.',
    invoke: (host, a) => host.setTime(time(a[0])),
  },
  {
    name: 'setTimeRate',
    params: [{ name: 'rate', type: 'number' }],
    category: 'Time',
    method: 'setTimeRate',
    help: 'Set playback rate, in scene-seconds per wall-second.',
    invoke: (host, a) => host.setTimeRate(num(a[0])),
  },
  {
    name: 'setPlaying',
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
    params: [{ name: 'seconds', type: 'number' }],
    category: 'Time',
    method: 'runTo',
    help: 'Advance scene time by exactly this many seconds. Deterministic.',
    invoke: (host, a) => host.runTo(num(a[0])),
  },

  // ── Sequencing and output ──
  {
    name: 'wait',
    params: [{ name: 'seconds', type: 'number' }],
    category: 'Sequencing',
    method: 'wait',
    help: 'Sleep this many WALL-CLOCK seconds so streamed data settles. Not deterministic.',
    invoke: (host, a) => host.wait?.(num(a[0])),
  },
  {
    name: 'displayNote',
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
    params: [{ name: 'label', type: 'text', optional: true }],
    category: 'Capture',
    method: 'screenshot',
    help: 'Capture the current frame.',
    invoke: (host, a) => host.screenshot?.(optStr(a[0])),
  },
  {
    name: 'record',
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
