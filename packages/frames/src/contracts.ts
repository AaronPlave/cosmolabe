// The two published seam contracts of ADR M-0002, transcribed exactly as typed
// in docs/design/02 section 2. Everything above the frames tier consumes state
// and orientation through StateProvider and epoch and frame semantics through
// FramesService; nothing above this tier calls CSPICE directly (iron rule 1).
// Units are SPICE kilometers and kilometers per second at these contracts
// (iron rule 9); conversions happen at the render boundary.

/** A NAIF body name or numeric id string, as CSPICE accepts it ('CASSINI', '699', 'SUN'). */
export type BodyId = string;

/** A SPICE reference frame name ('J2000', 'ECLIPJ2000', 'IAU_SATURN', a CK frame). */
export type FrameId = string;

/** Ephemeris time: TDB seconds past the J2000 epoch, the one time scale of the tier. */
export type Et = number;

/** A duration in seconds. */
export type Seconds = number;

/** An ISO 8601 UTC instant, for example '2004-07-01T02:48:00Z' (the Z is optional). */
export type IsoString = string;

/**
 * Aberration correction, explicit at every call site and never defaulted:
 * silent aberration defaults are the single most likely source of km-scale
 * disagreement between the two cores (docs/design/02 section 2).
 */
export type Correction = 'NONE' | 'LT' | 'LT+S' | 'CN' | 'CN+S';

export interface StateQuery {
  targets: BodyId[];
  observer: BodyId;
  frame: FrameId;
  correction: Correction; // explicit at every call site
  epochs: Et[] | { start: Et; end: Et; step: Seconds };
}

/**
 * A zero-copy batch of states. The flat arrays are JS owned and transferable;
 * nothing here aliases WASM memory. Layout: epochs holds the n resolved sample
 * times; states holds targets.length blocks of n samples of 6 doubles
 * (x, y, z in km then vx, vy, vz in km/s), so the state of targets[t] at
 * epochs[i] begins at states[(t * n + i) * 6]; lightTimes holds the matching
 * one-way light times in seconds at lightTimes[t * n + i].
 */
export interface StateBatch {
  readonly targets: readonly BodyId[];
  readonly observer: BodyId;
  readonly frame: FrameId;
  readonly correction: Correction;
  readonly epochs: Float64Array;
  readonly states: Float64Array;
  readonly lightTimes: Float64Array;
}

/**
 * A batch of orientation quaternions for one body. quats holds n samples of 4
 * doubles in the SPICE scalar-first convention (w, x, y, z, the m2q layout);
 * each sample rotates vectors expressed in `frame` into the body-fixed frame
 * recorded in `bodyFrame`.
 */
export interface QuatBatch {
  readonly body: BodyId;
  readonly frame: FrameId;
  /** The resolved body-fixed frame the quaternions rotate into (for example IAU_SATURN). */
  readonly bodyFrame: FrameId;
  readonly epochs: Float64Array;
  readonly quats: Float64Array;
}

export interface StateProvider {
  states(q: StateQuery): Promise<StateBatch>; // zero-copy batch
  orientation(body: BodyId, frame: FrameId, epochs: Et[]): Promise<QuatBatch>;
}

/** A frame appearing in a chain, with its resolved NAIF frame id (namfrm). */
export interface FrameChainNode {
  readonly frame: FrameId;
  readonly frameId: number;
}

/** One rotation leg of a chain: a row-major 3x3 taking vectors from `from` to `to` at the chain epoch. */
export interface FrameChainLeg {
  readonly from: FrameId;
  readonly to: FrameId;
  readonly rotation: readonly number[];
}

/**
 * An inspectable, loggable frame conversion at one epoch. `rotation` is the
 * direct pxform result and is the value the tier converts with; `legs` factor
 * the same conversion through the J2000 pivot so a disagreement can be
 * localized to one side. A deeper walk of kernel-defined frame trees needs
 * frinfo_c, which the WASM export allowlist does not yet carry; extend
 * deliberately when a CK chain needs inspection below its J2000 legs.
 */
export interface FrameChain {
  readonly from: FrameId;
  readonly to: FrameId;
  readonly epoch: Et;
  readonly nodes: readonly FrameChainNode[];
  readonly legs: readonly FrameChainLeg[];
  readonly rotation: readonly number[];
}

/** One furnished kernel: its logical name, byte length, and content sha256 (hex). */
export interface KernelInfo {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * The furnished kernel set, hashable for provenance: setHash is the sha256 of
 * the sorted per-kernel content hashes, so two sessions loading the same bytes
 * in any order carry the same provenance key.
 */
export interface KernelSetInfo {
  readonly count: number;
  readonly kernels: readonly KernelInfo[];
  readonly setHash: string;
}

export interface FramesService {
  toEt(utc: IsoString): Et; // one conversion authority
  chain(from: FrameId, to: FrameId, epoch: Et): FrameChain; // inspectable, loggable
  kernels(): KernelSetInfo; // hashable for provenance
}
