// Worker message protocol between the main thread and the SPICE Web Worker.
// Requests are tagged by method; responses carry the matching id.

import type {
  AberrationCorrection,
  CartesianState,
  CkPointing,
  DskShape,
  FovResult,
  GeodeticPoint,
  IluminResult,
  InterceptResult,
  LocalSolarTime,
  Mat3,
  OsculatingElements,
  PositionResult,
  StateBatchArrays,
  StateVector,
  SubPointResult,
  Vec3,
} from './index.js';
import type { EvalSeriesResult, EvalSpec } from './eval-series.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- referenced by {@link} in the TSDoc below
import type { GfSearchReport } from './index.js';

/**
 * The half of a {@link GfSearchReport} that survives structured cloning.
 *
 * A progress callback does not cross a worker boundary, so the request asks for
 * progress and the worker answers with `progress` responses the client routes
 * back to the caller's callback. The cancellation flag does cross, because it is
 * shared memory -- and it has to be shared memory for the same reason it exists:
 * a worker blocked in a synchronous CSPICE call cannot read its own message
 * queue, so nothing short of shared memory reaches the running search.
 */
export interface GfWorkerReport {
  /** Post `progress` responses for this request. */
  progress?: boolean;
  /** Shared cancellation flag; see {@link GfSearchReport.cancelFlag}. */
  cancelFlag?: Int32Array;
}

export type SpiceWorkerRequest =
  | { id: number; method: 'furnsh'; name: string; bytes: Uint8Array }
  | { id: number; method: 'unload'; name: string }
  | { id: number; method: 'kclear' }
  | { id: number; method: 'ktotal'; kind: string }
  | { id: number; method: 'str2et'; utc: string }
  | { id: number; method: 'et2utc'; et: number; format: string; precision: number }
  | { id: number; method: 'et2tdb'; et: number; precision: number }
  | { id: number; method: 'utc2et'; utc: string }
  | {
      id: number;
      method: 'spkpos';
      target: string;
      et: number;
      frame: string;
      abcorr: AberrationCorrection;
      observer: string;
    }
  | {
      id: number;
      method: 'spkezr';
      target: string;
      et: number;
      frame: string;
      abcorr: AberrationCorrection;
      observer: string;
    }
  | { id: number; method: 'oscelt'; state: CartesianState; et: number; mu: number }
  | { id: number; method: 'conics'; elements: OsculatingElements; et: number }
  | { id: number; method: 'prop2b'; mu: number; state: CartesianState; dt: number }
  | {
      id: number;
      method: 'gfoclt';
      occtyp: string;
      front: string;
      fshape: string;
      fframe: string;
      back: string;
      bshape: string;
      bframe: string;
      abcorr: AberrationCorrection;
      observer: string;
      step: number;
      start: number;
      stop: number;
      report?: GfWorkerReport;
    }
  | {
      id: number;
      method: 'gfdist';
      target: string;
      abcorr: AberrationCorrection;
      observer: string;
      relate: string;
      refval: number;
      step: number;
      start: number;
      stop: number;
      report?: GfWorkerReport;
    }
  | {
      id: number;
      method: 'gfsep';
      targ1: string;
      shape1: string;
      frame1: string;
      targ2: string;
      shape2: string;
      frame2: string;
      abcorr: AberrationCorrection;
      observer: string;
      relate: string;
      refval: number;
      adjust: number;
      step: number;
      start: number;
      stop: number;
      report?: GfWorkerReport;
    }
  | {
      id: number;
      method: 'gfposc';
      target: string;
      frame: string;
      abcorr: AberrationCorrection;
      observer: string;
      crdsys: string;
      coord: string;
      relate: string;
      refval: number;
      adjust: number;
      step: number;
      start: number;
      stop: number;
      report?: GfWorkerReport;
    }
  | {
      id: number;
      method: 'occult';
      targ1: string;
      shape1: string;
      frame1: string;
      targ2: string;
      shape2: string;
      frame2: string;
      abcorr: AberrationCorrection;
      observer: string;
      et: number;
    }
  | {
      id: number;
      method: 'spkposBatch';
      target: string;
      etArray: Float64Array;
      frame: string;
      abcorr: AberrationCorrection;
      observer: string;
    }
  | {
      id: number;
      method: 'spkezrBatch';
      target: string;
      etArray: Float64Array;
      frame: string;
      abcorr: AberrationCorrection;
      observer: string;
    }
  | { id: number; method: 'getfov'; instId: number; room?: number }
  | { id: number; method: 'bodvrd'; body: string; item: string }
  | { id: number; method: 'bodvcd'; bodyId: number; item: string }
  | { id: number; method: 'pxform'; from: string; to: string; et: number }
  | { id: number; method: 'sxform'; from: string; to: string; et: number }
  | {
      id: number;
      method: 'sincpt';
      surfaceMethod: string;
      target: string;
      et: number;
      fixref: string;
      abcorr: AberrationCorrection;
      observer: string;
      dref: string;
      dvec: Vec3;
    }
  | {
      id: number;
      method: 'subpnt';
      surfaceMethod: string;
      target: string;
      et: number;
      fixref: string;
      abcorr: AberrationCorrection;
      observer: string;
    }
  | {
      id: number;
      method: 'ilumin';
      surfaceMethod: string;
      target: string;
      et: number;
      fixref: string;
      abcorr: AberrationCorrection;
      observer: string;
      point: Vec3;
    }
  | {
      id: number;
      method: 'writeSpkType13';
      name: string;
      body: number;
      center: number;
      frame: string;
      segid: string;
      degree: number;
      et: Float64Array;
      states: Float64Array;
    }
  | { id: number; method: 'sce2c'; sc: number; et: number }
  | { id: number; method: 'sct2e'; sc: number; sclkdp: number }
  | { id: number; method: 'ckgp'; inst: number; sclkdp: number; tol: number; ref: string }
  | {
      id: number;
      method: 'writeCk03';
      name: string;
      inst: number;
      ref: string;
      segid: string;
      sclkdp: Float64Array;
      quats: Float64Array;
      avvs: Float64Array | null;
      starts: Float64Array;
    }
  | { id: number; method: 'twovec'; axdef: Vec3; indexa: number; plndef: Vec3; indexp: number }
  | { id: number; method: 'm2q'; matrix: Mat3 }
  | { id: number; method: 'q2m'; quat: readonly number[] }
  | { id: number; method: 'raxisa'; matrix: Mat3 }
  | { id: number; method: 'readDsk'; name: string; bytes: Uint8Array }
  | { id: number; method: 'recgeo'; rectan: Vec3; re: number; f: number }
  | { id: number; method: 'et2lst'; et: number; body: number; lon: number; lstType: string }
  | { id: number; method: 'tkvrsn' }
  | { id: number; method: 'evalSeries'; spec: EvalSpec }
  | { id: number; method: 'cancelJob'; jobId: number };

