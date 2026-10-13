import type { ScriptCamera, ViewerControl } from './contracts.js';
import { LAYERS } from './verbs.js';

/** Catalog references use the deployment's existing catalog URL protocol. */
export type ViewCatalog = { catalog: string } | { entry: string };
export type ViewTime =
  | { kind: 'fixed'; source: 'ET'; et: number }
  | { kind: 'preserve' }
  | { kind: 'system'; source: 'UTC' };

/** Pose fallback reuses the control port's camera, in km and ECLIPJ2000 axes.
 * Its origin is independent of tracking: untracking retains a floating origin.
 * Named views compose the catalog's viewpoint primitive; no camera DSL here. */
export interface ViewStateV1 {
  version: 1;
  catalog: ViewCatalog;
  time: ViewTime;
  view:
    | { kind: 'named'; name: string; fov: number }
    | { kind: 'pose'; version: 1; frame: 'ECLIPJ2000'; origin: string | null; camera: ScriptCamera };
  navigation: { selected: string | null; tracked: string | null; lookAt: string | null; mode: string };
  playback: { playing: boolean; rate: number };
  display: Partial<Record<typeof LAYERS[number]['id'], boolean>>;
}

export const MAX_VIEW_STATE_LENGTH = 8192;
// Other modes have private surface/sensor/chase parameters. Until #114 exposes
// those relationships, reject them rather than claim a reproducible raw pose.
export const PORTABLE_POSE_MODES = ['free-orbit', 'body-fixed', 'sc-fixed'] as const;

export class ViewStateError extends Error {
  constructor(message: string) { super(message); this.name = 'ViewStateError'; }
}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ViewStateError(message);
}
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Malformed view state.');
  return value as Record<string, unknown>;
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const name = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const nullableName = (v: unknown) => v === null || name(v);
const fov = (v: unknown) => finite(v) && v > 0 && v < 180;
const vec = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(x => finite(x) && Math.abs(x) <= 1e16);

/** Validate untrusted input and project onto the allowlist. Additive fields are
 * ignored, never forwarded to a script interpreter or component store. */
