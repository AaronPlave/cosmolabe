/**
 * Semantic viewpoints: a camera described by what it is relative to and what
 * it looks at, re-resolved at an epoch, rather than a stored world-space pose.
 *
 * `ViewpointDefinition` is the catalog `Viewpoint` item. Its original fields
 * (`center`, `distance`/`latitude`/`longitude`, `eye`/`target`/`up`, `time`)
 * keep exactly the meaning they always had; the semantic fields (`lookAt`,
 * `from`, a direction-valued `up`) and an honoured `frame` sit beside them.
 * The same JSON shape is the portable form: `viewpointToJson` and
 * `validateViewpoint` are the boundary a shareable view state composes, and
 * they carry no catalog identity, selection, playback or UI state.
 *
 * `resolveViewpoint` turns a definition into an eye/target/up at an epoch,
 * through the universe's frame registry and body positions. It is the one
 * place the camera relationship is computed, so a renderer, a link and a test
 * cannot disagree about what a viewpoint means.
 */
import type { Body } from './Body.js';
import type { Vec3 } from './spice-injection.js';
import { BODY_FIXED, WORLD_FRAME, type FrameRegistry } from './frames/FrameRegistry.js';
import { mat3Vec } from './frames/mat3.js';
import { bodyFixedOffsetToWorld, composeBodyToWorldQuat, rotateVecByQuat } from './kinematics.js';

export type ViewAxis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

/**
 * A direction, resolved at the viewpoint's epoch in the scene frame.
 *
 * - `toward`: from `from` (default: the viewpoint's `center`) toward `body`.
 * - `velocity`: `body`'s velocity relative to `relativeTo` (defaults: the
 *   viewpoint's `center`, and that body's active parent).
 * - `orbitNormal`: `r × v` of `body` relative to `relativeTo`, same defaults.
 * - `axis`: an axis of `frame` (default: the viewpoint's `frame`, else the
 *   scene frame). `BodyFixed` means the center's body-fixed frame.
 * - `vector`: an explicit vector in `frame`, same default.
 *
 * `negate` flips the first three: `{ kind: 'velocity', negate: true }` is
 * "behind", `{ kind: 'toward', body: 'Sun', negate: true }` is "anti-Sun".
 */
export type ViewDirection =
  | { kind: 'toward'; body: string; from?: string; negate?: boolean }
  | { kind: 'velocity'; body?: string; relativeTo?: string; negate?: boolean }
  | { kind: 'orbitNormal'; body?: string; relativeTo?: string; negate?: boolean }
  | { kind: 'axis'; axis: ViewAxis; frame?: string }
  | { kind: 'vector'; vector: Vec3; frame?: string };

/** A viewpoint definition: a catalog `Viewpoint` item, parsed. */
export interface ViewpointDefinition {
  name: string;
  /** Body the camera is placed relative to, and tracks. */
  center?: string;
  /**
   * Frame `eye`, `target`, a vector `up`, the `latitude`/`longitude` offset,
   * and `axis`/`vector` directions are stated in. `BodyFixed` is the center's
   * body-fixed frame (its parent's, for a body without a rotation model); any
   * other name goes through the frame registry, so SPICE and catalog-declared
   * frames work. When omitted, the historical defaults hold: the
   * `latitude`/`longitude` offset is body-fixed, and vectors are in the scene
   * frame (EclipticJ2000).
   */
  frame?: string;
  /** Distance from `center` in km, along `from` or the lat/lon offset. */
  distance?: number;
  /** Longitude of the offset in degrees. */
  longitude?: number;
  /** Latitude of the offset in degrees. */
  latitude?: number;
  /** Explicit eye position [x, y, z] in km relative to `center`. Overrides
   *  every other placement. */
  eye?: [number, number, number];
  /** Explicit target position [x, y, z] in km relative to `center`. */
  target?: [number, number, number];
  /** Body to look at. Overrides `target`, and keeps facing that body as time
   *  runs. Requires `center`. */
  lookAt?: string;
  /** Direction from `center` toward the camera, with `distance`. Overrides the
   *  lat/lon offset. Requires `center`. */
  from?: ViewDirection;
  /** Up direction: a vector in `frame`, or a semantic direction. Defaults to
   *  ecliptic north for a viewpoint using `from` or `lookAt`, and to +Y of the
   *  scene frame otherwise (the historical default). */
  up?: [number, number, number] | ViewDirection;
  /** Vertical field of view in degrees. */
  fov?: number;
  /**
   * The moment this viewpoint depicts, verbatim from the catalog (UTC, or a
   * Julian day number). Kept as authored so a consumer can round-trip it; use
   * `epoch` for the resolved value.
   */
  time?: string | number;
  /**
   * The moment this viewpoint depicts, in ephemeris seconds past J2000:
   * `time` resolved via SPICE `str2et` when a leapseconds kernel is
   * furnished and core's calendar parse otherwise, or an `epoch` written
   * directly (the lossless portable form).
   *
   * Undefined when the viewpoint declared no time, and also when it declared
   * one that could not be parsed (which warns). Deliberately NOT zero on
   * failure: a viewpoint that says nothing about time must leave the clock
   * alone and resolve at the current time, and 0 is a legitimate epoch, so
   * the two cases have to be distinguishable at the point of use.
   */
  epoch?: number;
}

