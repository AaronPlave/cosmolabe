// cspice-wasm: a typed, promise-based API over CSPICE-WASM running in a Web
// Worker. Phase 0 implements the engine and the worker transport; this module
// is the public surface the renderer and geometry layers call.

import type { EvalSpec, EvalSeriesResult } from './eval-series.ts';

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface StateVector {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly lightTime: number;
}

export interface PositionResult {
  readonly position: Vec3;
  readonly lightTime: number;
}

/** A Cartesian state (km, km/s) without light time, for propagation math. */
export interface CartesianState {
  readonly position: Vec3;
  readonly velocity: Vec3;
}

/** Osculating (two-body) orbital elements, the CSPICE oscelt/conics element set. */
export interface OsculatingElements {
  /** Perifocal distance (km). */
  readonly rp: number;
  /** Eccentricity. */
  readonly ecc: number;
  /** Inclination (radians). */
  readonly inc: number;
  /** Longitude of the ascending node (radians). */
  readonly lnode: number;
  /** Argument of periapsis (radians). */
  readonly argp: number;
  /** Mean anomaly at the epoch (radians). */
  readonly m0: number;
  /** Epoch (ET seconds past J2000). */
  readonly t0: number;
  /** Gravitational parameter of the central body (km^3/s^2). */
  readonly mu: number;
}

export type AberrationCorrection =
  | 'NONE'
  | 'LT'
  | 'LT+S'
  | 'CN'
  | 'CN+S'
  | 'XLT'
  | 'XLT+S'
  | 'XCN'
  | 'XCN+S';

/** The minimal SPICE surface the renderer needs (SPEC 5.1). */
export interface SpiceEngine {
  furnsh(name: string, bytes: Uint8Array): Promise<void>;
  unload(name: string): Promise<void>;
  kclear(): Promise<void>;
  ktotal(kind?: string): Promise<number>;

  str2et(utc: string): Promise<number>;
  et2utc(et: number, format: string, precision: number): Promise<string>;
  /** Ephemeris time (TDB seconds) to a TDB ISO calendar string (Barycentric Dynamical Time). */
  et2tdb(et: number, precision: number): Promise<string>;
  utc2et(utc: string): Promise<number>;

  spkpos(
    target: string,
    et: number,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): Promise<PositionResult>;
  spkezr(
    target: string,
    et: number,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): Promise<StateVector>;

  /** Osculating elements of a state about a body of gravitational parameter mu (oscelt). */
  oscelt(state: CartesianState, et: number, mu: number): Promise<OsculatingElements>;
  /** Cartesian state from osculating elements, propagated to et (conics). */
  conics(elements: OsculatingElements, et: number): Promise<CartesianState>;
  /** Two-body propagation of a state by dt seconds about gravitational parameter mu (prop2b). */
  prop2b(mu: number, state: CartesianState, dt: number): Promise<CartesianState>;

  /**
   * Occultation/eclipse intervals (gfoclt) over [start,stop]: when `back`
   * (bshape/bframe) is occulted by `front` (fshape/fframe) as seen from observer.
   * `step` (s) must be shorter than the briefest event. Returns [start,stop] ET
   * intervals (empty when none).
   */
  gfoclt(
    occtyp: string,
    front: string,
    fshape: string,
    fframe: string,
    back: string,
    bshape: string,
    bframe: string,
    abcorr: AberrationCorrection,
    observer: string,
    step: number,
    start: number,
    stop: number,
  ): Promise<[number, number][]>;
  /**
   * Distance interval finder (gfdist): intervals over [start,stop] in which the
   * observer-to-target distance (km) satisfies `relate` (e.g. "<", ">") vs refval.
   */
  gfdist(
    target: string,
    abcorr: AberrationCorrection,
    observer: string,
    relate: string,
    refval: number,
    step: number,
    start: number,
    stop: number,
  ): Promise<[number, number][]>;
  /**
   * Angular-separation interval finder (gfsep): intervals over [start,stop] in which
   * the apparent angular separation (rad) between targ1 (shape1/frame1) and targ2
   * (shape2/frame2) seen from observer satisfies `relate` (e.g. "<", ">") vs refval.
   * `shapeN` is "POINT" or "SPHERE"; `frameN` is used only for a SPHERE. `adjust`
   * applies only to the ABSMAX/ABSMIN/LOCMAX/LOCMIN relations.
   */
  gfsep(
    targ1: string,
    shape1: string,
    frame1: string,
    targ2: string,
    shape2: string,
    frame2: string,
    abcorr: AberrationCorrection,
    observer: string,
    relate: string,
    refval: number,
    adjust: number,
    step: number,
    start: number,
    stop: number,
  ): Promise<[number, number][]>;
  /**
   * Coordinate interval finder on an observer-target position (gfposc): intervals
   * over [start,stop] in which one coordinate (`coord`) of the observer-to-target
   * vector, in reference frame `frame` and coordinate system `crdsys` (e.g.
   * "LATITUDINAL"), satisfies `relate` vs refval. For topocentric elevation use a
   * topocentric `frame` with crdsys="LATITUDINAL", coord="LATITUDE" (rad). `adjust`
   * applies only to the ABSMAX/ABSMIN/LOCMAX/LOCMIN relations.
   */
  gfposc(
    target: string,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
    crdsys: string,
    coord: string,
    relate: string,
    refval: number,
    adjust: number,
    step: number,
    start: number,
    stop: number,
  ): Promise<[number, number][]>;
  /** Instantaneous occultation code at et (occult); nonzero when an occultation occurs. */
  occult(
    targ1: string,
    shape1: string,
    frame1: string,
    targ2: string,
    shape2: string,
    frame2: string,
    abcorr: AberrationCorrection,
    observer: string,
    et: number,
  ): Promise<number>;

