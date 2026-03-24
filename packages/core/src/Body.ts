import type { Vec3 } from '@spicecraft/spice';
import type { CartesianState, Trajectory } from './trajectories/Trajectory.js';
import type { RotationModel, Quaternion } from './rotations/RotationModel.js';

/** Per-body trajectory plot configuration from Cosmographia's `trajectoryPlot` JSON field */
export interface TrajectoryPlotConfig {
  /** Trail duration in seconds */
  duration?: number;
  /** Lead duration in seconds (plot ahead of current time) */
  lead?: number;
  /** Fade fraction (0-1): portion of oldest trail that fades to transparent */
  fade?: number;
  /** Trail color as hex string (e.g. "#ffff00") */
  color?: string;
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
  classification?: string; // 'planet' | 'moon' | 'spacecraft' | 'barycenter' | 'star' | 'asteroid' | 'comet'
  geometryType?: string;   // 'Globe' | 'Mesh' | 'Axes' | 'Sensor' | etc.
  geometryData?: Record<string, unknown>;
  trajectoryPlot?: TrajectoryPlotConfig;
  /** Reference frame of the trajectory output. 'ecliptic' (default) or 'equatorial' (TEME/J2000 equatorial). */
  trajectoryFrame?: 'ecliptic' | 'equatorial';
}

export class Body {
  readonly name: string;
  readonly naifId?: number;
  readonly trajectory: Trajectory;
  readonly rotation?: RotationModel;
  readonly parentName?: string;
  readonly radii?: Vec3;
  readonly mass?: number;
  readonly mu?: number;
  readonly labelColor?: [number, number, number];
  readonly classification?: string;
  readonly geometryType?: string;
  readonly geometryData?: Record<string, unknown>;
  readonly trajectoryPlot?: TrajectoryPlotConfig;
  readonly trajectoryFrame?: 'ecliptic' | 'equatorial';
  readonly children: Body[] = [];

  constructor(props: BodyProperties) {
    this.name = props.name;
    this.naifId = props.naifId;
    this.trajectory = props.trajectory;
    this.rotation = props.rotation;
    this.parentName = props.parentName;
    this.radii = props.radii;
    this.mass = props.mass;
    this.mu = props.mu;
    this.labelColor = props.labelColor;
    this.classification = props.classification;
    this.geometryType = props.geometryType;
    this.geometryData = props.geometryData;
    this.trajectoryPlot = props.trajectoryPlot;
    this.trajectoryFrame = props.trajectoryFrame;
  }

  stateAt(et: number): CartesianState {
    return this.trajectory.stateAt(et);
  }

  rotationAt(et: number): Quaternion | undefined {
    return this.rotation?.rotationAt(et);
  }
}
