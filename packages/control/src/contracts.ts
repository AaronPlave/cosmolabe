import type { GridSettings } from './grid.js';
/**
 * The `ViewerControl` port — the contract a Cosmolabe viewer offers a host.
 *
 * Two properties are deliberate and load-bearing:
 *
 * **It reads as well as writes.** A write-only port makes host control half a
 * feature: an app embedding the viewer can push state at it but never build UI
 * around it, and a command palette cannot label a toggle without knowing which
 * way it is currently set.
 *
 * **Optional methods are the capability declaration.** A host that cannot
 * record video simply does not implement `record`, and the interpreter raises a
 * located error at the statement that needed it. A silent no-op there is the
 * worst outcome available: the script "succeeds" and the recording does not
 * exist.
 *
 * Every write method returns `false` for "no such name", following
 * `applyNamedViewpoint`, `CameraController.goToViewpoint` and
 * `Universe.getBody`. The host does not raise: it does not know the line number.
 * The interpreter, which does, turns that `false` into a located error.
 */

/** A three-component vector, in the units the method documents. */
export type ScriptVec3 = readonly [number, number, number];

/**
 * A time a script asked for, before the host has resolved it.
 *
 * The port takes this rather than a number because resolving a calendar string
 * is the *host's* job and the answer depends on what it has loaded: with SPICE
 * furnished, `str2et` accepts day-of-year and JD forms; without it, only the
 * calendar forms core's `etFromCalendarString` handles. The language cannot
 * know which, so it hands over what the author wrote.
 */
export type ScriptTime =
  /** Seconds past J2000 (ephemeris time), given numerically. */
  | { readonly kind: 'et'; readonly et: number }
  /** A calendar string, exactly as written in the script. */
  | { readonly kind: 'calendar'; readonly text: string };

/**
 * How `flyTo` travels: straight at the destination, or by pulling back first
 * to show where the camera is looking and the destination together, then
 * approaching. An overview flight from a camera already that far back is a
 * direct one. See `docs/navigation.md`.
 */
export type FlightPath = 'direct' | 'overview';

/** A camera flight in progress, as `getFlight` reports it. */
export interface ScriptFlight {
  /**
   * Names the flight from its start to its end: `flightEnd` reports the same
   * id, so a caller can tell its own flight's end from another command's. An
   * overview keeps its id through its pull-back and approach.
   */
  readonly id: number;
  /** The object the flight lands on; null for a flight to a viewpoint. */
  readonly target: string | null;
  readonly path: FlightPath;
}

/** Which way `circleCenter` moves the camera on screen. */
export type CircleDirection = 'right' | 'left' | 'up' | 'down';

/** A frame captured by the `screenshot` verb. */
export interface ScriptImage {
  /** PNG data URL of the captured frame. */
  readonly dataUrl: string;
  /** The label the script asked for, if any. */
  readonly label?: string;
}

/**
 * Camera pose, as the port reports and accepts it.
 *
 * `target` is not optional decoration. Position and up alone do not say where
 * the camera is *pointing*: the viewer orbits and looks at `target`, so a pose
 * without it reproduces where the camera stands and not what it sees.
 *
 * All three are in the scene's current frame, which is the tracked object when
 * one is tracked and the world origin otherwise — so a pose captured while
 * tracking Titan is relative to Titan, and means something else if replayed
 * while tracking nothing. `snapshot()` emits the tracking first for that reason.
 */
export interface ScriptCamera {
  /** Eye position in km. */
  readonly position: ScriptVec3;
  /** The point the camera orbits and looks at, in km. */
  readonly target: ScriptVec3;
  /** Camera up vector (unit). */
  readonly up: ScriptVec3;
  /** Vertical field of view, in degrees. */
  readonly fov: number;
}

/**
 * Events a host can observe.
 *
 * Subscriptions belong to the viewer, not to a scene: they keep firing across
 * catalog loads, and end only with their disposer (or the viewer's disposal).
 */