/** A viewpoint resolved at an epoch. Positions are km in the scene frame
 *  (EclipticJ2000 axes), relative to `center` when there is one. */
export interface ResolvedViewpoint {
  center?: string;
  eye: Vec3;
  target: Vec3;
  /** Unit vector, never parallel to `target - eye`. */
  up: Vec3;
  lookAt?: string;
  fov?: number;
  et: number;
}

/** The part of `Universe` a viewpoint resolves against. */
export interface ViewpointScene {
  getBody(name: string): Body | undefined;
  absolutePositionOf(name: string, et: number): [number, number, number];
  readonly frames: FrameRegistry;
}

export class ViewpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewpointError';
  }
}

/** Where a viewpoint with no placement at all puts the eye, in km. Kept from
 *  the viewer's original fallback (300 / 500 scene units at 1e-6). */
const DEFAULT_EYE: Vec3 = [0, 3e8, 5e8];
const LEGACY_UP: Vec3 = [0, 1, 0];
const ECLIPTIC_NORTH: Vec3 = [0, 0, 1];
/** Half-step of the central difference used for velocity directions, s. */
const VELOCITY_STEP = 1;

const AXES: Record<ViewAxis, Vec3> = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0],
  '+Y': [0, 1, 0], '-Y': [0, -1, 0],
  '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

function unit(v: Vec3, what: string): Vec3 {
  const n = norm(v);
  if (!(n > 0) || !Number.isFinite(n)) throw new ViewpointError(`${what} is undefined at this epoch`);
  return scale(v, 1 / n);
}

/** True when the viewpoint uses any of the semantic fields, which changes its
 *  default `up`. */
function isSemantic(vp: ViewpointDefinition): boolean {
  return vp.from !== undefined || vp.lookAt !== undefined;
}

/** The body whose rotation orients the `BodyFixed` frame of `center`: the
 *  center itself when it spins, otherwise its parent (a lander turns with its
 *  planet). The same rule the lat/lon offset has always used. */
function spinBodyOf(scene: ViewpointScene, center: string | undefined): Body | undefined {
  const ref = center ? scene.getBody(center) : undefined;
  if (ref?.rotation) return ref;
  return ref?.parentName ? scene.getBody(ref.parentName) : undefined;
}

/** A rotation taking vectors in `frame` to the scene frame at `et`. */
function frameToWorld(
  scene: ViewpointScene,
  frame: string,
  center: string | undefined,
  et: number,
): (v: Vec3) => Vec3 {
  if (scene.frames.canonicalName(frame) === BODY_FIXED) {
    const spin = spinBodyOf(scene, center);
    const rotation = spin?.rotation;
    const q = spin?.rotationAt(et);
    if (!spin || !rotation || !q) {
      throw new ViewpointError(`frame "${frame}" needs a center with a rotation model`);
    }
    const bw = composeBodyToWorldQuat(q, rotation.sourceFrame, WORLD_FRAME, et, scene.frames);
    return (v) => rotateVecByQuat(v, bw);
  }
  const m = scene.frames.rotation(frame, WORLD_FRAME, et);
  if (!m) throw new ViewpointError(`frame "${frame}" cannot be resolved at this epoch`);
  return (v) => mat3Vec(m, v);
}

