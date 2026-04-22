/**
 * Reactive viewer state — bridges UniverseRenderer ↔ Svelte reactivity.
 *
 * All reactive state lives in the exported `vs` object. Svelte 5 requires
 * that exported $state is either never reassigned, or wrapped in an object
 * whose properties are mutated. We use the latter.
 */
import type { Universe } from '@spicecraft/core';
import type { UniverseRenderer } from '@spicecraft/three';
import { CameraModeName, rateLabel } from '@spicecraft/three';
import { loadPrefs, savePrefs } from './persistence';

// ── Exported types ──

export interface BodyEntry {
  name: string;
  visible: boolean;
  classification?: string;
  parentName?: string;
}

// ── Single reactive state object ──

export const vs = $state({
  // Time
  et: 0,
  rate: 60,
  playing: false,
  rateText: '1 min/s',
  timeText: '--',

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
  const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
  const date = new Date(j2000Ms + etValue * 1000);
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function etToShortDate(etValue: number): string {
  if (!isFinite(etValue) || Math.abs(etValue) > MAX_SAFE_ET) {
    const years = etValue / 31556952;
    const abs = Math.abs(years);
    if (abs >= 1e6) return years >= 0 ? '+\u221E' : '-\u221E';
    return `${years >= 0 ? '+' : ''}${years.toFixed(0)}yr`;
  }
  const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
  const date = new Date(j2000Ms + etValue * 1000);
  return date.toISOString().slice(0, 10);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Setters (called from plain .ts files like loader.ts) ──

export function setSceneLoaded(v: boolean) { vs.sceneLoaded = v; }
export function setKernelCount(v: number) { vs.kernelCount = v; }
export function selectBody(name: string | null) { vs.selectedBodyName = name; }
export function setLoadingState(opts: { label?: string; detail?: string; progress?: number; show?: boolean }) {
  if (opts.label !== undefined) vs.loadingLabel = opts.label;
  if (opts.detail !== undefined) vs.loadingDetail = opts.detail;
  if (opts.progress !== undefined) vs.loadingProgress = opts.progress;
  if (opts.show !== undefined) vs.showLoading = opts.show;
}

// ── Internal sync helpers ──

function initScrubberRange() {
  if (!_universe) return;
  const range = _universe.getTimeRange();
  let min: number, max: number;
  if (range) {
    const span = range[1] - range[0];
    const pad = Math.max(span * 0.1, 86400);
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
  vs.lightingMode = prefs.lightingMode;
  renderer.setTrajectoriesVisible(prefs.showTrajectories);
  renderer.setLabelsVisible(prefs.showLabels);
  renderer.showBodyGrid(prefs.showGrid);
  renderer.showBodyAxes(prefs.showAxes);
  renderer.setLightingMode(prefs.lightingMode);
  if (prefs.fov !== 60) {
    renderer.camera.fov = prefs.fov;
    renderer.camera.updateProjectionMatrix();
  }

  const unsub = renderer.timeController.onTimeChange((newEt: number) => {
    vs.et = newEt;
    vs.timeText = etToUtcString(newEt);
    vs.playing = renderer.timeController.playing;
    vs.rate = renderer.timeController.rate;
    vs.rateText = rateLabel(renderer.timeController.rate);
  });
  _unsubscribers.push(unsub);

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

export function trackBody(name: string) {
  if (!_renderer) return;
  const bm = _renderer.getBodyMesh(name);
  if (bm) {
    _renderer.cameraController.trackBody(bm, 1e-6);
    syncCameraState();
    // Update selected body so info panel follows tracking
    if (vs.selectedBodyName) vs.selectedBodyName = name;
  }
}

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

export function setDisplayOption(option: string, value: boolean) {
  if (!_renderer) return;
  switch (option) {
    case 'trajectories':
      vs.showTrajectories = value;
      _renderer.setTrajectoriesVisible(value);
      savePrefs({ showTrajectories: value });
      break;
    case 'labels':
      vs.showLabels = value;
      _renderer.setLabelsVisible(value);
      savePrefs({ showLabels: value });
      break;
    case 'grid':
      vs.showGrid = value;
      _renderer.showBodyGrid(value);
      savePrefs({ showGrid: value });
      break;
    case 'axes':
      vs.showAxes = value;
      _renderer.showBodyAxes(value);
      savePrefs({ showAxes: value });
      break;
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
}
