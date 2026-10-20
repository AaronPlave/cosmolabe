import type { Vec3 } from './spice-injection.js';
import type { CartesianState, Trajectory } from './trajectories/Trajectory.js';
import { CompositeTrajectory, type TrajectoryArc } from './trajectories/CompositeTrajectory.js';
import type { RotationModel, Quaternion } from './rotations/RotationModel.js';
import { BODY_FIXED, DEFAULT_FRAMES, WORLD_FRAME } from './frames/FrameRegistry.js';

/** The coarse three-bucket classification `trajectoryFrame` used to be. Kept
 *  as a derived, read-only view of `Body.frame` for consumers that only need
 *  to know "ecliptic, equatorial-ish inertial, or rotating with a body". */
export type LegacyTrajectoryFrame = 'ecliptic' | 'equatorial' | 'body-fixed';

/** Per-body trajectory plot configuration from Cosmographia's `trajectoryPlot` JSON field */
export interface TrajectoryPlotConfig {
  /** Trail duration in seconds */
  duration?: number;
  /** Lead duration in seconds (plot ahead of current time) */
  lead?: number;
  /** Fade fraction (0-1): portion of oldest trail that fades to transparent */
  fade?: number;
  /** Trail color as hex string (e.g. "#ffff00") or RGB float array [r, g, b] (0-1 each) */
  color?: string | number[];
  /** Overall trail opacity (0-1) */
  opacity?: number;
  /** Whether the trajectory plot is visible */
  visible?: boolean;
  /** Number of sample points */
  sampleCount?: number;
}

export interface BodyProperties {
  name: string;
  naifId?: number;
  trajectory: Trajectory;
  rotation?: RotationModel;
  parentName?: string;
  radii?: Vec3;            // [equatorial, equatorial, polar] in km
  mass?: number;           // kg
  mu?: number;             // gravitational parameter km^3/s^2
  labelColor?: [number, number, number];
  /** If false, the body has no label. Defaults to true. */
  labelVisible?: boolean;
  classification?: string; // 'planet' | 'moon' | 'spacecraft' | 'barycenter' | 'star' | 'asteroid' | 'comet'
  geometryType?: string;   // 'Globe' | 'Mesh' | 'Axes' | 'Sensor' | etc.
  geometryData?: Record<string, unknown>;
  trajectoryPlot?: TrajectoryPlotConfig;
  /** Frame the trajectory output is expressed in, by name: any `FrameRegistry`
   *  frame (`ECLIPJ2000`, `EME2000`/`J2000`, `ICRF`, `TEME`, `ITRF`,
   *  `IAU_<BODY>`, `BODY_FIXED`, a SPICE or declared frame). The legacy
   *  spellings `'ecliptic'`, `'equatorial'` and `'body-fixed'` are accepted and
   *  mean ECLIPJ2000, EME2000 and BODY_FIXED. A trajectory that knows its own
   *  frame (`Trajectory.frame`, e.g. TLE → TEME) overrides this. Defaults to
   *  ECLIPJ2000. */
  trajectoryFrame?: string;
  /** Existence window, ET seconds: before `existsFrom` and after `existsUntil`
   *  the body is not in the scene (Cosmographia's item `startTime`/`endTime`).
   *  Either bound may be omitted; with neither, the body always exists. */
  existsFrom?: number;
  existsUntil?: number;
}

function canonicalFrame(name: string): string {
  return DEFAULT_FRAMES.canonicalName(name);
}

/** The legacy bucket of a frame name. Unknown names (SPICE frames the default
 *  registry cannot see) count as inertial, which is what they were before. */
export function legacyBucket(frame: string): LegacyTrajectoryFrame {
  const canonical = canonicalFrame(frame);
  if (canonical === BODY_FIXED) return 'body-fixed';
  if (canonical === WORLD_FRAME) return 'ecliptic';
  const def = DEFAULT_FRAMES.get(canonical);
  if (def?.kind === 'body-fixed') return 'body-fixed';
  return 'equatorial';
}

export type BodyChangeField = 'trajectory' | 'rotation';
export type BodyChangeCallback = (body: Body, field: BodyChangeField) => void;

export class Body {
  readonly name: string;
  readonly naifId?: number;
  private _trajectory: Trajectory;
  private _rotation?: RotationModel;
  readonly parentName?: string;
  readonly radii?: Vec3;
  readonly mass?: number;
  readonly mu?: number;
  readonly labelColor?: [number, number, number];
  readonly labelVisible: boolean;
  readonly classification?: string;
  readonly geometryType?: string;
  readonly geometryData?: Record<string, unknown>;
  readonly trajectoryPlot?: TrajectoryPlotConfig;
  /** The frame the body's own properties declared, canonicalized; undefined
   *  when none was given. `frame` is what to use. */
  readonly declaredFrame?: string;
  /** Existence window bounds (ET seconds); see `existsAt`. */
  readonly existsFrom?: number;
  readonly existsUntil?: number;
  readonly children: Body[] = [];