function positionOf(scene: ViewpointScene, name: string, et: number): Vec3 {
  if (!scene.getBody(name)) throw new ViewpointError(`unknown body "${name}"`);
  const p = scene.absolutePositionOf(name, et);
  if (!p.every(Number.isFinite)) throw new ViewpointError(`"${name}" has no position at this epoch`);
  return p;
}

/** Position of `body` relative to `relativeTo`, or to the universe origin. */
function relativePosition(scene: ViewpointScene, body: string, relativeTo: string | undefined, et: number): Vec3 {
  const p = positionOf(scene, body, et);
  return relativeTo ? sub(p, positionOf(scene, relativeTo, et)) : p;
}

function resolveDirection(
  scene: ViewpointScene,
  dir: ViewDirection,
  vp: ViewpointDefinition,
  et: number,
): Vec3 {
  const sign = 'negate' in dir && dir.negate ? -1 : 1;
  switch (dir.kind) {
    case 'toward': {
      const from = dir.from ?? vp.center;
      if (!from) throw new ViewpointError('a "toward" direction needs a center or "from" body');
      return scale(unit(sub(positionOf(scene, dir.body, et), positionOf(scene, from, et)), `direction toward "${dir.body}"`), sign);
    }
    case 'velocity':
    case 'orbitNormal': {
      const body = dir.body ?? vp.center;
      if (!body) throw new ViewpointError(`a "${dir.kind}" direction needs a center or "body"`);
      const b = scene.getBody(body);
      if (!b) throw new ViewpointError(`unknown body "${body}"`);
      const relativeTo = dir.relativeTo ?? b.activeParentAt(et);
      // A central difference of positions in the inertial scene frame: right
      // for every trajectory type, including body-fixed ones whose own
      // velocity is stated in a rotating frame.
      const ahead = relativePosition(scene, body, relativeTo, et + VELOCITY_STEP);
      const behind = relativePosition(scene, body, relativeTo, et - VELOCITY_STEP);
      const v = scale(sub(ahead, behind), 1 / (2 * VELOCITY_STEP));
      const what = `${dir.kind} of "${body}"${relativeTo ? ` relative to "${relativeTo}"` : ''}`;
      if (dir.kind === 'velocity') return scale(unit(v, what), sign);
      const r = relativePosition(scene, body, relativeTo, et);
      return scale(unit(cross(r, v), what), sign);
    }
    case 'axis':
    case 'vector': {
      const v = dir.kind === 'axis' ? AXES[dir.axis] : dir.vector;
      const frame = dir.frame ?? vp.frame;
      const world = frame ? frameToWorld(scene, frame, vp.center, et)(v) : v;
      return unit(world, `${dir.kind} direction`);
    }
  }
}

/** The historical `distance` + `latitude` + `longitude` placement: a
 *  body-fixed offset, oriented by the spin body at `et`, degrading to the
 *  scene frame when there is no attitude to orient against. */
function legacyOffset(scene: ViewpointScene, vp: ViewpointDefinition, et: number): Vec3 {
  const distance = vp.distance ?? 0;
  const spin = spinBodyOf(scene, vp.center);
  let q;
  try {
    q = spin?.rotationAt(et);
  } catch {
    // An attitude gap (CK coverage) at this epoch: same as no attitude.
    q = undefined;
  }
  const sourceFrame = spin?.rotation?.sourceFrame;
  if (q && sourceFrame) {
    return bodyFixedOffsetToWorld(distance, vp.latitude ?? 0, vp.longitude ?? 0, q, sourceFrame, undefined, et, scene.frames);
  }
  return bodyFixedOffsetToWorld(distance, vp.latitude ?? 0, vp.longitude ?? 0, [1, 0, 0, 0], 'EclipticJ2000');
}

