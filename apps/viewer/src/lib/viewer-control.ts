/**
 * The viewer's implementation of `ViewerControl`.
 *
 * One file, written straight over `viewer-state.svelte.ts` and the current
 * renderer. There is no `ViewerControlDeps` interface here on purpose: a
 * seventeen-method injection seam whose only job was to dodge an untestable
 * import would have been all cost. The root `vitest.config.ts` gives
 * `apps/viewer` the Svelte plugin instead, so this module — and the rune module
 * under it — are directly testable.
 *
 * Two rules everything in here follows:
 *
 * **Read `getRenderer()` inside every method, and reach objects through
 * `hasBody` / `bodyNames`.** `loadDemo` builds a whole new `UniverseRenderer`
 * and `syncBodies` reassigns `vs.bodies` wholesale, so a host that closed over
 * either would go on driving the previous catalog's scene without a word.
 *
 * **Return `false`, never throw, for "no such name."** The port does not know
 * the line number; the interpreter does, and turns the `false` into a located
 * error with a suggestion drawn from the scene actually loaded.
 */
import type { SpiceInstance } from '@cosmolabe/spice';
import { etFromCalendarString } from '@cosmolabe/core';
import { CameraModeName } from '@cosmolabe/three';
import {
  snapshotScript,
  type ScriptCamera,
  type ScriptEventMap,
  type ScriptEventName,
  type ScriptImage,
  type ScriptTime,
  type ScriptVec3,
  type ViewerControl,
  type ViewerSnapshotState,
} from '@cosmolabe/control';
import {
  vs,
  applyViewpoint,
  bodyNames,
  displayNote,
  getRenderer,
  gotoObject,
  hasBody,
  isDisplayOption,
  onViewerEvent,
  pointAtObject,
  runTo,
  selectBody,
  setBodyVisible,
  setCameraModeForBody,
  setCameraPose,
  setDisplayOption,
  setFov,
  setLabelVisible,
  setPlaying,
  setTime,
  setTimeRate,
  setTrajectoryVisible,
  trackBody,
  untrack,
} from './viewer-state.svelte';
import { etToIso } from './camera-view-io';
import { captureFilename, captureFrameDataUrl, downloadDataUrl, setVideoRecording } from './capture';

export interface ViewerControlDeps {
  /**
   * The SPICE instance, if one is furnished.
   *
   * Injected rather than imported from `loader.ts`, which would make a cycle:
   * the loader is what constructs this. Legitimately null on a kernel-free
   * scene like `earth-moon` — which is exactly the case `resolveEpoch` below
   * has to keep working for.
   */
  getSpice?: () => SpiceInstance | null;
}

/**
 * Seconds past J2000 for a time a script asked for, or null if it cannot be read.
 *
 * SPICE first where it exists — `str2et` accepts day-of-year, JD and era forms
 * this does not — then core's leap-second-exact calendar parse. Null, never 0:
 * J2000 is a perfectly good epoch to ask for, so a failure that returned 0
 * would silently move the scene there. `BottomBar`'s go-to-time field does the
 * lesser version of this today and lands on *today* when SPICE is absent.
 */
function resolveEpoch(when: ScriptTime, spice: SpiceInstance | null): number | null {
  if (when.kind === 'et') return Number.isFinite(when.et) ? when.et : null;
  if (spice) {
    try {
      const et = spice.str2et(when.text);
      if (Number.isFinite(et)) return et;
    } catch {
      /* fall through to the SPICE-free parse */
    }
  }
  const et = etFromCalendarString(when.text);
  return Number.isNaN(et) ? null : et;
}

function isFrameMode(value: string): value is CameraModeName {
  return (Object.values(CameraModeName) as string[]).includes(value);
}

