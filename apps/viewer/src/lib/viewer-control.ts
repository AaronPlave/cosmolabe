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
import { listActivities, getActivity, getSelectedActivity, selectActivity, seekActivity, navigateActivity } from './activity-control';
import { etFromCalendarString } from '@cosmolabe/core';
import type { HeritageSpice } from '@cosmolabe/frames';
import { CameraModeName } from '@cosmolabe/three';
import {
  snapshotScript,
  type ScriptCamera,
  type ScriptEventMap,
  type ScriptEventName,
  type ScriptImage,
  type ScriptImagery,
  type ScriptPlace,
  type ScriptTime,
  type ViewerControl,
  type ViewerSnapshotState,
} from '@cosmolabe/control';
import {
  vs,
  setGridSettings,
  setBodyGridOption,
  applyViewpoint,
  bodyNames,
  circleCenter,
  clearLookAt,
  crane,
  dolly,
  displayNote,
  flyToBody,
  frameBody,
  getRenderer,
  noteIsTimed,
  gotoObject,
  hasBody,
  isDisplayOption,
  jumpToBody,
  goToCoordinates,
  onViewerEvent,
  pointAtObject,
  runTo,
  selectBody,
  setBodyVisible,
  setCameraModeForBody,
  setCameraPose,
  getCameraPose,
  setDisplayOption,
  setFov,
  setLabelVisible,
  setPlaying,
  setTime,
  setTimeRate,
  setTrajectoryVisible,
  stopFlight,
  trackBody,
  untrack,
  asHostTimeChange,
  timeChangeCause,
  getSceneUniverse,
  setScrubberWindow,
  extendTimelineBase,
  sceneId,
} from './viewer-state.svelte';
import type { Place } from '@cosmolabe/core';
import type { BodyMesh } from '@cosmolabe/three';
import { navigateToPlaceForControl, placeNavigationCoordinates, placeNavigationProblem, searchPlaces } from './places';
import type { StateAvailability } from '@cosmolabe/core';
import type { ScriptAvailability } from '@cosmolabe/control';
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
  getSpice?: () => HeritageSpice | null;
  /**
   * This instance is an embedding host's: its clock changes notify as
   * `cause: 'host'`, so the host can tell its own seeks from the viewer's.
   */
  host?: boolean;
}

/** Playback notifies at most this often; seeks notify at once. */
const PLAYBACK_TIME_EVENT_MS = 250;

const availabilityOf = (a: StateAvailability): ScriptAvailability => ({
  available: a.available, reason: a.reason, message: a.message, sourceId: a.sourceId, classification: a.classification,
});

/**
 * Seconds past J2000 for a time a script asked for, or null if it cannot be read.
 *
 * SPICE first where it exists — `str2et` accepts day-of-year, JD and era forms
 * this does not — then core's leap-second-exact calendar parse. Null, never 0:
 * J2000 is a perfectly good epoch to ask for, so a failure that returned 0
 * would silently move the scene there. `BottomBar`'s go-to-time field does the
 * lesser version of this today and lands on *today* when SPICE is absent.
 */