function sphericalOffset(distance: number, latitudeDeg: number, longitudeDeg: number): Vec3 {
  const lat = (latitudeDeg * Math.PI) / 180;
  const lon = (longitudeDeg * Math.PI) / 180;
  return [
    distance * Math.cos(lat) * Math.cos(lon),
    distance * Math.cos(lat) * Math.sin(lon),
    distance * Math.sin(lat),
  ];
}

/** Replace an `up` parallel to the view axis, which leaves the camera's roll
 *  undefined, with the scene axis least aligned with it. */
function usableUp(up: Vec3, view: Vec3): Vec3 {
  const n = norm(view);
  if (!(n > 0) || norm(cross(up, view)) > 1e-9 * n) return up;
  const candidates: Vec3[] = [ECLIPTIC_NORTH, LEGACY_UP, [1, 0, 0]];
  let best = candidates[0];
  for (const c of candidates) {
    if (norm(cross(c, view)) > norm(cross(best, view))) best = c;
  }
  return best;
}

/**
 * Resolve `vp` at `et`. Throws `ViewpointError` naming the reference that
 * cannot be resolved — an unknown body, a body with no position or a frame
 * with no rotation at that epoch — rather than showing a different view.
 *
 * Callers choose `et`: the viewpoint's own `epoch` when it has one, and the
 * current simulation time otherwise, so a timeless "sun-side view of the
 * spacecraft" follows the clock.
 */
export function resolveViewpoint(scene: ViewpointScene, vp: ViewpointDefinition, et: number): ResolvedViewpoint {
  const { center } = vp;
  if (center && !scene.getBody(center)) throw new ViewpointError(`unknown center body "${center}"`);
  if ((vp.lookAt || vp.from) && !center) throw new ViewpointError('"lookAt" and "from" need a center');
  const toWorld = vp.frame !== undefined ? frameToWorld(scene, vp.frame, center, et) : undefined;
  const inFrame = (v: Vec3): Vec3 => (toWorld ? toWorld(v) : [v[0], v[1], v[2]]);

  let eye: Vec3;
  if (vp.eye) {
    eye = inFrame(vp.eye);
  } else if (vp.from) {
    if (vp.distance === undefined) throw new ViewpointError('"from" needs a distance');
    eye = scale(resolveDirection(scene, vp.from, vp, et), vp.distance);
  } else if (vp.distance !== undefined) {
    eye = toWorld
      ? toWorld(sphericalOffset(vp.distance, vp.latitude ?? 0, vp.longitude ?? 0))
      : legacyOffset(scene, vp, et);
  } else {
    eye = [...DEFAULT_EYE];
  }

  let target: Vec3 = [0, 0, 0];
  if (vp.lookAt) target = sub(positionOf(scene, vp.lookAt, et), positionOf(scene, center!, et));
  else if (vp.target) target = inFrame(vp.target);

  let up: Vec3;
  if (vp.up === undefined) up = isSemantic(vp) ? [...ECLIPTIC_NORTH] : [...LEGACY_UP];
  else if (Array.isArray(vp.up)) up = unit(inFrame(vp.up), 'up vector');
  else up = resolveDirection(scene, vp.up, vp, et);
  up = usableUp(up, sub(target, eye));

  return { center, eye, target, up, lookAt: vp.lookAt, fov: vp.fov, et };
}

/** Every body name a viewpoint refers to. For load-time checks. */
export function viewpointBodies(vp: ViewpointDefinition): string[] {
  const names = new Set<string>();
  const add = (n: string | undefined) => { if (n) names.add(n); };
  add(vp.center);
  add(vp.lookAt);
  for (const dir of [vp.from, Array.isArray(vp.up) ? undefined : vp.up]) {
    if (!dir) continue;
    if (dir.kind === 'toward') { add(dir.body); add(dir.from); }
    if (dir.kind === 'velocity' || dir.kind === 'orbitNormal') { add(dir.body); add(dir.relativeTo); }
  }
  return [...names];
}

// --- Parsing and the portable form ------------------------------------------

