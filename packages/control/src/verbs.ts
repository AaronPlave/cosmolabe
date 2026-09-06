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
import type { ScriptTime, ScriptVec3, VerbValue, ViewerControl } from './contracts.js';

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

const FRAME_MODE_IDS = FRAME_MODES.map((m) => m.id);
const LAYER_IDS = LAYERS.map((l) => l.id);

export type ParamType =
  /** Names a scene object. Passed to the host verbatim. */
  | 'object'
  /** Names a catalog viewpoint. Passed verbatim. */
  | 'viewpoint'
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
  readonly category: 'Scene' | 'Time' | 'Camera' | 'Display' | 'Capture' | 'Sequencing';
  readonly help: string;
  /** The `ViewerControl` method this verb needs. Missing on a host → located error. */
  readonly method: keyof ViewerControl;
  /**
   * What a `false` return means, so the error can suggest a real name.
   * Absent when `false` is not about a name (`setFov` out of range, say).
   */
  readonly resolvesName?: 'object' | 'viewpoint';
  readonly presets?: readonly VerbPreset[];
  /** Table-driven dispatch. `args` are already coerced to `params`' types. */
  invoke(host: ViewerControl, args: readonly VerbValue[]): unknown;
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

export const VERB_LIST: readonly VerbSpec[] = [
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
    help: 'Track an object and frame it. Cuts by default; give seconds to fly there.',
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
    help: 'Orbit-lock the camera to an object without moving it.',
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
    name: 'setCamera',
    params: [
      { name: 'position', type: 'vector' },
      { name: 'up', type: 'vector', optional: true },
    ],
    category: 'Camera',
    method: 'setCamera',
    help: 'Place the camera at an explicit eye position in km, with an optional up vector.',
    invoke: (host, a) => host.setCamera(vec(a[0]), optVec(a[1])),
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