export interface ScriptEventMap {
  /** The selected object changed. `name` is null when the selection cleared. */
  select: { name: string | null };
  /**
   * Scene time moved. Seeks are delivered at once; continuous playback is
   * coalesced to a few notifications a second, the last always carrying the
   * clock's current value. `cause` tells a host's own `setTime` (`host`)
   * from the viewer's scrubber, keys and scripts (`viewer`) and from the
   * running clock (`playback`), so a host mirroring time can ignore its echo.
   */
  time: { et: number; cause?: 'host' | 'viewer' | 'playback' };
  /** A scene's object list is up; its models and textures may still be loading. */
  load: { objects: readonly string[] };
  /** The scene's initial models, textures and trails settled: it is presentable. */
  ready: { objects: readonly string[] };
  /** Playback started, stopped or changed rate. */
  playback: { playing: boolean; rate: number };
  /** The scene's mission activities changed: a catalog load or a host update. */
  activities: { count: number };
  /** The selected mission activity changed; null when none is selected. */
  activitySelect: { id: string | null };
  /**
   * A camera flight ended. `outcome` says how: it `arrived`; it was `stopped`
   * by `stopFlight` or another camera command (a cut, a reset, a newer
   * flight); or the person's own navigation — a drag, a wheel zoom, a pinch,
   * a movement key — `interrupted` it where it was. `id` is the ended
   * flight's `ScriptFlight.id`.
   *
   * Told once the command that ended the flight has finished, and an `arrived`
   * once the camera holds its landing (tracking and origin applied), so a
   * listener sees the camera as the flight left it and may issue another
   * camera command.
   */
  flightEnd: { id: number; target: string | null; path: FlightPath; outcome: FlightOutcome };
}

/** How a camera flight ended; see `ScriptEventMap.flightEnd`. */
export type FlightOutcome = 'arrived' | 'stopped' | 'interrupted';

export type ScriptEventName = keyof ScriptEventMap;

/** How `gotoCoordinates` reads its coordinates and places the camera. */
export interface CoordinateNavigationOptions {
  latitude?: 'planetocentric' | 'planetographic';
  longitude?: 'east' | 'west';
  view?: SurfaceView;
  /** Fly over this many seconds instead of cutting. */
  seconds?: number;
  /** Fly, over the viewer's own duration. */
  animate?: boolean;
  /** Altitude (overhead), slant range (oblique) or eye height (surface), km. */
  rangeKm?: number;
}

/** The views `gotoCoordinates` offers. */
export type SurfaceView = 'overhead' | 'oblique' | 'surface';

/**
 * The control and observation surface of a Cosmolabe viewer.
 *
 * This is the contract; `window.cosmo` is one binding of it. Nothing in the
 * design may require a global, and no method may reach for one — an embedded
 * app, a test, or a future integration holds an instance directly.
 */
/** Renderer-independent activity projection; all bounds are shared-clock ET. */
export interface ScriptActivity {
  readonly enabled?: boolean;
  readonly id: string; readonly name: string; readonly kind: string;
  readonly vehicle: string; readonly body: string;
  readonly mission?: string;
  /** The named place the catalog says the activity happened at (a flight's airfield, say); a name, not a link. */
  readonly site?: string;
  /**
   * What the record points at. `location` is a place ref: the only direct
   * link from an activity to a place. A record with a `site` and no
   * `location` is tied to a place by name alone, if at all.
   */
  readonly references?: {
    readonly trajectory?: string; readonly sourceSegment?: string; readonly location?: string; readonly viewpoint?: string;
    readonly objects?: readonly string[];
  };
  readonly start: number; readonly end: number;
  readonly temporality: 'instant' | 'interval';
  readonly provenance: { readonly source: string; readonly version: string; readonly authority: string; readonly timing: string; readonly limitations: string; readonly uncertaintySeconds?: number };
}
export interface ScriptActivityFilter { vehicle?: string; kind?: string }

/** Whether part of an object's state exists at an epoch, and why not (core's `StateAvailability`). */
export interface ScriptAvailability {
  readonly available: boolean;
  readonly reason?: string;
  readonly message?: string;
  readonly sourceId?: string;
  readonly classification?: string;
}

/** An object's state as an external system states it; see `getObjectState`. */
export interface ScriptObjectState {
  readonly et: number;
  readonly frame: string;
  readonly center: string | null;
  /** km, relative to `center`, in `frame`; null when unavailable. */
  readonly position: ScriptVec3 | null;
  /** Scalar-first quaternion taking vector coordinates from `frame` to the body frame (v_body = q v_frame q*); null when unavailable. */
  readonly attitude: readonly [number, number, number, number] | null;
  readonly positionAvailability: ScriptAvailability;
  readonly attitudeAvailability?: ScriptAvailability;
}

