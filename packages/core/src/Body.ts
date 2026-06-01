import type { Vec3 } from '@cosmolabe/spice';
import type { CartesianState, Trajectory } from './trajectories/Trajectory.js';
import { CompositeTrajectory } from './trajectories/CompositeTrajectory.js';
import type { RotationModel, Quaternion } from './rotations/RotationModel.js';

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
  /** Reference frame of the trajectory output. 'ecliptic' (default) or 'equatorial' (TEME/J2000 equatorial). */
  trajectoryFrame?: 'ecliptic' | 'equatorial' | 'body-fixed';
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
  readonly trajectoryFrame?: 'ecliptic' | 'equatorial' | 'body-fixed';
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
    this.trajectoryFrame = props.trajectoryFrame;
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
