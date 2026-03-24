import type { SpiceInstance, Vec3 } from '@spicecraft/spice';
import { Body, type TrajectoryPlotConfig } from '../Body.js';
import type { Trajectory } from '../trajectories/Trajectory.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';
import { KeplerianTrajectory } from '../trajectories/Keplerian.js';
import { SpiceTrajectory } from '../trajectories/SpiceTrajectory.js';
import { CompositeTrajectory } from '../trajectories/CompositeTrajectory.js';
import { InterpolatedStatesTrajectory } from '../trajectories/InterpolatedStates.js';
import { parseXyzv } from '../trajectories/XyzvParser.js';
import { TLETrajectory } from '../trajectories/TLETrajectory.js';
import { ChebyshevPolyTrajectory } from '../trajectories/ChebyshevPolyTrajectory.js';
import { LinearCombinationTrajectory } from '../trajectories/LinearCombinationTrajectory.js';
import { createAnalyticalTrajectory, createAnalyticalTrajectoryByName } from '../trajectories/analytical/AnalyticalTrajectory.js';
import type { RotationModel } from '../rotations/RotationModel.js';
import { UniformRotation } from '../rotations/UniformRotation.js';
import { SpiceRotation } from '../rotations/SpiceRotation.js';
import { NadirRotation } from '../rotations/NadirRotation.js';
import { TrajectoryNadirRotation } from '../rotations/TrajectoryNadirRotation.js';

// Cosmographia catalog JSON schema types
export interface CatalogJson {
  name?: string;
  version?: string;
  require?: string[];
  items?: CatalogItem[];
  /** Default time to set when loading this catalog (UTC string, e.g. "2004-07-01T02:48:00Z") */
  defaultTime?: string;
}

export interface TrajectoryPlotSpec {
  duration?: string;
  lead?: string;
  fade?: number;
  color?: string;
  opacity?: number;
  visible?: string | boolean;
  sampleCount?: number;
  lineWidth?: number;
}

export interface CatalogItem {
  name: string;
  type?: string;
  center?: string;
  class?: string;
  trajectoryFrame?: string;
  trajectory?: TrajectorySpec;
  trajectoryPlot?: TrajectoryPlotSpec;
  rotationModel?: RotationModelSpec;
  bodyFrame?: string | BodyFrameSpec;
  geometry?: GeometrySpec;
  label?: LabelSpec;
  naifId?: number;
  mass?: number | string;
  radii?: number[];
  startTime?: string;
  endTime?: string | number;
  items?: CatalogItem[];
  // Top-level arcs (Cosmographia uses this for spacecraft with multiple mission phases)
  arcs?: ArcSpec[];
}

export interface ArcSpec {
  center?: string;
  trajectoryFrame?: string;
  trajectory: TrajectorySpec;
  bodyFrame?: string | BodyFrameSpec;
  startTime?: string | number;
  endTime?: string | number;
}

export interface BodyFrameSpec {
  type: string;
  primaryAxis?: string;
  secondaryAxis?: string;
  primary?: Record<string, unknown>;
  secondary?: Record<string, unknown>;
  body?: string;
}

export interface TrajectorySpec {
  type: string;
  // FixedPoint
  position?: number[];
  // Keplerian — elements MUST be referenced to the ecliptic J2000 plane (the scene coordinate system).
  // Satellite elements from databases are typically in the central body's equatorial plane, NOT ecliptic J2000.
  // For planetary moons use Builtin (analytical theory) or Spice instead.
  // Values may be numbers or strings with unit suffixes like "42.99au", "281.9y".
  semiMajorAxis?: number | string;
  eccentricity?: number;
  inclination?: number;
  ascendingNode?: number;
  argOfPeriapsis?: number;
  argumentOfPeriapsis?: number;
  meanAnomaly?: number;
  period?: number | string;
  epoch?: string;
  // Spice
  target?: string;
  center?: string;
  // Builtin
  name?: string;
  // InterpolatedStates
  source?: string;
  // TLE
  line1?: string;
  line2?: string;
  // Composite
  arcs?: ArcSpec[];
  /** Cosmographia alias for arcs (used in some catalog files) */
  segments?: ArcSpec[];
  // LinearCombination
  weights?: number[];
  trajectories?: TrajectorySpec[];
  // Analytical theory (TASS17, L1, Gust86, MarsSat)
  satellite?: string;
  // Units
  distanceUnits?: string;
}