/** Build a `ViewerControl` over the app's current renderer and state. */
export function createViewerControl(deps: ViewerControlDeps = {}): ViewerControl {
  const spice = () => deps.getSpice?.() ?? null;

  const camera = (): ScriptCamera => {
    const r = getRenderer();
    if (!r) return { position: [0, 0, 0], up: [0, 1, 0], fov: 60 };
    // Positions are reported in km — the catalog convention, and the unit every
    // other serialization of a camera in this repo already uses.
    const inv = 1 / r.scaleFactor;
    const p = r.camera.position;
    const u = r.camera.up;
    return {
      position: [p.x * inv, p.y * inv, p.z * inv],
      up: [u.x, u.y, u.z],
      fov: r.camera.fov,
    };
  };

  const snapshotState = (): ViewerSnapshotState => {
    const r = getRenderer();
    const et = r?.timeController.et ?? vs.et;
    const tracked = r?.cameraController.trackedBody?.body.name ?? vs.trackedBodyName;
    return {
      time: et,
      timeText: etToIso(et),
      rate: r?.timeController.rate ?? vs.rate,
      playing: r?.timeController.playing ?? vs.playing,
      selected: vs.selectedBodyName,
      tracked,
      frame: { mode: vs.cameraMode, body: tracked ?? undefined },
      camera: camera(),
      layers: {
        trajectories: vs.showTrajectories,
        labels: vs.showLabels,
        grid: vs.showGrid,
        axes: vs.showAxes,
        sensors: vs.showSensors,
        sensorLabels: vs.showSensorLabels,
      },
      note: vs.note ?? undefined,
    };
  };

  return {
    // ── Write: scene setup ──
    gotoObject: (name, opts) =>
      gotoObject(name, { animate: opts?.seconds !== undefined, duration: opts?.seconds }),

    select: (name) => {
      if (!hasBody(name)) return false;
      selectBody(name);
      return true;
    },

    deselect: () => selectBody(null),

    track: (name) => trackBody(name),

    untrack: () => untrack(),

    pointAtObject: (name) => pointAtObject(name),

    viewpoint: (name) => applyViewpoint(name),

    setFrame: (mode, body) => {
      if (!isFrameMode(mode)) return false;
      return setCameraModeForBody(mode, body);
    },

    setObjectVisible: (name, visible) => {
      if (!hasBody(name)) return false;
      setBodyVisible(name, visible);
      return true;
    },

    showTrajectory: (name, visible) => setTrajectoryVisible(name, visible),

    showLabel: (name, visible) => setLabelVisible(name, visible),

    setLayer: (layer, on) => {
      if (!isDisplayOption(layer)) return false;
      if (!getRenderer()) return false;
      // `persist: false`: a script driving the view must not rewrite the
      // preferences the person set in the Display panel.
      setDisplayOption(layer, on, { persist: false });
      return true;
    },

    setFov: (deg) => {
      if (!Number.isFinite(deg) || deg <= 0 || deg >= 180) return false;
      if (!getRenderer()) return false;
      setFov(deg, { persist: false });
      return true;
    },

    setCamera: (position, up) => setCameraPose(position, up),

    // ── Write: time ──
    setTime: (when) => {
      const et = resolveEpoch(when, spice());
      if (et === null) return false;
      if (!getRenderer()) return false;
      setTime(et);
      return true;
    },

    setTimeRate: (x) => {
      if (!Number.isFinite(x) || !getRenderer()) return false;
      setTimeRate(x);
      return true;
    },

    setPlaying: (on) => {
      if (!getRenderer()) return false;
      setPlaying(on);
      return true;
    },

    runTo: (seconds) => {
      if (!Number.isFinite(seconds) || !getRenderer()) return false;
      runTo(seconds);
      return true;
    },

    // ── Sequencing and output ──
    wait: (seconds) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)),

    displayNote: (text, seconds) => displayNote(text, seconds),

    screenshot: (label): ScriptImage | false => {
      const r = getRenderer();
      if (!r) return false;
      const dataUrl = captureFrameDataUrl(r.getContext());
      downloadDataUrl(dataUrl, captureFilename('png', label));
      return { dataUrl, label };
    },

    record: (on) => {
      const r = getRenderer();
      if (!r) return false;
      // Not the recorder's new state: `record off` would then report `false`
      // and the interpreter would read a successful stop as a refusal. What is
      // being reported is whether the recorder ended up where it was asked to.
      return setVideoRecording(r, on) === on;
    },

    // ── Read ──
    getTime: () => getRenderer()?.timeController.et ?? vs.et,
    getRate: () => getRenderer()?.timeController.rate ?? vs.rate,
    isPlaying: () => getRenderer()?.timeController.playing ?? vs.playing,
    getSelected: () => vs.selectedBodyName,
    getTracked: () => getRenderer()?.cameraController.trackedBody?.body.name ?? null,
    getCamera: camera,
    listObjects: () => bodyNames(),
    listViewpoints: () => getRenderer()?.cameraController.getViewpoints().map((v) => v.name) ?? [],
    snapshot: () => snapshotScript(snapshotState()),

    on: <K extends ScriptEventName>(event: K, cb: (data: ScriptEventMap[K]) => void) => {
      switch (event) {
        case 'select':
          return onViewerEvent('select', (name) =>
            (cb as (d: ScriptEventMap['select']) => void)({ name }),
          );
        case 'time':
          return onViewerEvent('time', (et) => (cb as (d: ScriptEventMap['time']) => void)({ et }));
        case 'load':
          return onViewerEvent('load', (objects) =>
            (cb as (d: ScriptEventMap['load']) => void)({ objects }),
          );
        default: {
          const unreachable: never = event;
          throw new Error(`unknown event ${String(unreachable)}`);
        }
      }
    },
  };
}
