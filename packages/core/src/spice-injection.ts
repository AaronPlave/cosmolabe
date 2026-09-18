// Transitional. The SPICE surface core still calls, declared on the consumer's
// side of the injection seam so that core imports no SPICE package.
//
// ── What this is ────────────────────────────────────────────────────────────
//
// core never constructs a SPICE engine: every entry point that needs one takes
// it as an argument. Two implementations satisfy this structurally today —
// @cosmolabe/frames' createHeritageSpice(), the cspice-wasm adapter that is the
// runtime path (ADR M-0002, iron rule 1), and @cosmolabe/spice's Spice, now the
// reference implementation used in tests. Neither is imported here, and core
// depends on neither. That is the property worth keeping: core depends on an
// interface and the frames tier satisfies it, which is why the heritage adapter
// could be swapped in underneath without a line of core changing. A
// `cspice-wasm → frames → core` static chain would give it up.
//
// ── What this is NOT ────────────────────────────────────────────────────────
//
// This is not core's SPICE API, and it is not the heritage SpiceInstance
// re-homed. The heritage adapter is scaffolding with a dissolution plan
// (packages/frames/src/heritage-spice.ts, docs/collab/RE-ENTRY-BRIEF.md): core
// call sites migrate to explicit StateQuery and FramesService calls, and the
// adapter shrinks method by method toward zero. This file shrinks with it.
//
// Two rules follow, and they are the point:
//
//   1. Only what core actually calls lives here. It is 25 members, not the
//      heritage adapter's 47 — everything core does not call was dropped, and
//      nothing is added here to mirror an implementation. A member that no
//      core call site needs does not belong in this file, however many SPICE
//      wrappers grow one.
//   2. It shrinks, never grows. A new core capability belongs in a narrow,
//      purpose-named contract owned by its consumer — the model is
//      GeometryFinderProvider in src/geometry/events/provider.ts, which is
//      what the end state looks like — or in the published M-0002 contracts
//      (StateProvider, FramesService). Not here.
//
// Drift between this and the implementations is a compile error, not a
// convention: src/__tests__/spice-injection-conformance.test.ts pins both
// implementations to this interface. An implementation gaining members core
// does not call is not drift and is correctly invisible here; an
// implementation losing one core does call fails the typecheck.

/** 3D vector [x, y, z]. */
export type Vec3 = [number, number, number];

/** 6-element state vector [x, y, z, vx, vy, vz]. */
export type StateVector = [number, number, number, number, number, number];

/** 3x3 rotation matrix (row-major, 9 elements). */
export type RotationMatrix = [number, number, number, number, number, number, number, number, number];

/** Orbital elements, the oscelt layout. */
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

/** Geometry finder time window. */
export type TimeWindow = {
  start: number;  // ET start
  end: number;    // ET end
};

/**
 * Aberration correction, explicit at every call site and never defaulted.
 * The full nine-value heritage union: the five of the M-0002 `Correction`
 * contract plus the four transmission corrections.
 */
export type AberrationCorrection = 'NONE' | 'LT' | 'LT+S' | 'CN' | 'CN+S' | 'XLT' | 'XLT+S' | 'XCN' | 'XCN+S';

/** A kernel to furnish, by path, URL, or already-read bytes. */
export type KernelSource =
  | { type: 'file'; path: string }
  | { type: 'url'; url: string }
  | { type: 'buffer'; data: ArrayBuffer; filename: string };

/**
 * The 25 members core calls. See the header: this shrinks, it does not grow.
 */
export interface SpiceInstance {
  // Kernel management. `furnish` is also the discriminant CatalogLoader's
  // constructor overload tests to tell an engine from an options object.
  furnish(source: KernelSource): Promise<void>;
  // Time
  str2et(timeString: string): number;
  et2lst(et: number, bodyId: number, longitude: number, type: 'PLANETOCENTRIC' | 'PLANETOGRAPHIC'): { hr: number; mn: number; sc: number; time: string; ampm: string };
  // State
  spkpos(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): { position: Vec3; lightTime: number };
  spkezr(target: string, et: number, frame: string, abcorr: AberrationCorrection, observer: string): { state: StateVector; lightTime: number };
  // Frames
  pxform(from: string, to: string, et: number): RotationMatrix;
  // Geometry
  subpnt(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string): SubPoint;
  subslr(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string): SubPoint;
  ilumin(method: string, target: string, et: number, fixref: string, abcorr: AberrationCorrection, observer: string, spoint: Vec3): IlluminationAngles;
  oscelt(state: StateVector, et: number, mu: number): OrbitalElements;
  bodvcd(bodyId: number, item: string): number[];
  bodc2n(code: number): string | null;
  bodn2c(name: string): number | null;
  // Events. EventFinder calls these directly; the event model's own boundary
  // is GeometryFinderProvider, which is the shape the rest should migrate to.
  gfposc(target: string, frame: string, abcorr: string, observer: string, crdsys: string, coord: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[];
  gfsep(target1: string, shape1: string, frame1: string, target2: string, shape2: string, frame2: string, abcorr: string, observer: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[];
  gfoclt(occtyp: string, front: string, fshape: string, fframe: string, back: string, bshape: string, bframe: string, abcorr: string, observer: string, step: number, cnfine: TimeWindow[]): TimeWindow[];
  gfdist(target: string, abcorr: string, observer: string, relate: string, refval: number, adjust: number, step: number, cnfine: TimeWindow[]): TimeWindow[];
  // Coverage
  spkcov(idcode: number): TimeWindow[];
  /** Return the NAIF IDs of all bodies present in the named SPK kernel. The kernel must be furnished. */
  spkobj(filename: string): number[];
  // Math
  vcrss(v1: Vec3, v2: Vec3): Vec3;
  vsep(v1: Vec3, v2: Vec3): number;
  vhat(v: Vec3): Vec3;
  vadd(v1: Vec3, v2: Vec3): Vec3;
  vscl(s: number, v: Vec3): Vec3;
  recrad(rectan: Vec3): { range: number; ra: number; dec: number };
}