  /** Called when trajectory or rotation is changed at runtime. Set by Universe. */
  onChange?: BodyChangeCallback;

  constructor(props: BodyProperties) {
    this.name = props.name;
    this.naifId = props.naifId;
    this._trajectory = props.trajectory;
    this._rotation = props.rotation;
    this.parentName = props.parentName;
    this.radii = props.radii;
    this.mass = props.mass;
    this.mu = props.mu;
    this.labelColor = props.labelColor;
    this.labelVisible = props.labelVisible !== false;
    this.classification = props.classification;
    this.geometryType = props.geometryType;
    this.geometryData = props.geometryData;
    this.trajectoryPlot = props.trajectoryPlot;
    this.declaredFrame = props.trajectoryFrame !== undefined
      ? canonicalFrame(props.trajectoryFrame)
      : undefined;
    this.existsFrom = props.existsFrom;
    this.existsUntil = props.existsUntil;
  }

  /** Whether `et` falls inside the body's own existence window (bounds
   *  inclusive). Says nothing about its parent or its data coverage:
   *  `Universe.isPresentAt` answers the whole question. */
  existsAt(et: number): boolean {
    if (this.existsFrom !== undefined && et < this.existsFrom) return false;
    if (this.existsUntil !== undefined && et > this.existsUntil) return false;
    return true;
  }

  /** Frame `stateAt(et).position` is expressed in, by name. The trajectory's
   *  intrinsic frame wins (SGP4 output is TEME whatever the catalog says), then
   *  the declared frame, then ECLIPJ2000. For a `CompositeTrajectory` this is
   *  the body-level default; `frameAt(et)` gives the active arc's. May be
   *  `BODY_FIXED`: fixed to the body this one is currently relative to. */
  get frame(): string {
    const intrinsic = this._trajectory.frame;
    return intrinsic !== undefined ? canonicalFrame(intrinsic) : (this.declaredFrame ?? WORLD_FRAME);
  }

  /** The frame of `stateAt(et)`: the active arc's frame for a composite
   *  trajectory (arc declaration, then the arc trajectory's intrinsic frame,
   *  then the body's), `frame` otherwise. */
  frameAt(et: number): string {
    if (this._trajectory instanceof CompositeTrajectory) {
      return this.arcFrame(this._trajectory.arcAt(et));
    }
    return this.frame;
  }

  /** The frame one arc of this body's composite trajectory is expressed in. */
  arcFrame(arc: TrajectoryArc): string {
    const f = arc.trajectory.frame ?? arc.frame;
    return f !== undefined ? canonicalFrame(f) : (this.declaredFrame ?? WORLD_FRAME);
  }

  /** @deprecated The three-bucket view of `frame`: `'body-fixed'` for frames
   *  that rotate with a body, `'ecliptic'` for ECLIPJ2000, `'equatorial'` for
   *  every other inertial frame (EME2000, ICRF, TEME, …). It cannot tell those
   *  apart; read `frame` / `frameAt(et)` instead. */
  get trajectoryFrame(): LegacyTrajectoryFrame {
    return legacyBucket(this.frame);
  }

  get trajectory(): Trajectory { return this._trajectory; }
  get rotation(): RotationModel | undefined { return this._rotation; }

  /** Replace the trajectory at runtime. Takes effect on the next frame. */
  setTrajectory(t: Trajectory): void {
    this._trajectory = t;
    this.onChange?.(this, 'trajectory');
  }

  /** Replace the rotation model at runtime. Takes effect on the next frame. */
  setRotation(r: RotationModel): void {
    this._rotation = r;
    this.onChange?.(this, 'rotation');
  }

  stateAt(et: number): CartesianState {
    return this._trajectory.stateAt(et);
  }

  rotationAt(et: number): Quaternion | undefined {
    return this._rotation?.rotationAt(et);
  }

  /** Returns the parent body name that's authoritative for THIS body AT
   *  this time. For bodies with a static (non-composite) trajectory this
   *  is just `parentName`. For bodies with a `CompositeTrajectory` whose
   *  arcs declare different `centerName` values, the active arc's center
   *  wins — matching what `Universe.absolutePositionOf` already uses
   *  internally for the parent-chain walk.
   *
   *  Use this whenever you'd reach for `body.parentName` to do body-fixed
   *  math (sub-point, surface velocity, altitude) on a multi-phase
   *  spacecraft: e.g. a lunar-lander mission whose cruise arc is
   *  Earth-centric and EDL/landed arcs are Moon-centric should switch
   *  from Earth body-fixed math to Moon body-fixed math at the EDL
   *  boundary, and that switch lives here.
   *
   *  Returns `undefined` only when neither the active arc nor the static
   *  `parentName` resolves a parent (e.g. the universe root). */
  activeParentAt(et: number): string | undefined {
    if (this._trajectory instanceof CompositeTrajectory) {
      return this._trajectory.arcAt(et).centerName ?? this.parentName;
    }
    return this.parentName;
  }
}