  /**
   * Batched spkpos over an epoch array: one call returns n*3 interleaved positions
   * (km), transferred zero-copy from the worker. (STK_PARITY_SPEC F3.)
   */
  spkposBatch(
    target: string,
    etArray: Float64Array,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): Promise<Float64Array>;

  /**
   * Batched spkezr over an epoch array: one call returns n*6 interleaved states
   * (x,y,z km then vx,vy,vz km/s) plus n light times, transferred zero-copy from
   * the worker. The batched-states primitive under the frames tier's
   * StateProvider (ADR M-0002).
   */
  spkezrBatch(
    target: string,
    etArray: Float64Array,
    frame: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): Promise<StateBatchArrays>;

  /** Instrument field of view: shape, frame, boresight, and boundary vectors. */
  getfov(instId: number, room?: number): Promise<FovResult>;
  bodvrd(body: string, item: string): Promise<number[]>;
  bodvcd(bodyId: number, item: string): Promise<number[]>;
  /** Rotation (row-major 3x3) from one frame to another at et. */
  pxform(from: string, to: string, et: number): Promise<Mat3>;
  /** State transformation (row-major 6x6) from one frame to another at et. */
  sxform(from: string, to: string, et: number): Promise<number[]>;
  /** Surface intercept of a ray (dvec in dref) from observer onto target. */
  sincpt(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
    dref: string,
    dvec: Vec3,
  ): Promise<InterceptResult>;
  /** Sub-observer point on target. */
  subpnt(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
  ): Promise<SubPointResult>;

  /** Illumination angles (phase, incidence, emission) at a surface point. */
  ilumin(
    method: string,
    target: string,
    et: number,
    fixref: string,
    abcorr: AberrationCorrection,
    observer: string,
    point: Vec3,
  ): Promise<IluminResult>;

  /**
   * Write an SPK Type 13 (Hermite) segment for `body` about `center` and load it,
   * so a propagated arc renders through the existing spkpos/spkezr pipeline.
   * `states` is n*6 interleaved (x,y,z,vx,vy,vz) km/km-per-s; `et` is n epochs.
   */
  writeSpkType13(
    name: string,
    body: number,
    center: number,
    frame: string,
    segid: string,
    degree: number,
    et: Float64Array,
    states: Float64Array,
  ): Promise<void>;

  /** Ephemeris seconds past J2000 (ET) to continuous encoded SCLK ticks (sce2c). */
  sce2c(sc: number, et: number): Promise<number>;
  /** Continuous encoded SCLK ticks to ephemeris seconds past J2000 (ET) (sct2e). */
  sct2e(sc: number, sclkdp: number): Promise<number>;
  /**
   * CK pointing query (ckgp): C-matrix (frame -> base) for `inst` at encoded SCLK
   * `sclkdp` within `tol` ticks, in reference frame `ref`. `found` is false (not an
   * error) when no record lies within tolerance.
   */
  ckgp(inst: number, sclkdp: number, tol: number, ref: string): Promise<CkPointing>;
  /**
   * Write a CK Type 3 segment (discrete quaternions + optional angular rate, linear
   * interpolation) for `inst` and furnsh it, so the attitude history renders through
   * the existing pxform/ckgp pipeline. `sclkdp` is n encoded-SCLK tags (ascending);
   * `quats` is n*4 scalar-first quaternions (frame -> base, the SPICE m2q convention);
   * `avvs`, when present, is n*3 angular rates and sets the av flag; `starts` are the
   * interpolation-interval start tags (default the first tag). (STK_PARITY_SPEC ATT-6.)
   */
  writeCk03(
    name: string,
    inst: number,
    ref: string,
    segid: string,
    sclkdp: Float64Array,
    quats: Float64Array,
    avvs: Float64Array | null,
    starts: Float64Array,
  ): Promise<void>;

  /** Two-vector attitude (twovec): rotation with axis `indexa` along `axdef` and
   * axis `indexp` in the axdef-plndef plane (indices 1..3). Returns a row-major 3x3. */
  twovec(axdef: Vec3, indexa: number, plndef: Vec3, indexp: number): Promise<Mat3>;
  /** Rotation matrix -> SPICE quaternion [w, x, y, z] (m2q). */
  m2q(matrix: Mat3): Promise<number[]>;
  /** SPICE quaternion [w, x, y, z] -> rotation matrix (q2m). */
  q2m(quat: readonly number[]): Promise<Mat3>;
  /** Rotation axis (unit) and angle (rad) of a rotation matrix (raxisa). */
  raxisa(matrix: Mat3): Promise<{ axis: Vec3; angle: number }>;