/**
 * The scene bound to the viewer, as `getScene` reports it.
 *
 * `id` changes with every scene bound, including a reload of the same
 * catalog. Place refs, imagery layer IDs and activity IDs are scoped to the
 * scene they were read from: a caller holding one across a load compares `id`
 * rather than letting it resolve against a different catalog's records.
 *
 * The actions that take one of those IDs (`gotoPlace`, `selectActivity`,
 * `seekActivity`, `setImageryVisible`, `setImageryOpacity`) accept the scene
 * the caller read it from, as `scene`, and throw instead of acting when the
 * viewer has since bound another. A caller that issues commands later than it
 * read them, such as an agent's queued tool call, passes it: two catalogs can
 * reuse a ref, and the older command would otherwise act on the newer scene's
 * record of that name.
 */
export interface ScriptScene {
  readonly id: number;
  /** The catalog's display name; null when it has none. */
  readonly catalog: string | null;
  /** The initial models, textures and trails have settled (the `ready` event). */
  readonly ready: boolean;
}

/**
 * A named place (#191): a point feature of one of the scene's geographic
 * layers — a Gazetteer name, or a mission or user site.
 *
 * `ref` is the stable reference (the layer and feature IDs, or the source's
 * own `placeRef`), unique within the scene; `name` is a display label and is
 * not. Coordinates are planetocentric latitude and east longitude, degrees,
 * as `gotoCoordinates` reads them by default.
 */
export interface ScriptPlace {
  readonly ref: string;
  readonly name: string;
  readonly body: string;
  /** The geographic layer the place comes from, and its feature within it. */
  readonly layer: { readonly id: string; readonly name: string };
  readonly feature: string;
  readonly kind: string;
  readonly origin: 'nomenclature' | 'mission/user';
  readonly latitude: number;
  readonly longitude: number;
  /** The source's indicative extent; absent when the source does not say. */
  readonly diameterKm?: number;
  /**
   * The source's own attributes for the place (a mission site's `Flight`,
   * `Earth_Date`, …), as the layer states them: strings, numbers and
   * booleans only, bounded. The evidence a caller can cite for what a place
   * is; absent when the layer carries none.
   */
  readonly fields?: Readonly<Record<string, string | number | boolean>>;
  /** Where the layer's data came from: a catalog URL, a local file, or this session. */
  readonly source: { readonly kind: 'catalog' | 'local-file' | 'user'; readonly identity: string; readonly revision?: string };
  /** Null when the place can be navigated to; otherwise why not. */
  readonly unavailable: string | null;
}

/** One layer of a body's streamed imagery stack (#123), bottom to top. */
export interface ScriptImageryLayer {
  readonly id: string;
  readonly name: string;
  /** Who serves the data. */
  readonly attribution: string;
  /** The full product name; null when the catalog gives none. */
  readonly description: string | null;
  readonly role: 'base' | 'overlay';
  /** False for the base, which cannot be turned off. */
  readonly optional: boolean;
  readonly visible: boolean;
  readonly opacity: number;
  /** Coverage `[west, south, east, north]` in degrees; null for a global layer. */
  readonly bounds: readonly [number, number, number, number] | null;
  /** Native ground resolution in m/px as the provider advertises it; null when unstated. */
  readonly resolutionMeters: number | null;
  /**
   * Which product the layer is, as the catalog names it, apart from its
   * display name and who serves it. The endpoint is reduced to scheme, host
   * and path: a signed URL's query, credentials and fragment never appear.
   */
  readonly source: {
    readonly type: string;
    readonly endpoint: string;
    /** The service's layer identifier; null when the catalog gives none. */
    readonly layer: string | null;
    readonly tileMatrixSet: string | null;
  };
  /** Request outcome so far this session: none yet, all good, some tiles failed, or the source failed. */
  readonly status: 'idle' | 'ok' | 'partial' | 'failed';
  /**
   * What the layer adds to the current view; null while it is not drawn. A
   * layer can be on and still draw nothing here: out of its coverage, or too
   * far out for its data.
   */
  readonly view: {
    readonly inCoverage: boolean;
    readonly zoomLevel: number | null;
    readonly minZoom: number;
    readonly missingTiles: number;
    readonly degradedTiles: number;
    readonly cacheFull: boolean;
  } | null;
}