function resolveEpoch(when: ScriptTime, spice: HeritageSpice | null): number | null {
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

/** A place as the port reports it: plain data, nothing that reaches back into the index. */
function scriptPlace(place: Place): ScriptPlace {
  const { latDeg, lonDeg } = placeNavigationCoordinates(place);
  const source = place.layer.source;
  return {
    ref: place.ref, name: place.name, body: place.layer.body,
    layer: { id: place.layer.id, name: place.layer.name }, feature: place.feature.id,
    kind: place.kind, origin: place.origin, latitude: latDeg, longitude: lonDeg,
    ...(place.diameterKm === undefined ? {} : { diameterKm: place.diameterKm }),
    source: { kind: source.kind, identity: source.identity, ...(source.revision ? { revision: source.revision } : {}) },
    unavailable: placeNavigationProblem(place),
  };
}

function scriptImagery(bm: BodyMesh): ScriptImagery {
  return {
    body: bm.body.name,
    surface: bm.surfaceTransitionState,
    imageryOnly: bm.isImageryOnlySurface,
    layers: bm.imageryLayers.map((l) => ({
      id: l.id, name: l.name, attribution: l.attribution, description: l.description,
      role: l.role, optional: l.optional, visible: l.visible, opacity: l.opacity,
      bounds: l.bounds ? [...l.bounds] as [number, number, number, number] : null,
      resolutionMeters: l.resolutionMeters, status: l.status,
      view: l.view ? { ...l.view, minZoom: l.minZoom } : null,
    })),
  };
}

/** A point place, by ref, in the scene's index. */
const placeByRef = (ref: string): Place | undefined =>
  vs.places?.byRef.get(ref);

function isFrameMode(value: string): value is CameraModeName {
  return (Object.values(CameraModeName) as string[]).includes(value);
}

/** Build a `ViewerControl` over the app's current renderer and state. */
export function createViewerControl(deps: ViewerControlDeps = {}): Required<ViewerControl> {
  const spice = () => deps.getSpice?.() ?? null;

  const camera = (): ScriptCamera => {
    const r = getRenderer();
    // Positions are in km — the catalog convention, and the unit every other
    // serialization of a camera in this repo already uses — and in the frame
    // `setCamera` takes them in, so a snapshot's pose replays to the same view.
    // The target is part of it: a pose without what the camera orbits and
    // looks at says where it stands and nothing about what it sees.
    const pose = getCameraPose();
    if (!r || !pose) return { position: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 60 };
    return { ...pose, fov: r.camera.fov };
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
      lookAt: r?.cameraController.lookAtBody?.body.name ?? vs.lookAtBodyName,
      frame: { mode: vs.cameraMode, body: tracked ?? undefined },
      camera: camera(),
      grid: vs.grid,
      layers: {
        trajectories: vs.showTrajectories,
        labels: vs.showLabels,
        grid: vs.showGrid,
        axes: vs.showAxes,
        sensors: vs.showSensors,
        sensorLabels: vs.showSensorLabels,
      },
      // Persistent captions only — a timed one is a sequencing event, not view
      // state, and `noteIsTimed` is what tells the two apart.
      note: (!noteIsTimed() && vs.note) || undefined,
    };
  };

  return {
    listActivities: filter => JSON.parse(JSON.stringify(listActivities(filter))),
    getActivity: id => { const a = getActivity(id); return a ? JSON.parse(JSON.stringify(a)) : undefined; },
    getSelectedActivity: () => { const a = getSelectedActivity(); return a ? JSON.parse(JSON.stringify(a)) : undefined; },
    selectActivity, navigateActivity,
    seekActivity: (id, edge) => (deps.host ? asHostTimeChange(() => seekActivity(id, edge)) : seekActivity(id, edge)),
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

    frameObject: (name) => frameBody(name),

    flyTo: (name, opts) => flyToBody(name, { path: opts?.path, seconds: opts?.seconds }),

    jumpTo: (name) => jumpToBody(name),

    gotoCoordinates: (name, latDeg, lonDeg, opts) => {
      if (!hasBody(name)) return false;
      const result = goToCoordinates(
        {
          bodyName: name, latDeg, lonDeg,
          latitude: opts?.latitude ?? 'planetocentric',
          longitudeDirection: opts?.longitude ?? 'east',
        },
        {
          preset: opts?.view,
          animate: opts?.animate || (opts?.seconds !== undefined && opts.seconds > 0),
          seconds: opts?.seconds,
          rangeKm: opts?.rangeKm,
        },
      );
      if (!result.ok) throw new Error(result.error);
      return true;
    },

    stopFlight: () => void stopFlight(),

    pointAtObject: (name) => pointAtObject(name),

    clearLookAt: () => clearLookAt(),

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

    showBodyGrid: (name, visible) => {
      if (!hasBody(name)) return false;
      setBodyGridOption(name, 'visible', visible, { persist: false }); return true;
    },
    showBodyGridLabels: (name, visible) => {
      if (!hasBody(name)) return false;
      setBodyGridOption(name, 'labels', visible, { persist: false }); return true;
    },
    setGridScope: (scope, names) => {
      const bodies = (names ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (!['tracked', 'bodies', 'all'].includes(scope) || (scope === 'bodies' && (!bodies.length || bodies.some(n => !hasBody(n))))) return false;
      setGridSettings({ scope, bodies, perBody: {} }, { persist: false }); return true;
    },
    setGridDensity: (density, spacingDeg) => {
      if (!['auto', 'manual'].includes(density) || (spacingDeg !== undefined && (!Number.isFinite(spacingDeg) || spacingDeg < 0.001 || spacingDeg > 30))) return false;
      if (density === 'manual' && spacingDeg === undefined) return false;
      setGridSettings({ density, ...(spacingDeg === undefined ? {} : { spacingDeg }) }, { persist: false }); return true;
    },
    setGridOpacity: opacity => {
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return false;
      setGridSettings({ opacity }, { persist: false }); return true;
    },
    setGridLabels: labels => { setGridSettings({ labels }, { persist: false }); return true; },
    setGridMinorLines: minorLines => { setGridSettings({ minorLines }, { persist: false }); return true; },
    setGridCoordinateFrame: coordinateFrame => { setGridSettings({ coordinateFrame }, { persist: false }); return true; },

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

    setCamera: (position, target, up) => setCameraPose(position, target, up),

    circleCenter: (direction, degrees, opts) => circleCenter(direction, degrees, opts?.seconds),

    dolly: (km, opts) => dolly(km, opts?.seconds),

    crane: (km, opts) => crane(km, opts?.seconds),

    // ── Write: time ──
    setTime: (when) => {
      const et = resolveEpoch(when, spice());
      if (et === null) return false;
      const r = getRenderer();
      if (!r) return false;
      // Already there: a host echoing the viewer's own time back is a no-op,
      // not a second seek.
      if (r.timeController.et === et) return true;
      if (deps.host) asHostTimeChange(() => setTime(et));
      else setTime(et);
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
    getObjectState: (name, opts) => {
      const u = getSceneUniverse();
      if (!u || !hasBody(name)) return undefined;
      const et = opts?.time ? resolveEpoch(opts.time, spice()) : getRenderer()?.timeController.et ?? vs.et;
      if (et === null) return undefined;
      const frame = opts?.frame ?? 'ECLIPJ2000';
      const center = opts?.center ?? u.getBody(name)?.activeParentAt(et) ?? null;
      const s = u.stateIn(name, et, { frame, center: center ?? undefined });
      return {
        et, frame, center,
        position: s.position, attitude: s.attitude,
        positionAvailability: availabilityOf(s.availability.position),
        attitudeAvailability: s.availability.attitude && availabilityOf(s.availability.attitude),
      };
    },
    getTimelineWindow: () => ({ start: vs.scrubMin, end: vs.scrubMax }),
    setTimelineWindow: (from, to) => {
      const start = resolveEpoch(from, spice());
      const end = resolveEpoch(to, spice());
      if (start === null || end === null || !(end > start) || !getRenderer()) return false;
      extendTimelineBase(start, end);
      setScrubberWindow(start, end);
      return true;
    },
    getTime: () => getRenderer()?.timeController.et ?? vs.et,
    getRate: () => getRenderer()?.timeController.rate ?? vs.rate,
    isPlaying: () => getRenderer()?.timeController.playing ?? vs.playing,
    getSelected: () => vs.selectedBodyName,
    getTracked: () => getRenderer()?.cameraController.trackedBody?.body.name ?? null,
    getFlight: () => {
      // The controller, not `vs.flight`: that mirror updates on the next
      // animation frame, and a host polling for a landing must not see a
      // flight that has already ended.
      const flight = getRenderer()?.cameraController.flight;
      return flight ? { target: flight.destination?.body.name ?? null, path: flight.path } : null;
    },
    getCamera: camera,
    getCameraReference: () => getRenderer()?.cameraController.originBody?.body.name ?? null,
    setCameraReference: (name) => {
      const r = getRenderer();
      if (!r) return false;
      const body = name === null ? null : r.getBodyMesh(name);
      if (body === undefined) return false;
      r.cameraController.setOriginBody(body);
      return true;
    },
    getScene: () => (getRenderer() ? { id: sceneId(), catalog: vs.catalogName, ready: vs.assetsReady } : null),

    searchPlaces: (query, opts) => {
      const limit = Math.max(1, Math.min(Math.floor(opts?.limit ?? 10) || 10, 100));
      const activeBody = getRenderer()?.cameraController.focusBody?.body.name;
      return searchPlaces(query, { body: opts?.body, limit, activeBody }).map(scriptPlace);
    },
    getPlace: (ref) => {
      const place = placeByRef(ref);
      return place ? scriptPlace(place) : undefined;
    },
    getSelectedPlace: () => {
      const place = vs.selectedPlaceRef ? placeByRef(vs.selectedPlaceRef) : undefined;
      return place ? scriptPlace(place) : undefined;
    },
    gotoPlace: (ref, opts) => {
      const place = placeByRef(ref);
      if (!place) return false;
      const result = navigateToPlaceForControl(place, { animate: opts?.animate ?? true, view: opts?.view });
      if (!result.ok) throw new Error(result.error);
      return true;
    },

    getImagery: (name) => {
      if (!hasBody(name)) return undefined;
      const bm = getRenderer()?.getBodyMesh(name);
      return bm ? scriptImagery(bm) : { body: name, surface: null, imageryOnly: false, layers: [] };
    },
    setImageryVisible: (name, layer, visible) => {
      const bm = hasBody(name) ? getRenderer()?.getBodyMesh(name) : undefined;
      const info = bm?.imageryLayers.find((l) => l.id === layer);
      if (!bm || !info) return false;
      // The base keeps the globe textured; it is not the caller's to remove.
      if (!visible && !info.optional) return false;
      return bm.setImageryLayerVisible(layer, visible) || info.visible === visible;
    },
    setImageryOpacity: (name, layer, opacity) => {
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return false;
      const bm = hasBody(name) ? getRenderer()?.getBodyMesh(name) : undefined;
      if (!bm?.imageryLayers.some((l) => l.id === layer)) return false;
      return bm.setImageryLayerOpacity(layer, opacity) || bm.imageryLayers.find((l) => l.id === layer)?.opacity === opacity;
    },

    listObjects: () => bodyNames(),
    listViewpoints: () => getRenderer()?.cameraController.getViewpoints().map((v) => v.name) ?? [],
    snapshot: () => snapshotScript(snapshotState()),

    on: <K extends ScriptEventName>(event: K, cb: (data: ScriptEventMap[K]) => void) => {
      switch (event) {
        case 'select':
          return onViewerEvent('select', (name) =>
            (cb as (d: ScriptEventMap['select']) => void)({ name }),
          );
        case 'time': {
          // Seeks at once; playback coalesced to a few a second, trailing, so
          // the last notification always carries the clock's current value.
          const deliver = cb as (d: ScriptEventMap['time']) => void;
          let latest: ScriptEventMap['time'] | null = null;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const flush = () => {
            timer = undefined;
            if (latest) deliver(latest);
            latest = null;
          };
          const off = onViewerEvent('time', (et) => {
            latest = { et, cause: timeChangeCause() };
            if (latest.cause !== 'playback') {
              clearTimeout(timer);
              flush();
            } else {
              timer ??= setTimeout(flush, PLAYBACK_TIME_EVENT_MS);
            }
          });
          return () => {
            off();
            clearTimeout(timer);
          };
        }
        case 'load':
          return onViewerEvent('load', (objects) =>
            (cb as (d: ScriptEventMap['load']) => void)({ objects }),
          );
        case 'ready':
          return onViewerEvent('ready', (objects) => (cb as (d: ScriptEventMap['ready']) => void)({ objects }));
        case 'playback':
          return onViewerEvent('playback', (p) => (cb as (d: ScriptEventMap['playback']) => void)({ ...p }));
        case 'activities':
          return onViewerEvent('activities', (count) => (cb as (d: ScriptEventMap['activities']) => void)({ count }));
        case 'activitySelect':
          return onViewerEvent('activitySelect', (id) => (cb as (d: ScriptEventMap['activitySelect']) => void)({ id }));
        case 'flightEnd':
          return onViewerEvent('flightEnd', (end) => (cb as (d: ScriptEventMap['flightEnd']) => void)({ ...end }));
        default: {
          const unreachable: never = event;
          throw new Error(`unknown event ${String(unreachable)}`);
        }
      }
    },
  };
}
