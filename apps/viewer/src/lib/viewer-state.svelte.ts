/**
 * Reactive viewer state — bridges UniverseRenderer ↔ Svelte reactivity.
 *
 * All reactive state lives in the exported `vs` object. Svelte 5 requires
 * that exported $state is either never reassigned, or wrapped in an object
 * whose properties are mutated. We use the latter.
 */
import { etToDate, type Universe } from '@cosmolabe/core';
import type { UniverseRenderer } from '@cosmolabe/three';
import { CameraModeName, rateLabel } from '@cosmolabe/three';
import { loadPrefs, savePrefs } from './persistence';

// ── Exported types ──

export interface BodyEntry {
  name: string;
  visible: boolean;
  classification?: string;
  parentName?: string;
}

/**
 * The display layers `setDisplayOption` understands.
 *
 * A closed list, not a `string`, so the switch below can end in an exhaustive
 * `never` and a mistyped option becomes a compile error rather than a silent
 * no-op. `@cosmolabe/control`'s `LAYERS` is the same list on the pure side;
 * `__tests__/viewer-control.test.ts` pins the two together, since this is the
 * only workspace that can see both.
 */
export const DISPLAY_OPTIONS = [
  'trajectories',
  'labels',
  'grid',
  'axes',
  'sensors',
  'sensorLabels',
] as const;

export type DisplayOption = (typeof DISPLAY_OPTIONS)[number];

export function isDisplayOption(value: string): value is DisplayOption {
  return (DISPLAY_OPTIONS as readonly string[]).includes(value);
}

/** Events the app publishes, independent of which renderer is mounted. */
export interface ViewerEventMap {
  /** The selection changed; null when it cleared. */
  select: string | null;
  /** Scene time moved. */
  time: number;
  /** A scene finished loading; the payload is its object list. */
  load: readonly string[];
}

// ── Single reactive state object ──

export const vs = $state({
  // Time
  et: 0,
  rate: 60,
  playing: false,
  rateText: '1 min/s',
  timeText: '--',
  /** Increments on every animation frame so components that read live renderer
   *  state (e.g. bm.position which updates per-frame, not per-time-change) can
   *  trigger re-derivation by reading `vs.frameTick`. */
  frameTick: 0,

  // Camera
  cameraMode: CameraModeName.FREE_ORBIT as CameraModeName,
  trackedBodyName: null as string | null,
  lookAtBodyName: null as string | null,

  // Scene
  bodies: [] as BodyEntry[],
  kernelCount: 0,

  // Display
  showTrajectories: true,
  showLabels: true,
  showGrid: false,
  showAxes: false,
  showSensors: true,
  showSensorLabels: true,
  showStats: false,
  lightingMode: 'natural' as 'natural' | 'shadow' | 'flood',

  // Scrubber
  scrubMin: 0,
  scrubMax: 0,
  scrubBaseMin: 0,
  scrubBaseMax: 0,

  // UI
  sceneLoaded: false,
  loadingProgress: 0,
  loadingLabel: '',
  loadingDetail: '',
  showLoading: false,

  // Selected body (set on dblclick, cleared on dismiss)
  selectedBodyName: null as string | null,

  /** Caption over the viewport, from `displayNote`. Null when there is none. */
  note: null as string | null,
});

// ── Renderer reference (not reactive — internal only) ──

let _renderer: UniverseRenderer | null = null;
let _universe: Universe | null = null;
let _unsubscribers: (() => void)[] = [];

// ── Utilities ──

const MAX_SAFE_ET = 7.5e9;