export interface RotationModelSpec {
  type: string;
  name?: string;
  period?: number;
  epoch?: string;
  meridianAngle?: number;
  inclination?: number;
  ascendingNode?: number;
  ascension?: number;
  declination?: number;
  bodyFrame?: string;
  inertialFrame?: string;
  /** For Nadir type: SPICE target name (e.g. "LRO", "-85") */
  target?: string;
  /** For Nadir type: SPICE center body name (e.g. "MOON") */
  center?: string;
}

export interface GeometrySpec {
  type: string;
  radius?: number;
  radii?: number[];
  size?: number;
  source?: string;
  meshFile?: string;
  meshRotation?: number[];
  sensor?: {
    horizontalFov?: number;
    verticalFov?: number;
    frustumColor?: number[];
    target?: string;
  };
  [key: string]: unknown;
}

export interface LabelSpec {
  color?: number[] | string;
  fadeSize?: number;
}

/** A viewpoint definition parsed from a Cosmographia catalog Viewpoint item */
export interface ViewpointDefinition {
  name: string;
  /** Body to center the view on */
  center?: string;
  /** Reference frame (default: EclipticJ2000) */
  frame?: string;
  /** Distance from center body in km */
  distance?: number;
  /** Longitude offset in degrees (azimuth around center) */
  longitude?: number;
  /** Latitude offset in degrees (elevation from equatorial plane) */
  latitude?: number;
  /** Explicit eye position [x, y, z] in km (overrides spherical coords) */
  eye?: [number, number, number];
  /** Explicit target position [x, y, z] in km */
  target?: [number, number, number];
  /** Up direction */
  up?: [number, number, number];
  /** Field of view in degrees */
  fov?: number;
}

export interface LoadedCatalog {
  bodies: Body[];
  viewpoints: ViewpointDefinition[];
  name?: string;
  version?: string;
  require?: string[];
}

const DISTANCE_SCALE: Record<string, number> = {
  km: 1, m: 0.001, au: 149597870.7, mm: 1e-6, cm: 1e-5,
};

/** Parse a numeric value that may have a unit suffix (e.g. "42.99au", "281.9y", "1000km") */
function parseValueWithUnit(val: number | string | undefined, defaultVal: number): number {
  if (val == null) return defaultVal;
  if (typeof val === 'number') return val;
  const match = val.match(/^([+-]?[\d.eE+-]+)\s*(\w*)$/);
  if (!match) return defaultVal;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return defaultVal;
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 'au': return num * 149597870.7;
    case 'km': return num;
    case 'm': return num * 0.001;
    case 'y': return num * 365.25 * 86400; // years → seconds
    case 'd': return num * 86400;           // days → seconds
    case 'h': return num * 3600;            // hours → seconds
    case '': return num;
    default: return num;
  }
}

// Well-known GM values (km³/s²) for Keplerian orbit propagation without SPICE
const BODY_GM: Record<string, number> = {
  Sun: 132712440041.94, Earth: 398600.4418, Moon: 4902.8,
  Mars: 42828.37, Jupiter: 126686534, Saturn: 37931187,
  Uranus: 5793939, Neptune: 6836529, Venus: 324859, Mercury: 22032,
  Pluto: 871,
};