const DIRECTION_KINDS = ['toward', 'velocity', 'orbitNormal', 'axis', 'vector'] as const;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const vec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Parse a direction object, reporting what is wrong with it. */
function parseDirection(raw: unknown, field: string, report: (msg: string) => void): ViewDirection | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    report(`"${field}" must be a direction object`);
    return undefined;
  }
  const d = raw as Record<string, unknown>;
  const kind = d.kind;
  if (!DIRECTION_KINDS.includes(kind as typeof DIRECTION_KINDS[number])) {
    report(`"${field}.kind" must be one of ${DIRECTION_KINDS.join(', ')}`);
    return undefined;
  }
  const optName = (key: string): string | undefined | null => {
    if (d[key] === undefined) return undefined;
    if (nonEmpty(d[key])) return d[key];
    report(`"${field}.${key}" must be a body name`);
    return null;
  };
  const negate = d.negate === undefined ? undefined : d.negate === true;
  if (d.negate !== undefined && typeof d.negate !== 'boolean') report(`"${field}.negate" must be a boolean`);
  switch (kind) {
    case 'toward': {
      const from = optName('from');
      if (!nonEmpty(d.body)) { report(`"${field}.body" must be a body name`); return undefined; }
      if (from === null) return undefined;
      return { kind, body: d.body, ...(from ? { from } : {}), ...(negate ? { negate } : {}) };
    }
    case 'velocity':
    case 'orbitNormal': {
      const body = optName('body');
      const relativeTo = optName('relativeTo');
      if (body === null || relativeTo === null) return undefined;
      return { kind, ...(body ? { body } : {}), ...(relativeTo ? { relativeTo } : {}), ...(negate ? { negate } : {}) };
    }
    case 'axis':
    case 'vector': {
      const frame = d.frame === undefined ? undefined : nonEmpty(d.frame) ? d.frame : null;
      if (frame === null) { report(`"${field}.frame" must be a frame name`); return undefined; }
      if (kind === 'axis') {
        if (typeof d.axis !== 'string' || !(d.axis in AXES)) {
          report(`"${field}.axis" must be one of ${Object.keys(AXES).join(', ')}`);
          return undefined;
        }
        return { kind, axis: d.axis as ViewAxis, ...(frame ? { frame } : {}) };
      }
      if (!vec3(d.vector) || norm(d.vector) === 0) {
        report(`"${field}.vector" must be a non-zero [x, y, z]`);
        return undefined;
      }
      return { kind, vector: [d.vector[0], d.vector[1], d.vector[2]], ...(frame ? { frame } : {}) };
    }
  }
  return undefined;
}

/** A catalog number: a number, or a string with an optional unit suffix
 *  (`parseFloat`), as catalog items have always been read. */
function catalogNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the fields of a `Viewpoint` item. Anything malformed is reported and
 * left out, so a catalog with one bad field still loads. `time` is kept
 * verbatim; resolving it to `epoch` needs the loader's time parser. A numeric
 * `epoch` (ET seconds) is taken as is.
 */
export function parseViewpoint(raw: Record<string, unknown>, report: (msg: string) => void): ViewpointDefinition {
  const vp: ViewpointDefinition = { name: nonEmpty(raw.name) ? raw.name : '' };
  if (!vp.name) report('"name" must be a non-empty string');
  const name = (key: 'center' | 'frame' | 'lookAt') => {
    if (raw[key] === undefined || raw[key] === null) return;
    if (nonEmpty(raw[key])) vp[key] = raw[key] as string;
    else report(`"${key}" must be a non-empty string`);
  };
  name('center');
  name('frame');
  name('lookAt');
  for (const key of ['distance', 'longitude', 'latitude', 'fov'] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const n = catalogNumber(raw[key]);
    if (n === undefined) report(`"${key}" must be a number`);
    else vp[key] = n;
  }
  if (vp.fov !== undefined && !(vp.fov > 0 && vp.fov < 180)) {
    report('"fov" must be between 0 and 180 degrees');
    delete vp.fov;
  }
  for (const key of ['eye', 'target'] as const) {
    if (raw[key] === undefined) continue;
    const v = Array.isArray(raw[key]) ? (raw[key] as unknown[]).map(Number) : undefined;
    if (vec3(v)) vp[key] = v;
    else report(`"${key}" must be [x, y, z]`);
  }
  if (raw.up !== undefined) {
    if (Array.isArray(raw.up)) {
      const v = raw.up.map(Number);
      if (vec3(v) && norm(v) > 0) vp.up = v;
      else report('"up" must be a non-zero [x, y, z] or a direction');
    } else {
      const up = parseDirection(raw.up, 'up', report);
      if (up) vp.up = up;
    }
  }
  if (raw.from !== undefined) {
    const from = parseDirection(raw.from, 'from', report);
    if (from) vp.from = from;
  }
  if (raw.time !== undefined && raw.time !== null) {
    if (typeof raw.time === 'string' || typeof raw.time === 'number') vp.time = raw.time;
    else report('"time" must be a date string or a Julian day number');
  }
  if (raw.epoch !== undefined) {
    if (typeof raw.epoch === 'number' && Number.isFinite(raw.epoch)) vp.epoch = raw.epoch;
    else report('"epoch" must be ET seconds past J2000');
  }
  if ((vp.lookAt || vp.from) && !vp.center) report('"lookAt" and "from" need a "center"');
  if (vp.from && vp.distance === undefined) report('"from" needs a "distance"');
  if (vp.lookAt && vp.target) report('"lookAt" overrides "target"');
  if (vp.from && (vp.latitude !== undefined || vp.longitude !== undefined)) {
    report('"from" overrides "latitude"/"longitude"');
  }
  return vp;
}