export function etToUtcString(etValue: number): string {
  if (!isFinite(etValue) || Math.abs(etValue) > MAX_SAFE_ET) {
    const years = etValue / 31556952;
    return `J2000 ${years >= 0 ? '+' : ''}${years.toFixed(1)} yr`;
  }
  return etToDate(etValue).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function etToShortDate(etValue: number): string {
  if (!isFinite(etValue) || Math.abs(etValue) > MAX_SAFE_ET) {
    const years = etValue / 31556952;
    const abs = Math.abs(years);
    if (abs >= 1e6) return years >= 0 ? '+\u221E' : '-\u221E';
    return `${years >= 0 ? '+' : ''}${years.toFixed(0)}yr`;
  }
  return etToDate(etValue).toISOString().slice(0, 10);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Setters (called from plain .ts files like loader.ts) ──

export function setSceneLoaded(v: boolean) { vs.sceneLoaded = v; }
export function setKernelCount(v: number) { vs.kernelCount = v; }
export function selectBody(name: string | null) {
  vs.selectedBodyName = name;
  emit('select', name);
}
export function setLoadingState(opts: { label?: string; detail?: string; progress?: number; show?: boolean }) {
  if (opts.label !== undefined) vs.loadingLabel = opts.label;
  if (opts.detail !== undefined) vs.loadingDetail = opts.detail;
  if (opts.progress !== undefined) vs.loadingProgress = opts.progress;
  if (opts.show !== undefined) vs.showLoading = opts.show;
}

// ── App-level events ──
//
// Subscriptions live here rather than on the renderer's own bus because a
// renderer is not durable: `loadDemo` builds a new `UniverseRenderer` for every
// catalog. A host that subscribed to the previous one would keep receiving
// events from a scene that is no longer on screen — and, worse, silently stop
// receiving them from the one that is.

const _eventListeners = new Map<string, Set<(data: never) => void>>();

export function onViewerEvent<K extends keyof ViewerEventMap>(
  event: K,
  cb: (data: ViewerEventMap[K]) => void,
): () => void {
  let set = _eventListeners.get(event);
  if (!set) {
    set = new Set();
    _eventListeners.set(event, set);
  }
  set.add(cb as (data: never) => void);
  return () => void set.delete(cb as (data: never) => void);
}

function emit<K extends keyof ViewerEventMap>(event: K, data: ViewerEventMap[K]) {
  for (const cb of _eventListeners.get(event) ?? []) {
    try {
      (cb as (d: ViewerEventMap[K]) => void)(data);
    } catch (err) {
      console.error(`[Cosmolabe] viewer event handler error for '${event}':`, err);
    }
  }
}

// ── Internal sync helpers ──

function initScrubberRange() {
  if (!_universe) return;
  const range = _universe.getTimeRange();
  let min: number, max: number;
  if (range) {
    const span = range[1] - range[0];
    // Pad by 10 % of the span, but never less than 5 s (so short missions like
    // Ingenuity Flight 1 — 39 s — don't get drowned in a 1-day scrubber window)
    // and never more than 1 day (so multi-decade ephemerides don't add a decade).
    const pad = Math.max(5, Math.min(span * 0.1, 86400));
    min = range[0] - pad;
    max = range[1] + pad;
  } else {
    const oneYear = 31556952;
    min = vs.et - oneYear;
    max = vs.et + oneYear;
  }
  vs.scrubMin = min;
  vs.scrubMax = max;
  vs.scrubBaseMin = min;
  vs.scrubBaseMax = max;
}

function syncTimeState() {
  if (!_renderer) return;
  const tc = _renderer.timeController;
  vs.et = tc.et;
  vs.rate = tc.rate;
  vs.playing = tc.playing;
  vs.rateText = rateLabel(tc.rate);
  vs.timeText = etToUtcString(tc.et);
}

function syncCameraState() {
  if (!_renderer) return;
  const cc = _renderer.cameraController;
  vs.cameraMode = cc.mode;
  vs.trackedBodyName = cc.trackedBody?.body.name ?? null;
  vs.lookAtBodyName = cc.lookAtBody?.body.name ?? null;
}

// ── Renderer binding ──

export function bindRenderer(renderer: UniverseRenderer, universe: Universe) {
  unbindRenderer();
  _renderer = renderer;
  _universe = universe;

  // Restore persisted display preferences
  const prefs = loadPrefs();
  vs.showTrajectories = prefs.showTrajectories;
  vs.showLabels = prefs.showLabels;
  vs.showGrid = prefs.showGrid;
  vs.showAxes = prefs.showAxes;
  vs.showSensors = prefs.showSensors;
  vs.showSensorLabels = prefs.showSensorLabels;
  vs.lightingMode = prefs.lightingMode;
  renderer.setTrajectoriesVisible(prefs.showTrajectories);
  renderer.setLabelsVisible(prefs.showLabels);
  renderer.showBodyGrid(prefs.showGrid);
  renderer.showBodyAxes(prefs.showAxes);
  renderer.setSensorLabelsVisible(prefs.showSensorLabels);
  renderer.setSensorsVisible(prefs.showSensors);
  renderer.setLightingMode(prefs.lightingMode);
  // Not re-saved: this is restoring what was saved, not a new choice.
  if (prefs.fov !== 60) setFov(prefs.fov, { persist: false });

  const unsub = renderer.timeController.onTimeChange((newEt: number) => {
    vs.et = newEt;
    vs.timeText = etToUtcString(newEt);
    vs.playing = renderer.timeController.playing;
    vs.rate = renderer.timeController.rate;
    vs.rateText = rateLabel(renderer.timeController.rate);
    emit('time', newEt);
  });
  _unsubscribers.push(unsub);

  // Drive a per-frame tick so components that depend on live renderer state
  // (e.g. body mesh positions) can re-derive once per render, even while
  // playback is paused.
  let rafId = 0;
  const tick = () => {
    vs.frameTick++;
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  _unsubscribers.push(() => cancelAnimationFrame(rafId));

  syncTimeState();
  syncCameraState();
  initScrubberRange();
}

export function unbindRenderer() {
  for (const unsub of _unsubscribers) unsub();
  _unsubscribers = [];
  _renderer = null;
  _universe = null;
}

export function getRenderer(): UniverseRenderer | null {
  return _renderer;
}

// ── Commands ──

export function togglePlay() {
  if (!_renderer) return;
  _renderer.timeController.toggle();
  syncTimeState();
}

export function reverse() {
  if (!_renderer) return;
  _renderer.timeController.reverse();
  if (!_renderer.timeController.playing) _renderer.timeController.play();
  syncTimeState();
}

export function stepForward() {
  _renderer?.timeController.stepForward();
}

export function stepBackward() {
  _renderer?.timeController.stepBackward();
}

export function faster() {
  if (!_renderer) return;
  _renderer.timeController.faster();
  syncTimeState();
}

export function slower() {
  if (!_renderer) return;
  _renderer.timeController.slower();
  syncTimeState();
}

export function setTime(newEt: number) {
  if (!_renderer) return;
  _renderer.timeController.setTime(newEt);
  initScrubberRange();
}

/**
 * Set the playback rate.
 *
 * `syncTimeState()` is not optional here: `TimeController.setRate` notifies
 * nothing, so without it the rate pill keeps showing the old value while the
 * clock runs at the new one. Same for `setPlaying` below and `pause()`.
 */
export function setTimeRate(rate: number) {
  if (!_renderer) return;
  _renderer.timeController.setRate(rate);
  syncTimeState();
}

export function setPlaying(on: boolean) {
  if (!_renderer) return;
  const tc = _renderer.timeController;
  if (on) tc.play();
  else tc.pause();
  syncTimeState();
}

/**
 * Advance scene time by exactly `seconds`, whatever the clock is doing.
 *
 * The deterministic counterpart to a wall-clock wait: `step` notifies, so the
 * whole scene follows, and the amount does not depend on how long a frame took.
 */
export function runTo(seconds: number) {
  if (!_renderer) return;
  _renderer.timeController.step(seconds);
  syncTimeState();
}

export function scrubTo(fraction: number) {
  if (!_renderer) return;
  const newEt = vs.scrubMin + fraction * (vs.scrubMax - vs.scrubMin);
  _renderer.timeController.setTime(newEt);
}

export function zoomScrubber(zoomIn: boolean) {
  const ZOOM_FACTOR = 0.8;
  const MIN_RANGE = 10; // seconds
  const factor = zoomIn ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;

  // Clamp anchor to the current view so playback drift doesn't blow up the range
  const anchor = Math.max(vs.scrubMin, Math.min(vs.scrubMax, vs.et));
  let newMin = anchor - (anchor - vs.scrubMin) * factor;
  let newMax = anchor + (vs.scrubMax - anchor) * factor;

  if (zoomIn && newMax - newMin < MIN_RANGE) return;

  // Always clamp to base range
  newMin = Math.max(newMin, vs.scrubBaseMin);
  newMax = Math.min(newMax, vs.scrubBaseMax);

  vs.scrubMin = newMin;
  vs.scrubMax = newMax;
}

export function panScrubber(centerFraction: number) {
  const span = vs.scrubMax - vs.scrubMin;
  const baseRange = vs.scrubBaseMax - vs.scrubBaseMin;
  const center = vs.scrubBaseMin + centerFraction * baseRange;
  let newMin = center - span / 2;
  let newMax = center + span / 2;

  if (newMin < vs.scrubBaseMin) {
    newMin = vs.scrubBaseMin;
    newMax = newMin + span;
  }
  if (newMax > vs.scrubBaseMax) {
    newMax = vs.scrubBaseMax;
    newMin = newMax - span;
  }

  vs.scrubMin = newMin;
  vs.scrubMax = newMax;
}

/** Set the scrubber to a specific duration (in seconds) centered on current time */
export function setZoomDuration(seconds: number) {
  const half = seconds / 2;
  let newMin = vs.et - half;
  let newMax = vs.et + half;

  // Clamp to base range
  if (newMin < vs.scrubBaseMin) {
    newMin = vs.scrubBaseMin;
    newMax = newMin + seconds;
  }
  if (newMax > vs.scrubBaseMax) {
    newMax = vs.scrubBaseMax;
    newMin = newMax - seconds;
  }

  vs.scrubMin = newMin;
  vs.scrubMax = newMax;
}

export function resetScrubberZoom() {
  vs.scrubMin = vs.scrubBaseMin;
  vs.scrubMax = vs.scrubBaseMax;
}

export function setBodyVisible(name: string, visible: boolean) {
  if (!_renderer) return;
  _renderer.setBodyVisible(name, visible);
  const b = vs.bodies.find(b => b.name === name);
  if (b) b.visible = visible;
}

export function showAllBodies() {
  if (!_renderer) return;
  for (const b of vs.bodies) {
    b.visible = true;
    _renderer.setBodyVisible(b.name, true);
  }
}

export function hideAllBodies() {
  if (!_renderer) return;
  for (const b of vs.bodies) {
    b.visible = false;
    _renderer.setBodyVisible(b.name, false);
  }
}

export function trackBody(name: string): boolean {
  if (!_renderer) return false;
  const bm = _renderer.getBodyMesh(name);
  if (!bm) return false;
  _renderer.cameraController.trackBody(bm, 1e-6);
  syncCameraState();
  // Update selected body so info panel follows tracking
  if (vs.selectedBodyName) selectBody(name);
  return true;
}

/**
 * Track an object and frame it. Cuts by default.
 *
 * Not animating is the default because `flyTo` is a one-second rAF animation
 * that nulls the track target for its duration and only installs the new origin
 * body on completion: a caller that renders a frame and photographs it gets the
 * camera mid-flight. `trackBody` reaches the same end state synchronously.
 */
export function gotoObject(
  name: string,
  opts: { animate?: boolean; duration?: number } = {},
): boolean {
  if (!_renderer) return false;
  const bm = _renderer.getBodyMesh(name);
  if (!bm) return false;
  if (opts.animate) {
    _renderer.cameraController.flyTo(bm, { scaleFactor: 1e-6, duration: opts.duration });
    // flyTo defers the actual tracking to _pendingOriginSwitch; the UI needs to
    // know now, or the HUD reads the previous body for the length of the flight.
    vs.trackedBodyName = name;
  } else {
    _renderer.cameraController.trackBody(bm, 1e-6);
    syncCameraState();
  }
  return true;
}

/** Release the tracked object. The camera stays where it is. */
export function untrack() {
  if (!_renderer) return;
  _renderer.cameraController.stopTracking();
  syncCameraState();
}

/**
 * Aim the camera at an object. Unlike `lookAtBody`, this does not toggle —
 * a script that says "point at Titan" twice must not end up pointing at nothing.
 */
export function pointAtObject(name: string): boolean {
  if (!_renderer) return false;
  const bm = _renderer.getBodyMesh(name);
  if (!bm) return false;
  _renderer.cameraController.lookAt(bm);
  syncCameraState();
  return true;
}

/** Apply a named catalog viewpoint, seeking the clock if it declares an epoch. */
export function applyViewpoint(name: string): boolean {
  if (!_renderer) return false;
  if (!_renderer.applyNamedViewpoint(name)) return false;
  // A viewpoint can move the clock and change what is tracked, and neither
  // path notifies.
  syncTimeState();
  syncCameraState();
  return true;
}

/** Vertical field of view, in degrees. */
export function setFov(deg: number, opts: { persist?: boolean } = {}) {
  if (!_renderer) return;
  _renderer.camera.fov = deg;
  _renderer.camera.updateProjectionMatrix();
  if (opts.persist !== false) savePrefs({ fov: deg });
}

/**
 * Place the camera at an explicit eye position, in km.
 *
 * Positions are in km (the catalog convention); scene units are km × the
 * renderer's scale factor, so the conversion happens here — the same one
 * `camera-view-io.ts` does on the way in and out of its JSON.
 */
export function setCameraPose(
  position: readonly [number, number, number],
  target?: readonly [number, number, number],
  up?: readonly [number, number, number],
): boolean {
  if (!_renderer) return false;
  const cc = _renderer.cameraController;
  const sf = _renderer.scaleFactor;
  cc.cancelAnimation();
  cc.camera.position.set(position[0] * sf, position[1] * sf, position[2] * sf);
  // The orbit target is where the camera *looks*; without it a pose says where
  // the camera stands and nothing about what it sees. Defaulting to the origin
  // keeps the two-argument form meaning what it used to: the origin is the
  // tracked body when one is tracked, and the world origin otherwise.
  if (target) cc.controls.target.set(target[0] * sf, target[1] * sf, target[2] * sf);
  else cc.controls.target.set(0, 0, 0);
  if (up) cc.camera.up.set(up[0], up[1], up[2]).normalize();
  return true;
}

/** Show or hide one object's trajectory line. False if there is no such object. */
export function setTrajectoryVisible(name: string, visible: boolean): boolean {
  if (!_renderer || !_renderer.getBodyMesh(name)) return false;
  _renderer.setTrajectoryVisible(name, visible);
  return true;
}

/** Show or hide one object's label. False if there is no such object. */
export function setLabelVisible(name: string, visible: boolean): boolean {
  if (!_renderer || !_renderer.getBodyMesh(name)) return false;
  _renderer.setLabelVisible(name, visible);
  return true;
}

export function hasBody(name: string): boolean {
  return _renderer?.getBodyMesh(name) !== undefined;
}

/**
 * Names of the objects in the loaded scene — the ones a script can act on.
 *
 * Read through the renderer, not off `vs.bodies`, and the difference is real
 * rather than stylistic. `vs.bodies` mirrors `universe.getAllBodies()`, which
 * includes catalog items the renderer never gives a `BodyMesh`: `cassini-soi`
 * ships a "Saturn Rings" body drawn as part of Saturn. Listing it here while
 * `hasBody` — and therefore `gotoObject`, `track`, `showLabel` and every other
 * object verb — refuses it would make the "did you mean …?" suggester propose a
 * name that cannot work.
 */
export function bodyNames(): string[] {
  return _renderer?.getBodyNames() ?? [];
}

/**
 * Show a caption over the viewport.
 *
 * Omitting the duration leaves it up. Cosmographia's `displayNote` always takes
 * one, but a capture fires at an uncontrolled moment after the settle, so a
 * note that always expires cannot be photographed deterministically.
 */
export function displayNote(text: string, seconds?: number) {
  if (_noteTimer !== undefined) {
    clearTimeout(_noteTimer);
    _noteTimer = undefined;
  }
  vs.note = text.length > 0 ? text : null;
  if (seconds !== undefined && seconds > 0 && vs.note !== null) {
    _noteTimer = setTimeout(() => {
      vs.note = null;
      _noteTimer = undefined;
    }, seconds * 1000);
  }
}

/**
 * Whether the caption on screen is on a timer.
 *
 * A timed note is an event in a sequence, not state the view is in, so
 * `snapshot()` leaves it out: reproducing one would either resurrect a caption
 * that has already gone, or mean modelling how much of its duration is left. A
 * persistent note is view state and is reproduced.
 */
export function noteIsTimed(): boolean {
  return _noteTimer !== undefined;
}

let _noteTimer: ReturnType<typeof setTimeout> | undefined;

export function flyToTracked() {
  if (!_renderer) return;
  const tracked = _renderer.cameraController.trackedBody;
  if (tracked) _renderer.cameraController.flyTo(tracked, { scaleFactor: 1e-6 });
}

export function clearLookAt() {
  if (!_renderer) return;
  _renderer.cameraController.clearLookAt();
  syncCameraState();
}

export function lookAtBody(name: string) {
  if (!_renderer) return;
  const bm = _renderer.getBodyMesh(name);
  if (bm) {
    if (_renderer.cameraController.lookAtBody === bm) {
      _renderer.cameraController.clearLookAt();
    } else {
      _renderer.cameraController.lookAt(bm);
    }
    syncCameraState();
  }
}

/**
 * Show or hide a display layer.
 *
 * `persist: false` opts out of writing the user's saved preferences — a script
 * or an embed host driving the view should not silently rewrite what the person
 * chose in the Display panel and will see again on their next visit.
 */
export function setDisplayOption(
  option: DisplayOption,
  value: boolean,
  opts: { persist?: boolean } = {},
) {
  if (!_renderer) return;
  const persist = opts.persist !== false;
  switch (option) {
    case 'trajectories':
      vs.showTrajectories = value;
      _renderer.setTrajectoriesVisible(value);
      if (persist) savePrefs({ showTrajectories: value });
      break;
    case 'labels':
      vs.showLabels = value;
      _renderer.setLabelsVisible(value);
      if (persist) savePrefs({ showLabels: value });
      break;
    case 'grid':
      vs.showGrid = value;
      _renderer.showBodyGrid(value);
      if (persist) savePrefs({ showGrid: value });
      break;
    case 'axes':
      vs.showAxes = value;
      _renderer.showBodyAxes(value);
      if (persist) savePrefs({ showAxes: value });
      break;
    case 'sensors':
      vs.showSensors = value;
      _renderer.setSensorsVisible(value);
      if (persist) savePrefs({ showSensors: value });
      break;
    case 'sensorLabels':
      vs.showSensorLabels = value;
      _renderer.setSensorLabelsVisible(value);
      if (persist) savePrefs({ showSensorLabels: value });
      break;
    default: {
      // Exhaustive: adding a DISPLAY_OPTIONS entry without a case here is a
      // compile error, not a toggle that quietly does nothing.
      const unreachable: never = option;
      throw new Error(`unhandled display option ${String(unreachable)}`);
    }
  }
}

export function setLighting(mode: 'natural' | 'shadow' | 'flood') {
  if (!_renderer) return;
  vs.lightingMode = mode;
  _renderer.setLightingMode(mode);
  savePrefs({ lightingMode: mode });
}

export function setCameraMode(mode: CameraModeName) {
  if (!_renderer) return;
  const cc = _renderer.cameraController;
  cc.setModeForBody(mode, cc.trackedBody);
  syncCameraState();
}

/**
 * Switch camera mode, optionally re-parameterizing it onto a named object.
 *
 * The object is tracked **before** the mode switch, and the order is not
 * cosmetic: `setModeForBody` only re-parameterizes the mode, so asking for
 * body-fixed/Mars while still tracking Cassini gives a camera locked to Mars's
 * rotation but orbiting Cassini — a picture that looks plausible and is wrong.
 */
export function setCameraModeForBody(mode: CameraModeName, bodyName?: string): boolean {
  if (!_renderer) return false;
  const cc = _renderer.cameraController;
  if (bodyName !== undefined) {
    const bm = _renderer.getBodyMesh(bodyName);
    if (!bm) return false;
    cc.trackBody(bm, 1e-6);
  }
  const ok = cc.setModeForBody(mode, cc.trackedBody);
  syncCameraState();
  return ok;
}

export function cycleCamera(): CameraModeName {
  if (!_renderer) return CameraModeName.FREE_ORBIT;
  const next = _renderer.cameraController.cycleMode();
  syncCameraState();
  return next;
}

export function resetCamera() {
  if (!_renderer) return;
  _renderer.cameraController.resetToFreeOrbit();
  syncCameraState();
}

export function syncBodies(universe: Universe) {
  const allBodies = universe.getAllBodies();
  vs.bodies = allBodies.map(b => ({
    name: b.name,
    visible: true,
    classification: b.classification,
    parentName: b.parentName,
  }));
  emit('load', vs.bodies.map(b => b.name));
}