// Well-known Builtin body names → SPICE targets
const BUILTIN_BODIES: Record<string, { target: string; center: string }> = {
  Sun: { target: '10', center: 'SOLAR SYSTEM BARYCENTER' },
  Mercury: { target: '199', center: 'SUN' },
  Venus: { target: '299', center: 'SUN' },
  Earth: { target: '399', center: 'SUN' },
  EMB: { target: '3', center: 'SUN' },
  Mars: { target: '499', center: 'SUN' },
  Jupiter: { target: '599', center: 'SUN' },
  Saturn: { target: '699', center: 'SUN' },
  Uranus: { target: '799', center: 'SUN' },
  Neptune: { target: '899', center: 'SUN' },
  Pluto: { target: '999', center: 'SUN' },
  Moon: { target: '301', center: 'EARTH' },
  Phobos: { target: '401', center: 'MARS' },
  Deimos: { target: '402', center: 'MARS' },
  Io: { target: '501', center: 'JUPITER' },
  Europa: { target: '502', center: 'JUPITER' },
  Ganymede: { target: '503', center: 'JUPITER' },
  Callisto: { target: '504', center: 'JUPITER' },
  Mimas: { target: '601', center: 'SATURN' },
  Enceladus: { target: '602', center: 'SATURN' },
  Tethys: { target: '603', center: 'SATURN' },
  Dione: { target: '604', center: 'SATURN' },
  Rhea: { target: '605', center: 'SATURN' },
  Titan: { target: '606', center: 'SATURN' },
  Hyperion: { target: '607', center: 'SATURN' },
  Iapetus: { target: '608', center: 'SATURN' },
  Phoebe: { target: '609', center: 'SATURN' },
  Miranda: { target: '705', center: 'URANUS' },
  Ariel: { target: '701', center: 'URANUS' },
  Umbriel: { target: '702', center: 'URANUS' },
  Titania: { target: '703', center: 'URANUS' },
  Oberon: { target: '704', center: 'URANUS' },
  Triton: { target: '801', center: 'NEPTUNE' },
  Charon: { target: '901', center: 'PLUTO' },
};

// Fallback Keplerian elements for major planets at J2000 epoch (2000-01-01T12:00:00 TDB).
// Semi-major axis in km, angles in radians. Ecliptic J2000 frame, center = Sun.
// Used when SPICE is not available (e.g. pure Cosmographia catalogs without kernel files).
const DEG = Math.PI / 180;
const AU = 149597870.7;
const SUN_MU = 132712440041.94;

interface FallbackOrbit {
  semiMajorAxis: number; eccentricity: number; inclination: number;
  raan: number; argPeriapsis: number; meanAnomalyAtEpoch: number;
  mu: number; center: string;
}