/** A body's streamed surface, as `getImagery` reports it. */
export interface ScriptImagery {
  readonly body: string;
  /**
   * What the body is drawing: its static map (`static`, `preloading`), the
   * streamed surface (`waiting` for tiles, `streamed`), or its static map
   * because the stream failed (`fallback`). Null without a streamed surface.
   */
  readonly surface: 'static' | 'preloading' | 'waiting' | 'streamed' | 'fallback' | null;
  /**
   * The streamed surface is imagery draped on the ellipsoid, with no
   * physical terrain behind it: imagery detail is not elevation.
   */
  readonly imageryOnly: boolean;
  readonly layers: readonly ScriptImageryLayer[];
}

export interface ViewerControl {
  listActivities?(filter?: ScriptActivityFilter): readonly ScriptActivity[];
  getActivity?(id: string): ScriptActivity | undefined;
  getSelectedActivity?(): ScriptActivity | undefined;
  /** Selection changes neither the clock nor the camera. */
  selectActivity?(id: string, opts?: { scene?: number }): boolean;
  /** Both edges of an instant seek its single epoch; does not move the camera. */
  seekActivity?(id: string, edge?: 'start' | 'end', opts?: { scene?: number }): boolean;
  /** Select only. Filter applies before deterministic start/end/ID ordering. */
  navigateActivity?(direction: 'previous' | 'next', filter?: ScriptActivityFilter): boolean;

  // ── Write: scene setup ──
  //
  // Select, Track (focus), Frame, Fly and Jump are the navigation vocabulary
  // every surface shares; `docs/navigation.md` defines each. None implies
  // another: selecting never moves the camera, and moving it never selects.

