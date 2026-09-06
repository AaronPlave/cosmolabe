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

/** A frame captured by the `screenshot` verb. */
export interface ScriptImage {
  /** PNG data URL of the captured frame. */
  readonly dataUrl: string;
  /** The label the script asked for, if any. */
  readonly label?: string;
}

/** Camera pose, as the port reports and accepts it. */
export interface ScriptCamera {
  /** Eye position in km, in the scene's current frame. */
  readonly position: ScriptVec3;
  /** Camera up vector (unit). */
  readonly up: ScriptVec3;
  /** Vertical field of view, in degrees. */
  readonly fov: number;
}

/** Events a host can observe. */
export interface ScriptEventMap {
  /** The selected object changed. `name` is null when the selection cleared. */
  select: { name: string | null };
  /** Scene time moved. */
  time: { et: number };
  /** A scene finished loading; `objects` is the new object list. */
  load: { objects: readonly string[] };
}

export type ScriptEventName = keyof ScriptEventMap;

/**
 * The control and observation surface of a Cosmolabe viewer.
 *
 * This is the contract; `window.cosmo` is one binding of it. Nothing in the
 * design may require a global, and no method may reach for one — an embedded
 * app, a test, or a future integration holds an instance directly.
 */
export interface ViewerControl {
  // ── Write: scene setup ──

  /**
   * Track `name` and frame it. Cuts to the object by default; pass
   * `seconds` to fly there over that many seconds instead.
   *
   * Cutting is the default because a fly-to is a wall-clock animation: a
   * caller that renders one frame and photographs it gets the camera
   * mid-flight, aimed at nothing in particular.
   */
  gotoObject(name: string, opts?: { seconds?: number }): boolean;
  /** Select `name` — what the info panel shows. */
  select(name: string): boolean;
  /** Clear the selection. */
  deselect(): void;
  /** Orbit-lock the camera to `name` without moving it. */
  track(name: string): boolean;
  /** Release the tracked object. The camera stays where it is. */
  untrack(): void;
  /** Aim the camera at `name` while continuing to orbit whatever it tracks. */
  pointAtObject(name: string): boolean;
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
  /** Set the vertical field of view, in degrees. */
  setFov(deg: number): boolean;
  /** Place the camera at an explicit eye position (km) with an optional up vector. */
  setCamera(position: ScriptVec3, up?: ScriptVec3): boolean;

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

  /** Current scene time, in seconds past J2000. */
  getTime(): number;
  /** Current playback rate, in scene-seconds per wall-second. */
  getRate(): number;
  isPlaying(): boolean;
  getSelected(): string | null;
  getTracked(): string | null;
  getCamera(): ScriptCamera;
  /** Every object in the loaded scene, by name. */
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
  readonly frame: { readonly mode: string; readonly body?: string };
  readonly camera: ScriptCamera;
  /** Layer name → on. Keys are `LAYERS` entries. */
  readonly layers: Readonly<Record<string, boolean>>;
  /** The caption currently displayed, if any. */
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

export interface ExecuteOptions {
  /** Called before each statement runs — the console's streaming transcript. */
  onStatement?(statement: Statement): void;
}

export interface ExecutionReport {
  /** How many statements ran. Equal to `program.statements.length` on success. */
  readonly ran: number;
  /** Frames the script captured, in the order it captured them. */
  readonly images: readonly ScriptImage[];
}