/**
 * Validate an untrusted viewpoint — a link, a host message — strictly: any
 * problem `parseViewpoint` would report is an error here. Unknown fields are
 * ignored. The portable form carries `epoch` (ET), not `time`, so no calendar
 * parse is needed to restore it.
 */
export function validateViewpoint(value: unknown): ViewpointDefinition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ViewpointError('Malformed viewpoint.');
  }
  const issues: string[] = [];
  const vp = parseViewpoint(value as Record<string, unknown>, (m) => issues.push(m));
  if (vp.time !== undefined) issues.push('the portable form carries "epoch", not "time"');
  if (issues.length) throw new ViewpointError(`Invalid viewpoint: ${issues.join('; ')}.`);
  return vp;
}

/** The portable JSON form of a viewpoint: a catalog `Viewpoint` item with its
 *  resolved `epoch` in place of the authored `time`. `validateViewpoint`
 *  reads it back unchanged. */
export function viewpointToJson(vp: ViewpointDefinition): Record<string, unknown> {
  const { time: _time, ...rest } = vp;
  const out: Record<string, unknown> = { type: 'Viewpoint' };
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) out[k] = typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

// --- Vector-derived presets ---------------------------------------------------

/** The vector-derived views: looking down on the orbit plane, from the Sun's
 *  side, and from behind along the direction of travel. */
export type ViewPreset = 'top' | 'sun' | 'velocity';

/**
 * A preset as an ordinary semantic viewpoint, so it resolves, follows the
 * clock and serializes like any catalog viewpoint rather than living as a
 * separate camera mode. Velocity and orbit normal are relative to the
 * center's active parent unless `relativeTo` says otherwise; `sun` names the
 * body the Sun view looks away from.
 *
 * - `top`: above the orbit plane (`r × v`), up along the velocity.
 * - `sun`: on the line from `center` to the Sun, up toward ecliptic north.
 * - `velocity`: behind `center`, looking along its velocity, up along the
 *   orbit normal.
 */
export function presetViewpoint(
  preset: ViewPreset,
  center: string,
  distance: number,
  opts: { relativeTo?: string; sun?: string; name?: string } = {},
): ViewpointDefinition {
  const rel = opts.relativeTo ? { relativeTo: opts.relativeTo } : {};
  const name = opts.name ?? `${center}: ${preset}`;
  switch (preset) {
    case 'top':
      return { name, center, distance, from: { kind: 'orbitNormal', ...rel }, up: { kind: 'velocity', ...rel } };
    case 'sun':
      return { name, center, distance, from: { kind: 'toward', body: opts.sun ?? 'Sun' } };
    case 'velocity':
      return { name, center, distance, from: { kind: 'velocity', negate: true, ...rel }, up: { kind: 'orbitNormal', ...rel } };
  }
}