  /**
   * Cosmographia's name for `jumpTo`, or, given `seconds`, for a `direct`
   * `flyTo` over that many seconds.
   *
   * Cutting is the default because a fly-to is a wall-clock animation: a
   * caller that renders one frame and photographs it gets the camera
   * mid-flight, aimed at nothing in particular.
   */
  gotoObject(name: string, opts?: { seconds?: number }): boolean;
  /** Select `name` — what the info panel shows. Never moves the camera. */
  select(name: string): boolean;
  /** Clear the selection. */
  deselect(): void;
  /**
   * Focus: make `name` the camera's anchor — what it orbits and follows —
   * without moving the camera. It stays where it is and turns to face `name`.
   */
  track(name: string): boolean;
  /** Release the tracked object. The camera stays where it is. */
  untrack(): void;
  /**
   * Frame: cut to a view that fits `name` — the tracked object when omitted —
   * and track it. The camera keeps the side it sees the object from and moves
   * along that line until the object comfortably fills the view.
   * False with no name and nothing tracked.
   */
  frameObject(name?: string): boolean;
  /**
   * Fly: animate to the view `frameObject` would cut to, then track `name`.
   * `path` defaults to the viewer's, `direct` in this one; `seconds` to the
   * path's own duration. Returns at once — sequence with `wait`.
   *
   * The flight owns the camera until it lands. Navigation input from the
   * person, or `stopFlight`, ends it where it is with `name` tracked.
   */
  flyTo(name: string, opts?: { seconds?: number; path?: FlightPath }): boolean;
  /** Jump: apply the view a flight to `name` would land on, at once. */
  jumpTo(name: string): boolean;
  /**
   * Go to a place on body `name` by latitude and longitude (#190): the
   * coordinates are the target on the body, and `view` how the camera looks
   * at it (`overhead`, the default; `oblique`; `surface`). Cuts by default,
   * like `gotoObject`; given `seconds` (or `animate`), flies on an arc that
   * clears the body. Degrees; planetocentric and east-positive unless
   * `latitude`/`longitude` say otherwise. The target becomes the orbit pivot.
   * Neither time nor the selection changes.
   *
   * False when there is no object `name`. Coordinates that cannot be placed
   * — out of range, a body with no declared shape or rotation, a convention
   * its shape cannot honour — throw, saying why.
   */
  gotoCoordinates(name: string, latDeg: number, lonDeg: number, opts?: CoordinateNavigationOptions): boolean;
  /**
   * End a flight where it is. The camera keeps its position, and the object
   * it was flying to is tracked from there, so the camera turns to face it.
   * Does nothing when nothing is flying.
   */
  stopFlight(): void;
  /**
   * Aim the camera at `name` while continuing to orbit whatever it tracks.
   * Idempotent: pointing at the same object twice still points at it.
   */
  pointAtObject(name: string): boolean;
  /** Stop aiming at an object. The orbit centre returns to what is tracked. */
  clearLookAt(): void;
  /** Apply a named catalog viewpoint, seeking the clock if it declares an epoch. */
  viewpoint(name: string): boolean;
  /** Switch camera frame. `body` re-parameterizes the frame onto that object. */
  setFrame(mode: string, body?: string): boolean;
  /** Show or hide an object — mesh, trajectory, label, sensors and all. */
  setObjectVisible(name: string, visible: boolean): boolean;
  /** Show or hide one object's trajectory line. */
  showTrajectory(name: string, visible: boolean): boolean;
  /** Show or hide one object's label. */
  showLabel(name: string, visible: boolean): boolean;
  /** Show or hide a whole layer (every trajectory, every label, ...). */
  setLayer(layer: string, on: boolean): boolean;
  /** Optional for older embed hosts. */
  showBodyGrid?(name: string, visible: boolean): boolean;
  showBodyGridLabels?(name: string, visible: boolean): boolean;
  setGridScope?(scope: GridSettings['scope'], bodies?: string): boolean;
  setGridDensity?(density: GridSettings['density'], spacingDeg?: number): boolean;
  setGridLabels?(visible: boolean): boolean;
  setGridOpacity?(opacity: number): boolean;
  setGridMinorLines?(visible: boolean): boolean;
  setGridCoordinateFrame?(visible: boolean): boolean;
  /** Set the vertical field of view, in degrees. */
  setFov(deg: number): boolean;
  /**
   * Place the camera at an explicit pose. Positions are in km.
   *
   * This sets the camera's pose and nothing else: it does **not** clear what is
   * tracked or what is being pointed at, and both of those keep acting on the
   * camera afterwards. While an object is tracked the pose is relative to it and
   * the viewer re-centres on it each frame; while `pointAtObject` is in effect
   * the aim follows that object and overrides `target` on the next frame. Call
   * `untrack` / `clearLookAt` first if you want the pose to stand alone.
   *
   * `target` defaults to the scene origin — the tracked object when there is
   * one, the world origin otherwise.
   */
  setCamera(position: ScriptVec3, target?: ScriptVec3, up?: ScriptVec3): boolean;
  /**
   * Swing the camera around the point it orbits by `degrees`, keeping its
   * distance and its aim — Cosmographia's `circleCenterRight/Left/Up/Down`.
   *
   * `direction` is the way the camera moves on screen: `right` and `left` swing
   * it about the view's up vector, `up` and `down` about the view's right axis.
   * Instant by default; pass `seconds` to swing at a constant rate over that
   * long. Like a timed `gotoObject` it returns at once — sequence with `wait`.
   *
   * False in a camera frame that owns the view's orientation (LVLH, chase,
   * surface, instrument), where there is no orbit to swing.
   */
  circleCenter(direction: CircleDirection, degrees: number, opts?: { seconds?: number }): boolean;
  /**
   * Move the camera straight away from the point it orbits by `km`, toward it
   * when negative, keeping its aim — Cosmographia's `moveAwayFromCenter`. It
   * stops short of the point rather than passing through it, and a body's
   * surface still stops it.
   *
   * Timing and refusal are `circleCenter`'s.
   */
  dolly(km: number, opts?: { seconds?: number }): boolean;
  /**
   * Raise the camera and the point it looks at together by `km` along the
   * view's up, lower them when negative, so the same view slides up the
   * screen — Cosmographia's `craneUp`.
   *
   * In free orbit this releases a tracked object first, as the Z / C keys do:
   * tracking pins the orbit centre to the object every frame, which would turn
   * the crane into a tilt. Body-fixed and spacecraft-fixed frames keep it.
   * Timing and refusal are `circleCenter`'s.
   */
  crane(km: number, opts?: { seconds?: number }): boolean;

  // ── Write: time ──

  /** Seek the clock. Returns false if the host cannot resolve the time. */
  setTime(when: ScriptTime): boolean;
  /** Set playback rate in scene-seconds per wall-second. */
  setTimeRate(x: number): boolean;
  /** Start or stop playback. */
  setPlaying(on: boolean): boolean;
  /**
   * Advance *scene* time by exactly `seconds`, whatever the clock is doing.
   *
   * The deterministic counterpart to `wait`, and the primitive most
   * Cosmographia loops exist to express.
   */
  runTo(seconds: number): boolean;