export function validateViewState(value: unknown): ViewStateV1 {
  const s = record(value);
  check(s.version === 1, `Unsupported view state version: ${String(s.version)}.`);
  const c = record(s.catalog);
  check((name(c.catalog) && c.entry === undefined) || (name(c.entry) && c.catalog === undefined), 'Missing or ambiguous catalog reference.');
  if (name(c.catalog)) {
    check(!/[?#\\:]/.test(c.catalog) && !c.catalog.startsWith('//'), 'Invalid catalog path.');
  }
  const t = record(s.time);
  check(t.kind === 'preserve' || (t.kind === 'system' && t.source === 'UTC') ||
    (t.kind === 'fixed' && t.source === 'ET' && finite(t.et) && Math.abs(t.et) <= 7.5e9), 'Invalid time interpretation or epoch.');
  const v = record(s.view);
  let view: ViewStateV1['view'];
  if (v.kind === 'named') {
    check(name(v.name) && fov(v.fov), 'Invalid named viewpoint or FOV.');
    view = { kind: 'named', name: v.name, fov: v.fov as number };
  } else {
    check(v.kind === 'pose' && v.version === 1 && v.frame === 'ECLIPJ2000' && nullableName(v.origin), 'Unsupported camera frame or pose version.');
    const p = record(v.camera);
    check(vec(p.position) && vec(p.target) && vec(p.up) && fov(p.fov), 'Invalid camera pose or FOV.');
    const eye = p.position as [number, number, number], target = p.target as [number, number, number], up = p.up as [number, number, number];
    const direction = eye.map((x, i) => x - target[i]);
    check(Math.hypot(...direction) > 0 && Math.hypot(...up) > 0 &&
      Math.hypot(direction[1] * up[2] - direction[2] * up[1], direction[2] * up[0] - direction[0] * up[2], direction[0] * up[1] - direction[1] * up[0]) > 0,
    'Degenerate camera pose.');
    view = { kind: 'pose', version: 1, frame: 'ECLIPJ2000', origin: v.origin as string | null,
      camera: { position: [...eye], target: [...target], up: [...up], fov: p.fov as number } };
  }
  const n = record(s.navigation), p = record(s.playback), d = record(s.display);
  check(nullableName(n.selected) && nullableName(n.tracked) && nullableName(n.lookAt), 'Invalid navigation entity.');
  check(PORTABLE_POSE_MODES.some(m => m === n.mode), `Camera mode "${String(n.mode)}" cannot yet be shared; use an orbit camera.`);
  check(n.mode === 'free-orbit' || n.tracked !== null, 'This camera mode needs a tracked entity.');
  check(typeof p.playing === 'boolean' && finite(p.rate) && Math.abs(p.rate) <= 1e12, 'Invalid playback state.');
  const display: ViewStateV1['display'] = {};
  for (const { id } of LAYERS) {
    if (Object.prototype.hasOwnProperty.call(d, id)) {
      check(typeof d[id] === 'boolean', `Invalid display option "${id}".`);
      display[id] = d[id] as boolean;
    }
  }
  return { version: 1, catalog: name(c.catalog) ? { catalog: c.catalog } : { entry: c.entry as string },
    time: t.kind === 'fixed' ? { kind: 'fixed', source: 'ET', et: t.et as number } : t.kind === 'system' ? { kind: 'system', source: 'UTC' } : { kind: 'preserve' },
    view, navigation: { selected: n.selected as string | null, tracked: n.tracked as string | null, lookAt: n.lookAt as string | null, mode: n.mode as string },
    playback: { playing: p.playing, rate: p.rate as number }, display };
}

/** JSON is encoded by URLSearchParams at the browser boundary, without DOM or
 * base64 dependencies in the portable control package. */
export function encodeViewState(state: ViewStateV1): string {
  const text = JSON.stringify(validateViewState(state));
  check(text.length <= MAX_VIEW_STATE_LENGTH, 'View state is too large for a permalink.');
  return text;
}
export function decodeViewState(text: string): ViewStateV1 {
  check(text.length <= MAX_VIEW_STATE_LENGTH, 'View state is too large for a permalink.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ViewStateError('Malformed view state JSON.'); }
  return validateViewState(value);
}

/** Reusable event/observation link hook: derive a compact context from a view
 * rather than carrying results or inventing another URL protocol. */
export function viewStateAtEpoch(state: ViewStateV1, et: number, selected = state.navigation.selected): ViewStateV1 {
  return validateViewState({ ...state, time: { kind: 'fixed', source: 'ET', et },
    navigation: { ...state.navigation, selected }, playback: { ...state.playback, playing: false } });
}

/** Calls the same typed verbs as UI/scripts. Resolve names before changing the
 * scene, and report refusals instead of silently displaying another view. */
export function applyViewState(host: ViewerControl, input: ViewStateV1, options: { systemTime?: string; afterSeek?: () => void } = {}): void {
  const s = validateViewState(input);
  const objects = host.listObjects();
  for (const entity of [s.navigation.selected, s.navigation.tracked, s.navigation.lookAt, s.view.kind === 'pose' ? s.view.origin : null]) {
    check(entity === null || objects.includes(entity), `Cannot restore view: entity "${entity}" is unavailable.`);
  }
  if (s.view.kind === 'named') check(host.listViewpoints().includes(s.view.name), `Cannot restore view: viewpoint "${s.view.name}" is unavailable.`);
  else check(host.setCameraReference, 'This viewer cannot restore explicit camera references.');
  const require = (ok: boolean, what: string) => check(ok, `Cannot restore view: ${what}.`);
  const previousTime = host.getTime();
  require(host.setPlaying(false), 'playback unavailable');
  host.clearLookAt();
  host.untrack();
  require(host.setFrame('free-orbit'), 'camera frame unavailable');
  // Named views may carry an epoch. Explicit ViewState time wins afterwards.
  if (s.view.kind === 'named') require(host.viewpoint(s.view.name), 'viewpoint unavailable');
  const namedCamera = s.view.kind === 'named' ? host.getCamera() : null;
  require(host.setTime(s.time.kind === 'fixed' ? { kind: 'et', et: s.time.et } : s.time.kind === 'system'
    ? { kind: 'calendar', text: options.systemTime ?? new Date().toISOString() } : { kind: 'et', et: previousTime }), 'epoch unavailable');
  // Renderer hosts refresh mode context at this epoch before activating a
  // rotating camera frame; otherwise its first update rotates an old-ET pose.
  options.afterSeek?.();
  if (s.navigation.tracked) require(host.track(s.navigation.tracked), 'tracked entity unavailable');
  else host.untrack();
  require(host.setFrame(s.navigation.mode), 'camera frame unavailable');
  if (s.view.kind === 'pose') {
    require(host.setCameraReference!(s.view.origin), 'camera reference unavailable');
    require(host.setCamera(s.view.camera.position, s.view.camera.target, s.view.camera.up), 'camera pose unavailable');
  }
  if (namedCamera) require(host.setCamera(namedCamera.position, namedCamera.target, namedCamera.up), 'named camera pose unavailable');
  require(host.setFov(s.view.kind === 'named' ? s.view.fov : s.view.camera.fov), 'FOV unavailable');
  if (s.navigation.lookAt) require(host.pointAtObject(s.navigation.lookAt), 'look-at entity unavailable');
  if (s.navigation.selected) require(host.select(s.navigation.selected), 'selection unavailable');
  else host.deselect();
  for (const [layer, on] of Object.entries(s.display)) require(host.setLayer(layer, on), `display layer "${layer}" unavailable`);
  require(host.setTimeRate(s.playback.rate), 'playback rate unavailable');
  require(host.setPlaying(s.playback.playing), 'playback unavailable');
}