  /** Read a DSK type-2 shape model (vertices km, 0-based plate indices). */
  readDsk(name: string, bytes: Uint8Array): Promise<DskShape>;

  /** Rectangular (body-fixed km) to geodetic lon/lat (rad) and altitude (km) (recgeo). */
  recgeo(rectan: Vec3, re: number, f: number): Promise<GeodeticPoint>;
  /** Local solar time at a body-fixed longitude (rad) (et2lst). */
  et2lst(et: number, body: number, lon: number, type: string): Promise<LocalSolarTime>;

  tkvrsn(): Promise<string>;
}

/** Geodetic coordinates from recgeo. */
export interface GeodeticPoint {
  /** Longitude (rad). */
  readonly lon: number;
  /** Geodetic latitude (rad). */
  readonly lat: number;
  /** Altitude above the reference ellipsoid (km). */
  readonly alt: number;
}

/** Local solar time from et2lst. */
export interface LocalSolarTime {
  readonly hr: number;
  readonly mn: number;
  readonly sc: number;
  /** "HH:MM:SC" formatted local time. */
  readonly time: string;
  readonly ampm: string;
}

export interface IluminResult {
  /** Solar phase angle at the point, radians. */
  readonly phase: number;
  /** Solar incidence angle, radians. */
  readonly incidence: number;
  /** Emission angle to the observer, radians. */
  readonly emission: number;
  readonly trgepc: number;
  readonly srfvec: Vec3;
}

export interface DskShape {
  /** Flat vertex coordinates in km in the body-fixed frame, length 3 * nv. */
  readonly vertices: number[];
  /** Flat triangle vertex indices, 0-based, length 3 * np. */
  readonly plates: number[];
}

/** Row-major 3x3 rotation matrix. */
export type Mat3 = readonly number[];

/**
 * A zero-copy state batch: n*6 interleaved states (x,y,z km, then vx,vy,vz
 * km/s per epoch) and n one-way light times (s). Both arrays are JS-owned and
 * transferable across the worker boundary.
 */
export interface StateBatchArrays {
  readonly states: Float64Array;
  readonly lightTimes: Float64Array;
}

export interface FovResult {
  readonly shape: string;
  readonly frame: string;
  readonly boresight: Vec3;
  readonly bounds: readonly Vec3[];
}

export interface InterceptResult {
  readonly found: boolean;
  readonly point: Vec3;
  readonly trgepc: number;
  readonly srfvec: Vec3;
}

export interface SubPointResult {
  readonly point: Vec3;
  readonly trgepc: number;
  readonly srfvec: Vec3;
}

/** CK pointing result from ckgp: the C-matrix and the SCLK at which it was found. */
export interface CkPointing {
  /** Whether a pointing record was found within tolerance. */
  readonly found: boolean;
  /** Row-major 3x3 C-matrix (frame -> base); identity-shaped and meaningless when not found. */
  readonly cmat: Mat3;
  /** The encoded SCLK tick value of the returned pointing. */
  readonly clkout: number;
}

/** Located, typed SPICE error. Fail loudly (CLAUDE.md). */
export class SpiceError extends Error {
  constructor(
    message: string,
    readonly shortMessage?: string,
  ) {
    super(message);
    this.name = 'SpiceError';
  }
}

/**
 * A SpiceEngine that also runs F3 batched/cancellable time-series jobs in one round
 * trip (the worker client and the worker pool implement this; bare in-process callers
 * use runEvalSpec directly). (STK_PARITY_SPEC F3.)
 */
export interface SpiceComputeEngine extends SpiceEngine {
  /**
   * Evaluate an EvalSpec over its grid, returning one column per provider output.
   * Pass an AbortSignal to cancel a long sweep; the returned promise then rejects.
   */
  evalSeries(spec: EvalSpec, signal?: AbortSignal): Promise<EvalSeriesResult>;
}

export type { SpiceWorkerRequest, SpiceWorkerResponse } from './protocol.ts';
export { SpiceBindings } from './bindings.ts';
export {
  createSpiceBindings,
  createSpiceEngine,
  spiceEngineOver,
  type SpiceEngineOptions,
} from './engine.ts';
export { createSpiceWorkerClient } from './client.ts';
export { createSpiceWorkerPool, type SpiceWorkerPool } from './pool.ts';
export { installSpiceWorker, dispatchSpice, JobCancelledError, type SpiceWorkerScope } from './worker-core.ts';
export {
  runEvalSpec,
  gridEpochs,
  providerColumns,
  describeProvider,
  PROVIDER_CATALOG,
  type EvalSpec,
  type EvalGrid,
  type UniformGrid,
  type ExplicitGrid,
  type ProviderSpec,
  type ProviderKind,
  type ProviderDescriptor,
  type EvalSeriesResult,
  type EvalHooks,
} from './eval-series.ts';