  // ── Sequencing and output ──

  /**
   * Sleep for `seconds` of *wall-clock* time, to let streamed textures and
   * terrain settle. Touches no scene state.
   *
   * Optional because it means something different in every host — a sleep in a
   * browser, N rendered frames in an offscreen harness — and because a host
   * that captures deterministic frames should refuse it outright rather than
   * pretend.
   */
  wait?(seconds: number): void | Promise<void>;
  /** Show a caption over the viewport. Omit `seconds` to leave it up. */
  displayNote(text: string, seconds?: number): void;
  /** Capture the current frame. */
  screenshot?(label?: string): ScriptImage | false;
  /** Start or stop video recording. Idempotent in both directions. */
  record?(on: boolean): boolean;

  // ── Read ──

  /**
   * An object's position and attitude at `time` (default: now), in `frame`
   * (default `ECLIPJ2000`) relative to `center` (default: its parent). The
   * same evaluation the scene draws: where the viewer shows nothing, this
   * reports unavailable with the reason rather than a value. Undefined for
   * no such object.
   */
  getObjectState?(name: string, opts?: { time?: ScriptTime; frame?: string; center?: string }): ScriptObjectState | undefined;
  /** The timeline's visible window, ET. */
  getTimelineWindow?(): { start: number; end: number };
  /** Show [start, end] on the timeline, growing its range if needed. Moves neither the clock nor the scene. */
  setTimelineWindow?(start: ScriptTime, end: ScriptTime): boolean;

  /** Current scene time, in seconds past J2000. */
  getTime(): number;
  /** Current playback rate, in scene-seconds per wall-second. */
  getRate(): number;
  isPlaying(): boolean;
  getSelected(): string | null;
  getTracked(): string | null;
  /** The flight playing, or null when the camera is not being flown. */
  getFlight(): ScriptFlight | null;
  getCamera(): ScriptCamera;
  /** Floating scene origin, independent of tracking (ECLIPJ2000 axes). */
  getCameraReference?(): string | null;
  /** Restore the floating origin without moving or tracking the camera. */
  setCameraReference?(name: string | null): boolean;
  /**
   * Every object in the loaded scene, by name.
   *
   * "Object" means a body the viewer has actually drawn — one that can be
   * tracked, picked, hidden and labelled. That is narrower than the catalog's
   * item list: a `Rings` body is rendered as part of its parent and is not an
   * object in this sense. The two lists must not be confused, because this one
   * is what "did you mean …?" draws from, and suggesting a name that every verb
   * then refuses is worse than suggesting nothing.
   */
  listObjects(): readonly string[];
  /** Every named viewpoint the catalog defines. */
  listViewpoints(): readonly string[];
  /**
   * The script that reproduces the current view.
   *
   * A serialization surface, not a state model: it derives its text from the
   * read side above and holds nothing of its own, so a share URL or any later
   * format stays an alternative rendering of one state rather than a competing
   * model of it.
   */
  snapshot(): string;
  /** The scene bound now; null before any scene is up. */
  getScene?(): ScriptScene | null;

  // ── Places (#191) ──

  /**
   * Places whose name or alias matches every word of `query` by prefix,
   * ranked (an exact name first, then by extent). Sources the person excluded
   * from search are not searched. Bounded: `limit` defaults to 10, at most 100.
   */
  searchPlaces?(query: string, opts?: { body?: string; limit?: number }): readonly ScriptPlace[];
  /** One place by `ref`; undefined when the scene has none by that ref. */
  getPlace?(ref: string): ScriptPlace | undefined;
  /** The place the Navigate panel has selected, if any. */
  getSelectedPlace?(): ScriptPlace | undefined;
  /**
   * Fly to (default) or cut to a place, by the coordinate navigation
   * `gotoCoordinates` uses, framed by the place's extent, and select it.
   * False for no such ref; throws, with the reason, when the place exists but
   * cannot be navigated to, or when `scene` names a scene no longer bound.
   */
  gotoPlace?(ref: string, opts?: { animate?: boolean; view?: SurfaceView; scene?: number }): boolean;

  // ── Imagery (#123) ──

