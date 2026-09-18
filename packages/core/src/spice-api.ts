// The SPICE interface core is written against — the injection seam, and
// nothing more.
//
// core never constructs a SPICE engine: every call site takes one by
// injection, typed only as `SpiceInstance`. The types therefore belong here,
// on the consumer's side of the seam, rather than in whichever package
// happens to satisfy them today. Two implementations do:
//
//   @cosmolabe/frames  createHeritageSpice(), the cspice-wasm backed adapter
//                      the viewer and the trajectory cache worker construct —
//                      the runtime path (ADR M-0002, iron rule 1).
//   @cosmolabe/spice   the timecraftjs wrapper, now the independent reference
//                      implementation the WASM path is differentially checked
//                      against in tests.
//
// Neither is imported here, and core depends on neither. Keeping the interface
// in core is what let the heritage adapter be swapped in underneath without a
// line of core changing; a `cspice-wasm → frames → core` static chain would
// give that up. Structural typing does the rest — an implementation satisfies
// this surface by shape, not by importing it.

/** 3D vector [x, y, z]. */
export type Vec3 = [number, number, number];

/** 6-element state vector [x, y, z, vx, vy, vz]. */
export type StateVector = [number, number, number, number, number, number];

/** 3x3 rotation matrix (row-major, 9 elements). */
export type RotationMatrix = [number, number, number, number, number, number, number, number, number];

/** 6x6 state transformation matrix (row-major, 36 elements). */
export type StateTransformMatrix = number[];

/** Orbital elements, the oscelt/conics layout. */
export type OrbitalElements = {
  rp: number;      // Perifocal distance
  ecc: number;     // Eccentricity
  inc: number;     // Inclination (radians)
  lnode: number;   // Longitude of ascending node (radians)
  argp: number;    // Argument of periapsis (radians)
  m0: number;      // Mean anomaly at epoch (radians)
  t0: number;      // Epoch (ephemeris seconds past J2000)
  mu: number;      // Gravitational parameter (km^3/s^2)
};

/** Illumination angles. */
export type IlluminationAngles = {
  phaseAngle: number;     // radians
  solarIncidence: number; // radians
  emission: number;       // radians
};

/** Sub-point result. */
export type SubPoint = {
  point: Vec3;       // Surface point in body-fixed frame (km)
  altitude: number;  // Altitude above surface (km)
  longitude: number; // Planetocentric longitude (radians)
  latitude: number;  // Planetocentric latitude (radians)
};

/** Surface intercept result. */
export type SurfaceIntercept = {
  point: Vec3;     // Intercept point in body-fixed frame (km)
  found: boolean;
  trgepc: number;  // Target epoch
  srfvec: Vec3;    // Observer to intercept vector
};

/** Geometry finder time window. */
export type TimeWindow = {
  start: number;  // ET start
  end: number;    // ET end
};

/**
 * Aberration correction. The full nine-value heritage union: the five of the
 * M-0002 `Correction` contract plus the four transmission corrections.
 */
export type AberrationCorrection = 'NONE' | 'LT' | 'LT+S' | 'CN' | 'CN+S' | 'XLT' | 'XLT+S' | 'XCN' | 'XCN+S';

/** FOV shape types returned by getfov_c. */
export type FovShape = 'POLYGON' | 'RECTANGLE' | 'CIRCLE' | 'ELLIPSE';

/** Instrument field of view definition. */
export interface InstrumentFov {
  shape: FovShape;
  frame: string;
  boresight: Vec3;
  bounds: Vec3[];
}

/** A kernel to furnish, by path, URL, or already-read bytes. */
export type KernelSource =
  | { type: 'file'; path: string }
  | { type: 'url'; url: string }
  | { type: 'buffer'; data: ArrayBuffer; filename: string };

export interface SpiceInstance {
  // Kernel management
  furnish(source: KernelSource): Promise<void>;
  unload(filename: string): void;
  clear(): void;
  totalLoaded(): number;
  // Time
  str2et(timeString: string): number;
  et2utc(et: number, format: 'C' | 'D' | 'J' | 'ISOC' | 'ISOD', precision: number): string;
  utc2et(utcString: string): number;
  et2lst(et: number, bodyId: number, longitude: number, type: 'PLANETOCENTRIC' | 'PLANETOGRAPHIC'): { hr: number; mn: number; sc: number; time: string; ampm: string };
  timout(et: number, pictur: string): string;
  unitim(epoch: number, insys: string, outsys: string): number;
  // State
  spkpos(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): { position: Vec3; lightTime: number };
  spkezr(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): { state: StateVector; lightTime: number };
  // Frames
  pxform(from: string, to: string, et: number): RotationMatrix;
  sxform(from: string, to: string, et: number): StateTransformMatrix;
  /** Get the frame name associated with a frame ID code. Returns null if not found. */
  frmnam(frcode: number): string | null;
  /** Get the frame ID and name associated with a body ID. Returns null if not found. */
  cidfrm(cent: number): { frcode: number; frname: string } | null;
  // Geometry
  sincpt(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string, dref: string, dvec: Vec3): SurfaceIntercept;
  subpnt(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string): SubPoint;
  subslr(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string): SubPoint;
  ilumin(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string, spoint: Vec3): IlluminationAngles;
  oscelt(state: StateVector, et: number, mu: number): OrbitalElements;
  conics(elements: OrbitalElements, et: number): StateVector;
  bodvcd(bodyId: number, item: string): number[];
  bodvrd(body: string, item: string): number[];
  bodc2n(code: number): string | null;
  bodn2c(name: string): number | null;
  // Events
  gfposc(target: string, frame: string, abcorr: string, observer: string, crdsys: string, coord: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[];
  gfsep(target1: string, shape1: string, frame1: string, target2: string, shape2: string, frame2: string, abcorr: string, observer: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[];
  gfoclt(occtyp: string, front: string, fshape: string, fframe: string, back: string, bshape: string, bframe: string, abcorr: string, observer: string, step: number, cnfine: TimeWindow[]): TimeWindow[];
  gfdist(target: string, abcorr: string, observer: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[];
  // Coverage
  spkcov(idcode: number): TimeWindow[];
  /** Return the NAIF IDs of all bodies present in the named SPK kernel. The kernel must be furnished. */
  spkobj(filename: string): number[];
  /** Return the coverage of one SPK file, unioned over every body it carries. */
  spkFileCoverage(filename: string): TimeWindow[];
  // FOV
  getfov(instId: number, maxBounds?: number): InstrumentFov;
  fovray(inst: string, raydir: Vec3, rframe: string, abcorr: AberrationCorrection, observer: string, et: number): boolean;
  fovtrg(inst: string, target: string, tshape: string, tframe: string, abcorr: AberrationCorrection, observer: string, et: number): boolean;
  // Math
  mxv(matrix: RotationMatrix, vin: Vec3): Vec3;
  mtxv(matrix: RotationMatrix, vin: Vec3): Vec3;
  vcrss(v1: Vec3, v2: Vec3): Vec3;
  vnorm(v: Vec3): number;
  vdot(v1: Vec3, v2: Vec3): number;
  vsep(v1: Vec3, v2: Vec3): number;
  vhat(v: Vec3): Vec3;
  vsub(v1: Vec3, v2: Vec3): Vec3;
  vadd(v1: Vec3, v2: Vec3): Vec3;
  vscl(s: number, v: Vec3): Vec3;
  recrad(rectan: Vec3): { range: number; ra: number; dec: number };
}