const BUILTIN_KEPLERIAN: Record<string, FallbackOrbit> = {
  Mercury: {
    semiMajorAxis: 0.38710 * AU, eccentricity: 0.20563,
    inclination: 7.005 * DEG, raan: 48.331 * DEG,
    argPeriapsis: 29.124 * DEG, meanAnomalyAtEpoch: 174.796 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  Venus: {
    semiMajorAxis: 0.72333 * AU, eccentricity: 0.00677,
    inclination: 3.3946 * DEG, raan: 76.680 * DEG,
    argPeriapsis: 54.884 * DEG, meanAnomalyAtEpoch: 50.115 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  Earth: {
    semiMajorAxis: 1.00000 * AU, eccentricity: 0.01671,
    inclination: 0.00005 * DEG, raan: -11.261 * DEG,
    argPeriapsis: 102.937 * DEG, meanAnomalyAtEpoch: 357.529 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  EMB: {
    semiMajorAxis: 1.00000 * AU, eccentricity: 0.01671,
    inclination: 0.00005 * DEG, raan: -11.261 * DEG,
    argPeriapsis: 102.937 * DEG, meanAnomalyAtEpoch: 357.529 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  Mars: {
    semiMajorAxis: 1.52368 * AU, eccentricity: 0.09341,
    inclination: 1.8497 * DEG, raan: 49.558 * DEG,
    argPeriapsis: 286.502 * DEG, meanAnomalyAtEpoch: 19.373 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  Jupiter: {
    semiMajorAxis: 5.20260 * AU, eccentricity: 0.04839,
    inclination: 1.3033 * DEG, raan: 100.464 * DEG,
    argPeriapsis: 273.867 * DEG, meanAnomalyAtEpoch: 20.020 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  Saturn: {
    semiMajorAxis: 9.55491 * AU, eccentricity: 0.05415,
    inclination: 2.4889 * DEG, raan: 113.666 * DEG,
    argPeriapsis: 339.392 * DEG, meanAnomalyAtEpoch: 317.021 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  Uranus: {
    semiMajorAxis: 19.2184 * AU, eccentricity: 0.04717,
    inclination: 0.7732 * DEG, raan: 74.006 * DEG,
    argPeriapsis: 96.999 * DEG, meanAnomalyAtEpoch: 142.239 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  Neptune: {
    semiMajorAxis: 30.1104 * AU, eccentricity: 0.00859,
    inclination: 1.7700 * DEG, raan: 131.784 * DEG,
    argPeriapsis: 276.336 * DEG, meanAnomalyAtEpoch: 256.228 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  Pluto: {
    semiMajorAxis: 39.4821 * AU, eccentricity: 0.24881,
    inclination: 17.1417 * DEG, raan: 110.299 * DEG,
    argPeriapsis: 113.834 * DEG, meanAnomalyAtEpoch: 14.533 * DEG,
    mu: SUN_MU, center: 'Sun',
  },
  Moon: {
    semiMajorAxis: 384400, eccentricity: 0.0549,
    inclination: 5.145 * DEG, raan: 125.08 * DEG,
    argPeriapsis: 318.15 * DEG, meanAnomalyAtEpoch: 135.27 * DEG,
    mu: 398600.4418, center: 'Earth',
  },
};

export interface CatalogLoaderOptions {
  spice?: SpiceInstance;
  /** Resolve trajectory data files (e.g. .xyzv). Return file text content or undefined if unavailable. */
  resolveFile?: (source: string) => string | undefined;
  /** Resolve binary data files (e.g. .cheb). Return raw bytes or undefined if unavailable. */
  resolveFileBinary?: (source: string) => ArrayBuffer | undefined;
}

export class CatalogLoader {
  private readonly spice?: SpiceInstance;
  private readonly resolveFile?: (source: string) => string | undefined;
  private readonly resolveFileBinary?: (source: string) => ArrayBuffer | undefined;
  /** Epoch (ET) used to probe whether SPICE kernels have coverage. Set from catalog's defaultTime. */
  private probeEpoch = 0;

  constructor(spiceOrOptions?: SpiceInstance | CatalogLoaderOptions) {
    if (!spiceOrOptions) return;
    // Distinguish SpiceInstance (has furnish method) from options object
    if (typeof (spiceOrOptions as SpiceInstance).furnish === 'function') {
      this.spice = spiceOrOptions as SpiceInstance;
    } else {
      const opts = spiceOrOptions as CatalogLoaderOptions;
      this.spice = opts.spice;
      this.resolveFile = opts.resolveFile;
      this.resolveFileBinary = opts.resolveFileBinary;
    }
  }

  load(json: CatalogJson): LoadedCatalog {
    // If catalog specifies a defaultTime, use it as the probe epoch for SPICE coverage checks.
    // This ensures Builtin bodies use SPICE data when the loaded kernels cover the mission epoch
    // (e.g. a Cassini SCPSE kernel covering 2004 would fail the default J2000 probe at ET=0).
    if (json.defaultTime && this.spice) {
      try {
        this.probeEpoch = this.spice.str2et(json.defaultTime);
      } catch { /* keep default 0 */ }
    }

    const bodies: Body[] = [];
    const viewpoints: ViewpointDefinition[] = [];

    if (json.items) {
      for (const item of json.items) {
        if (item.type === 'Viewpoint') {
          viewpoints.push(this.parseViewpoint(item));
        } else {
          this.loadItem(item, bodies, undefined);
        }
      }
    }

    return { bodies, viewpoints, name: json.name, version: json.version, require: json.require };
  }

  private parseViewpoint(item: CatalogItem): ViewpointDefinition {
    const vp: ViewpointDefinition = { name: item.name };
    vp.center = item.center;
    // Parse viewpoint-specific fields from the generic CatalogItem
    const raw = item as unknown as Record<string, unknown>;
    if (raw.frame) vp.frame = String(raw.frame);
    if (raw.distance != null) vp.distance = parseFloat(String(raw.distance));
    if (raw.longitude != null) vp.longitude = parseFloat(String(raw.longitude));
    if (raw.latitude != null) vp.latitude = parseFloat(String(raw.latitude));
    if (Array.isArray(raw.eye)) vp.eye = raw.eye.map(Number) as [number, number, number];
    if (Array.isArray(raw.target)) vp.target = raw.target.map(Number) as [number, number, number];
    if (Array.isArray(raw.up)) vp.up = raw.up.map(Number) as [number, number, number];
    if (raw.fov != null) vp.fov = parseFloat(String(raw.fov));
    return vp;
  }

  private loadItem(item: CatalogItem, bodies: Body[], parentName: string | undefined): void {
    if (item.type === 'Visualizer' || item.type === 'FeatureLabels') {
      return;
    }

    // Skip purely decorative items with no trajectory (comet tails, etc.)
    // Rings are kept — the renderer creates visual geometry for them.
    if (!item.trajectory && !item.arcs) {
      const geoType = item.geometry?.type;
      if (geoType === 'ParticleSystem') {
        return;
      }
    }

    const trajectory = this.buildItemTrajectory(item);
    const rotation = this.buildRotationModel(item, trajectory);
    const radii = this.extractRadii(item);

    const trajectoryPlot = this.parseTrajectoryPlot(item.trajectoryPlot);

    // TLE trajectories output in TEME (≈equatorial), not ecliptic.
    // Catalog may also specify trajectoryFrame explicitly.
    const trajectoryFrame = item.trajectoryFrame === 'J2000' || item.trajectory?.type === 'TLE'
      ? 'equatorial' as const
      : undefined;

    const body = new Body({
      name: item.name,
      naifId: item.naifId,
      trajectory,
      rotation,
      parentName: parentName ?? item.center,
      radii,
      mass: typeof item.mass === 'number' ? item.mass : this.parseMass(item.mass),
      classification: item.class,
      labelColor: item.label?.color ? this.parseColor(item.label.color) : undefined,
      geometryType: item.geometry?.type,
      geometryData: item.geometry ? { ...item.geometry } : undefined,
      trajectoryPlot,
      trajectoryFrame,
    });

    bodies.push(body);

    if (item.items) {
      for (const child of item.items) {
        this.loadItem(child, bodies, item.name);
      }
    }
  }

  private buildItemTrajectory(item: CatalogItem): Trajectory {
    // Top-level arcs (Cassini pattern: multiple mission phases at item level)
    if (item.arcs && item.arcs.length > 0) {
      return this.buildArcsTrajectory(item, item.arcs);
    }

    return this.buildTrajectory(item.trajectory, item);
  }

  private buildArcsTrajectory(item: CatalogItem, arcs: ArcSpec[]): Trajectory {
    // Always wrap in CompositeTrajectory so centerName is preserved for absolutePositionOf.
    // Even single-arc items (e.g. MSL Cruise Stage with center="MSL") need this.
    const compositeArcs = arcs.map((arc, i) => {
      const startTime = arc.startTime != null
        ? this.parseEpochValue(arc.startTime)
        : (item.startTime ? this.parseEpochValue(item.startTime) : 0);
      const endTime = arc.endTime != null
        ? this.parseEpochValue(arc.endTime)
        : (i < arcs.length - 1 && arcs[i + 1].startTime != null
          ? this.parseEpochValue(arcs[i + 1].startTime!)
          : startTime + 365.25 * 86400);

      return {
        trajectory: this.buildTrajectory(arc.trajectory, {
          ...item,
          center: arc.center ?? item.center,
          trajectoryFrame: arc.trajectoryFrame ?? item.trajectoryFrame,
        }),
        startTime,
        endTime,
        centerName: arc.center ?? item.center,
      };
    });

    return new CompositeTrajectory(compositeArcs);
  }

  private buildTrajectory(spec: TrajectorySpec | undefined, item: CatalogItem): Trajectory {
    if (!spec) {
      if (this.spice) {
        return new SpiceTrajectory(this.spice, item.name, item.center ?? 'SUN', item.trajectoryFrame ?? 'ECLIPJ2000');
      }
      return new FixedPointTrajectory([0, 0, 0]);
    }

    const distScale = DISTANCE_SCALE[spec.distanceUnits ?? 'km'] ?? 1;

    switch (spec.type) {
      case 'FixedPoint':
        return new FixedPointTrajectory(
          spec.position ? [spec.position[0] * distScale, spec.position[1] * distScale, spec.position[2] * distScale] : [0, 0, 0]
        );

      case 'Keplerian': {
        const sma = parseValueWithUnit(spec.semiMajorAxis, 0) * distScale;
        const argPeri = spec.argOfPeriapsis ?? spec.argumentOfPeriapsis ?? 0;
        return new KeplerianTrajectory({
          semiMajorAxis: sma,
          eccentricity: spec.eccentricity ?? 0,
          inclination: (spec.inclination ?? 0) * Math.PI / 180,
          raan: (spec.ascendingNode ?? 0) * Math.PI / 180,
          argPeriapsis: argPeri * Math.PI / 180,
          meanAnomalyAtEpoch: (spec.meanAnomaly ?? 0) * Math.PI / 180,
          epoch: spec.epoch ? this.parseEpochValue(spec.epoch) : 0,
          mu: BODY_GM[item.center ?? 'Sun'] ?? 0,
        });
      }

      case 'Builtin': {
        const bodyName = spec.name ?? item.name;
        const info = BUILTIN_BODIES[bodyName];
        if (this.spice) {
          const target = info?.target ?? bodyName;
          const center = item.center ?? info?.center ?? 'SUN';
          const frame = item.trajectoryFrame ?? 'ECLIPJ2000';
          const spiceTraj = new SpiceTrajectory(this.spice, target, center, frame);
          // Probe: check if SPICE actually has data for this body at the catalog's epoch
          try {
            spiceTraj.stateAt(this.probeEpoch);
            if (!spiceTraj.failed) return spiceTraj;
          } catch { /* fall through to analytical/Keplerian */ }
        }
        // Fallback: analytical theories for moons, Keplerian for planets
        const fallbackReason = this.spice ? 'no SPICE coverage' : 'no SPICE instance';
        const analytical = createAnalyticalTrajectoryByName(bodyName);
        if (analytical) {
          console.log(`[SpiceCraft] ${bodyName}: using analytical theory (${fallbackReason})`);
          return analytical;
        }
        const kep = BUILTIN_KEPLERIAN[bodyName];
        if (kep) {
          console.log(`[SpiceCraft] ${bodyName}: using Keplerian fallback (${fallbackReason})`);
          return new KeplerianTrajectory({
            semiMajorAxis: kep.semiMajorAxis,
            eccentricity: kep.eccentricity,
            inclination: kep.inclination,
            raan: kep.raan,
            argPeriapsis: kep.argPeriapsis,
            meanAnomalyAtEpoch: kep.meanAnomalyAtEpoch,
            epoch: 0, // J2000
            mu: kep.mu,
          });
        }
        return new FixedPointTrajectory([0, 0, 0]);
      }

      case 'Spice':
        if (!this.spice) throw new Error(`Spice trajectory for ${item.name} requires SPICE instance`);
        return new SpiceTrajectory(
          this.spice,
          spec.target ?? item.name,
          spec.center ?? item.center ?? 'SUN',
          item.trajectoryFrame ?? 'ECLIPJ2000',
        );

      case 'InterpolatedStates': {
        if (spec.source && this.resolveFile) {
          const text = this.resolveFile(spec.source);
          if (text) {
            const records = parseXyzv(text);
            if (records.length >= 2) {
              return new InterpolatedStatesTrajectory(records);
            }
          }
        }
        return new FixedPointTrajectory([0, 0, 0]);
      }

      case 'TLE':
        if (spec.line1 && spec.line2) {
          return new TLETrajectory({ line1: spec.line1, line2: spec.line2 });
        }
        return new FixedPointTrajectory([0, 0, 0]);

      case 'Composite': {
        const arcs = spec.arcs ?? spec.segments;
        if (arcs && arcs.length > 0) {
          return this.buildArcsTrajectory(item, arcs);
        }
        return new FixedPointTrajectory([0, 0, 0]);
      }

      case 'ChebyshevPoly': {
        if (spec.source && this.resolveFileBinary) {
          const data = this.resolveFileBinary(spec.source);
          if (data) {
            const traj = ChebyshevPolyTrajectory.fromBuffer(data);
            if (traj) {
              if (spec.period) traj.setPeriod(parseValueWithUnit(spec.period, 86400));
              return traj;
            }
          }
        }
        return new FixedPointTrajectory([0, 0, 0]);
      }

      case 'LinearCombination': {
        if (spec.trajectories && spec.weights && spec.trajectories.length >= 2 && spec.weights.length >= 2) {
          const t0 = this.buildTrajectory(spec.trajectories[0], item);
          const t1 = this.buildTrajectory(spec.trajectories[1], item);
          if (!(t0 instanceof FixedPointTrajectory) && !(t1 instanceof FixedPointTrajectory)) {
            const lc = new LinearCombinationTrajectory(t0, spec.weights[0], t1, spec.weights[1]);
            if (spec.period) lc.setPeriod(parseValueWithUnit(spec.period, 86400));
            return lc;
          }
        }
        return new FixedPointTrajectory([0, 0, 0]);
      }

      case 'TASS17':
      case 'L1':
      case 'Gust86':
      case 'MarsSat': {
        const satName = spec.satellite ?? spec.name ?? item.name;
        const traj = createAnalyticalTrajectory(spec.type, satName);
        if (traj) return traj;
        return new FixedPointTrajectory([0, 0, 0]);
      }

      case 'FixedSpherical':
        return new FixedPointTrajectory([0, 0, 0]);

      default:
        return new FixedPointTrajectory([0, 0, 0]);
    }
  }

  private buildRotationModel(item: CatalogItem, trajectory?: Trajectory): RotationModel | undefined {
    const spec = item.rotationModel;
    if (!spec) return undefined;

    switch (spec.type) {
      case 'Uniform': {
        // Period in Cosmographia catalogs is in days by default, but may have unit suffix (e.g. "24.6h")
        const periodRaw = spec.period ?? 1;
        // Bare number = days. String with unit suffix (e.g. "10.656h") = parsed.
        // String without unit (e.g. "25.38") = days (Cosmographia convention).
        const periodSec = typeof periodRaw === 'string'
          ? (/[a-zA-Z]/.test(periodRaw) ? parseValueWithUnit(periodRaw, 86400) : parseFloat(periodRaw) * 86400)
          : periodRaw * 86400;

        // Pole direction: ascension/declination are direct pole coords;
        // inclination/ascendingNode use orbital element convention and need conversion.
        // Cosmographia's inclination = tilt of equator from reference plane (0° = pole at ref north).
        let poleRaDeg: number;
        let poleDecDeg: number;
        if (spec.ascension != null || spec.declination != null) {
          poleRaDeg = spec.ascension ?? 0;
          poleDecDeg = spec.declination ?? 90;
        } else {
          const incDeg = spec.inclination ?? 0;
          const nodeDeg = spec.ascendingNode ?? 0;
          poleDecDeg = 90 - incDeg;
          poleRaDeg = nodeDeg - 90;
        }

        return new UniformRotation(
          periodSec,
          spec.epoch ? this.parseEpochValue(spec.epoch) : 0,
          (spec.meridianAngle ?? 0) * Math.PI / 180,
          poleRaDeg * Math.PI / 180,
          poleDecDeg * Math.PI / 180,
        );
      }

      case 'Builtin': {
        if (!this.spice) return undefined;
        const frameName = spec.name ?? `IAU_${item.name.toUpperCase()}`;
        // "IAU Moon" → "IAU_MOON"
        const normalized = frameName.replace(/\s+/g, '_').toUpperCase();
        // Use the trajectory's inertial frame so the rotation matches body positions.
        // Without this, a body with trajectoryFrame=J2000 but rotation in ECLIPJ2000
        // creates a ~23.4° offset (ecliptic obliquity).
        const inertialFrame = item.trajectoryFrame ?? 'ECLIPJ2000';
        return new SpiceRotation(this.spice, normalized, inertialFrame);
      }

      case 'Spice':
        if (!this.spice) return undefined;
        return new SpiceRotation(
          this.spice,
          spec.bodyFrame ?? `IAU_${item.name.toUpperCase()}`,
          spec.inertialFrame ?? item.trajectoryFrame ?? 'ECLIPJ2000',
        );

      case 'Nadir':
        if (this.spice) {
          return new NadirRotation(
            this.spice,
            spec.target ?? item.name,
            spec.center ?? item.center ?? 'EARTH',
            spec.inertialFrame ?? item.trajectoryFrame ?? 'ECLIPJ2000',
          );
        }
        // Fall back to trajectory-based nadir when SPICE isn't available (e.g. TLE bodies)
        if (trajectory) {
          return new TrajectoryNadirRotation(trajectory);
        }
        return undefined;

      case 'Fixed':
      case 'FixedEuler':
      case 'Interpolated':
        return undefined;

      default:
        return undefined;
    }
  }

  private extractRadii(item: CatalogItem): Vec3 | undefined {
    // From explicit radii array
    if (item.radii) {
      if (item.radii.length === 1) return [item.radii[0], item.radii[0], item.radii[0]];
      if (item.radii.length >= 3) return [item.radii[0], item.radii[1], item.radii[2]];
    }
    // From geometry.radii
    if (item.geometry?.radii) {
      const r = item.geometry.radii;
      if (r.length === 1) return [r[0], r[0], r[0]];
      if (r.length >= 3) return [r[0], r[1], r[2]];
    }
    // From geometry.radius (scalar → sphere)
    if (item.geometry?.radius != null) {
      const r = item.geometry.radius;
      return [r, r, r];
    }
    return undefined;
  }

  parseEpochValue(timeValue: string | number): number {
    if (typeof timeValue === 'number') {
      // Julian Date — convert to ET
      // JD 2451545.0 = J2000.0 epoch
      return (timeValue - 2451545.0) * 86400;
    }
    return this.parseEpoch(timeValue);
  }

  private parseEpoch(timeStr: string): number {
    if (this.spice) {
      // SPICE str2et doesn't accept trailing "Z" — strip it
      const spiceStr = timeStr.endsWith('Z') ? timeStr.slice(0, -1) : timeStr;
      try { return this.spice.str2et(spiceStr); } catch { /* fall through */ }
    }
    const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
    const ms = Date.parse(timeStr);
    if (isNaN(ms)) return 0;
    return (ms - J2000_MS) / 1000;
  }

  private parseColor(color: number[] | string): [number, number, number] {
    if (Array.isArray(color)) {
      return [color[0] ?? 1, color[1] ?? 1, color[2] ?? 1];
    }
    if (typeof color === 'string' && color.startsWith('#')) {
      const hex = color.slice(1);
      if (hex.length === 6) {
        return [
          parseInt(hex.slice(0, 2), 16) / 255,
          parseInt(hex.slice(2, 4), 16) / 255,
          parseInt(hex.slice(4, 6), 16) / 255,
        ];
      }
    }
    return [1, 1, 1];
  }

  private parseTrajectoryPlot(spec: TrajectoryPlotSpec | undefined): TrajectoryPlotConfig | undefined {
    if (!spec) return undefined;
    const config: TrajectoryPlotConfig = {};
    if (spec.duration != null) config.duration = parseValueWithUnit(spec.duration, 0);
    if (spec.lead != null) config.lead = parseValueWithUnit(spec.lead, 0);
    if (spec.fade != null) config.fade = Math.max(0, Math.min(1, spec.fade));
    if (spec.color != null) config.color = spec.color;
    if (spec.opacity != null) config.opacity = Math.max(0, Math.min(1, spec.opacity));
    if (spec.sampleCount != null) config.sampleCount = Math.max(100, Math.min(50000, spec.sampleCount));
    if (spec.visible != null) {
      config.visible = spec.visible === true || spec.visible === 'true';
    }
    return config;
  }

  private parseMass(mass: string | undefined): number | undefined {
    if (!mass) return undefined;
    const match = mass.match(/^([\d.eE+-]+)\s*(\w+)?$/);
    if (!match) return undefined;
    const value = parseFloat(match[1]);
    const unit = match[2]?.toLowerCase();
    switch (unit) {
      case 'kg': return value;
      case 'g': return value * 0.001;
      case 'mearth': return value * 5.972e24;
      default: return value;
    }
  }
}