  /**
   * A body's streamed imagery stack and surface state. A body without a
   * streamed surface reports no layers. Undefined for no such object.
   */
  getImagery?(body: string): ScriptImagery | undefined;
  /** False for no such object or layer, or for turning off a non-optional base. */
  setImageryVisible?(body: string, layer: string, visible: boolean, opts?: { scene?: number }): boolean;
  /** Opacity 0–1. False for no such object or layer, or an opacity out of range. */
  setImageryOpacity?(body: string, layer: string, opacity: number, opts?: { scene?: number }): boolean;

  /** Subscribe to an event. Returns a disposer. */
  on<K extends ScriptEventName>(event: K, cb: (data: ScriptEventMap[K]) => void): () => void;
}

/** The state `snapshotScript` renders. Every field comes off the read side. */
export interface ViewerSnapshotState {
  /** Scene time in seconds past J2000. Used only when `timeText` is absent. */
  readonly time: number;
  /** Scene time as a UTC calendar string — what the snapshot prefers to emit. */
  readonly timeText?: string;
  readonly rate: number;
  readonly playing: boolean;
  readonly selected: string | null;
  readonly tracked: string | null;
  /** The object the camera is aimed at, if any. */
  readonly lookAt: string | null;
  readonly frame: { readonly mode: string; readonly body?: string };
  readonly camera: ScriptCamera;
  /** Layer name → on. Keys are `LAYERS` entries. */
  readonly layers: Readonly<Record<string, boolean>>;
  readonly grid?: GridSettings;
  /**
   * A caption that will stay up until something clears it.
   *
   * A *timed* note is deliberately absent: it is an event in a sequence, not
   * state the view is in, and reproducing it would either resurrect a caption
   * that has already gone or require modelling how much of its duration is
   * left. A persistent note is view state and is reproduced.
   */
  readonly note?: string;
}

// ── The language ──

/** One coerced argument value, as the verb's `params` declared it. */
export type VerbValue = string | number | boolean | ScriptTime | ScriptVec3 | undefined;

/** One statement. Statement ≡ line, which is what makes `line` exact. */
export interface Statement {
  /** 1-based line number in the source. */
  readonly line: number;
  readonly verb: string;
  /** Arguments, already coerced to the verb's declared parameter types. */
  readonly args: readonly VerbValue[];
  /** The source line, verbatim, for error echo. */
  readonly text: string;
}

/** A parsed program. Blank lines and comments are gone; line numbers are not. */
export interface Program {
  readonly statements: readonly Statement[];
  readonly source: string;
}

export interface ParseOptions {
  /**
   * Verbs to reject at parse time, naming the line.
   *
   * The deterministic-capture harness passes `['wait']`: a golden that depends
   * on wall-clock is a coin flip. Rejecting at parse time means nothing runs,
   * rather than half a scene being applied before the offending line.
   */
  readonly forbid?: readonly string[];
}

/** The part of `AbortSignal` that `execute` uses. */
export interface ScriptCancelSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface ExecuteOptions {
  /**
   * Awaited before each statement, after the cancellation check and before
   * `onStatement`: a gate. Resolving lets the statement run; a promise that
   * has not resolved yet holds the run between statements. That is what a
   * console's Pause and Step are, and it is why pausing means "after the
   * current statement" — nothing in flight is frozen.
   *
   * Aborting `signal` while the gate is held ends the run at once, so Stop
   * works on a paused script.
   */
  beforeStatement?(statement: Statement): void | Promise<void>;
  /** Called before each statement runs — the console's streaming transcript. */
  onStatement?(statement: Statement): void;
  /**
   * Cancels the run. Checked before each statement, and it also interrupts
   * the statement in flight: `execute` stops awaiting it the moment the signal
   * fires, so a `wait 3600` does not hold a cancelled run — and a recording it
   * started — open for an hour. The host's call is abandoned rather than
   * undone; for `wait`, that is a timer nobody is listening to any more.
   *
   * Structural rather than `AbortSignal` so this package keeps no DOM types —
   * an `AbortSignal` satisfies it.
   */
  signal?: ScriptCancelSignal;
}

export interface ExecutionReport {
  /** How many statements ran. Equal to `program.statements.length` on success. */
  readonly ran: number;
  /** Frames the script captured, in the order it captured them. */
  readonly images: readonly ScriptImage[];
}