export type SpiceWorkerResultMap = {
  furnsh: void;
  unload: void;
  kclear: void;
  ktotal: number;
  str2et: number;
  et2utc: string;
  et2tdb: string;
  utc2et: number;
  spkpos: PositionResult;
  spkposBatch: Float64Array;
  spkezrBatch: StateBatchArrays;
  spkezr: StateVector;
  oscelt: OsculatingElements;
  conics: CartesianState;
  prop2b: CartesianState;
  gfoclt: [number, number][];
  gfdist: [number, number][];
  gfsep: [number, number][];
  gfposc: [number, number][];
  occult: number;
  getfov: FovResult;
  bodvrd: number[];
  bodvcd: number[];
  pxform: Mat3;
  sxform: number[];
  sincpt: InterceptResult;
  subpnt: SubPointResult;
  ilumin: IluminResult;
  writeSpkType13: void;
  sce2c: number;
  sct2e: number;
  ckgp: CkPointing;
  writeCk03: void;
  twovec: Mat3;
  m2q: number[];
  q2m: Mat3;
  raxisa: { axis: Vec3; angle: number };
  readDsk: DskShape;
  recgeo: GeodeticPoint;
  et2lst: LocalSolarTime;
  tkvrsn: string;
  evalSeries: EvalSeriesResult;
  cancelJob: void;
};

export type SpiceWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | {
      id: number;
      ok: false;
      error: string;
      shortMessage?: string;
      /**
       * The thrown error's class name, so the client can rebuild the type
       * instead of flattening every failure to SpiceError.
       *
       * It has to cross: an interrupted search rejects with
       * SpiceSearchCancelled, and {@link GfSearchReport} promises that to
       * worker callers as much as to in-process ones. A caller has to tell "you
       * stopped this" from "this failed", and a message string is not a type.
       */
      name?: string;
    }
  /**
   * An in-flight geometry search reporting how far it has got. Carries no `ok`,
   * because the request is not finished: more progress, and then a result or an
   * error, still follow under the same id.
   */
  | { id: number; progress: { fraction: number; pass: number } };

/**
 * The response that ends a request, as opposed to an interim progress report.
 *
 * A request gets any number of `progress` messages and then exactly one of
 * these, so a caller collecting results keys on this type and lets progress
 * through separately.
 */
export type SpiceWorkerResult = Extract<SpiceWorkerResponse, { ok: boolean }>;

/** True for the response that ends a request; false for an interim progress report. */
export function isWorkerResult(res: SpiceWorkerResponse): res is SpiceWorkerResult {
  return !('progress' in res);
}
