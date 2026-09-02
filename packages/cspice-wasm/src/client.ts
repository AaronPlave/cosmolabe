// Main-thread client for the SPICE Web Worker. Implements SpiceEngine by posting
// tagged requests and resolving responses by id.

import {
  SpiceError,
  type AberrationCorrection,
  type CartesianState,
  type CkPointing,
  type DskShape,
  type FovResult,
  type GeodeticPoint,
  type IluminResult,
  type InterceptResult,
  type LocalSolarTime,
  type Mat3,
  type OsculatingElements,
  type PositionResult,
  type SpiceComputeEngine,
  type StateBatchArrays,
  type StateVector,
  type SubPointResult,
  type Vec3,
} from './index.ts';
import type { EvalSeriesResult, EvalSpec } from './eval-series.ts';
import type { SpiceWorkerRequest, SpiceWorkerResponse } from './protocol.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// Omit must distribute over the request union, otherwise it collapses to the
// shared keys (method) and drops each variant's payload fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function createSpiceWorkerClient(worker: Worker): SpiceComputeEngine {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  worker.addEventListener('message', (ev: MessageEvent<SpiceWorkerResponse>) => {
    const res = ev.data;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new SpiceError(res.error, res.shortMessage));
  });

  function send<T>(req: DistributiveOmit<SpiceWorkerRequest, 'id'>): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...req, id } as SpiceWorkerRequest);
    });
  }

  return {
    furnsh: (name, bytes) => send<void>({ method: 'furnsh', name, bytes }),
    unload: (name) => send<void>({ method: 'unload', name }),
    kclear: () => send<void>({ method: 'kclear' }),
    ktotal: (kind = 'ALL') => send<number>({ method: 'ktotal', kind }),
    str2et: (utc) => send<number>({ method: 'str2et', utc }),
    et2utc: (et, format, precision) => send<string>({ method: 'et2utc', et, format, precision }),
    et2tdb: (et, precision) => send<string>({ method: 'et2tdb', et, precision }),
    utc2et: (utc) => send<number>({ method: 'utc2et', utc }),
    spkpos: (target, et, frame, abcorr: AberrationCorrection, observer) =>
      send<PositionResult>({ method: 'spkpos', target, et, frame, abcorr, observer }),
    spkposBatch: (target, etArray, frame, abcorr: AberrationCorrection, observer) =>
      send<Float64Array>({ method: 'spkposBatch', target, etArray, frame, abcorr, observer }),
    spkezrBatch: (target, etArray, frame, abcorr: AberrationCorrection, observer) =>
      send<StateBatchArrays>({ method: 'spkezrBatch', target, etArray, frame, abcorr, observer }),
    spkezr: (target, et, frame, abcorr: AberrationCorrection, observer) =>
      send<StateVector>({ method: 'spkezr', target, et, frame, abcorr, observer }),
    oscelt: (state, et, mu) => send<OsculatingElements>({ method: 'oscelt', state, et, mu }),
    conics: (elements, et) => send<CartesianState>({ method: 'conics', elements, et }),
    prop2b: (mu, state, dt) => send<CartesianState>({ method: 'prop2b', mu, state, dt }),
    gfoclt: (occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, start, stop) =>
      send<[number, number][]>({
        method: 'gfoclt',
        occtyp,
        front,
        fshape,
        fframe,
        back,
        bshape,
        bframe,
        abcorr,
        observer,
        step,
        start,
        stop,
      }),
    gfdist: (target, abcorr, observer, relate, refval, step, start, stop) =>
      send<[number, number][]>({
        method: 'gfdist',
        target,
        abcorr,
        observer,
        relate,
        refval,
        step,
        start,
        stop,
      }),
    gfsep: (targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, relate, refval, adjust, step, start, stop) =>
      send<[number, number][]>({
        method: 'gfsep',
        targ1,
        shape1,
        frame1,
        targ2,
        shape2,
        frame2,
        abcorr,
        observer,
        relate,
        refval,
        adjust,
        step,
        start,
        stop,
      }),
    gfposc: (target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, start, stop) =>
      send<[number, number][]>({
        method: 'gfposc',
        target,
        frame,
        abcorr,
        observer,
        crdsys,
        coord,
        relate,
        refval,
        adjust,
        step,
        start,
        stop,
      }),
    occult: (targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, et) =>
      send<number>({
        method: 'occult',
        targ1,
        shape1,
        frame1,
        targ2,
        shape2,
        frame2,
        abcorr,
        observer,
        et,
      }),
    getfov: (instId, room) => send<FovResult>({ method: 'getfov', instId, room }),
    bodvrd: (body, item) => send<number[]>({ method: 'bodvrd', body, item }),
    bodvcd: (bodyId, item) => send<number[]>({ method: 'bodvcd', bodyId, item }),
    pxform: (from, to, et) => send<Mat3>({ method: 'pxform', from, to, et }),
    sxform: (from, to, et) => send<number[]>({ method: 'sxform', from, to, et }),
    sincpt: (method, target, et, fixref, abcorr: AberrationCorrection, observer, dref, dvec) =>
      send<InterceptResult>({
        method: 'sincpt',
        surfaceMethod: method,
        target,
        et,
        fixref,
        abcorr,
        observer,
        dref,
        dvec,
      }),
    subpnt: (method, target, et, fixref, abcorr: AberrationCorrection, observer) =>
      send<SubPointResult>({
        method: 'subpnt',
        surfaceMethod: method,
        target,
        et,
        fixref,
        abcorr,
        observer,
      }),
    ilumin: (method, target, et, fixref, abcorr: AberrationCorrection, observer, point) =>
      send<IluminResult>({
        method: 'ilumin',
        surfaceMethod: method,
        target,
        et,
        fixref,
        abcorr,
        observer,
        point,
      }),
    writeSpkType13: (name, body, center, frame, segid, degree, et, states) =>
      send<void>({ method: 'writeSpkType13', name, body, center, frame, segid, degree, et, states }),
    sce2c: (sc, et) => send<number>({ method: 'sce2c', sc, et }),
    sct2e: (sc, sclkdp) => send<number>({ method: 'sct2e', sc, sclkdp }),
    ckgp: (inst, sclkdp, tol, ref) => send<CkPointing>({ method: 'ckgp', inst, sclkdp, tol, ref }),
    writeCk03: (name, inst, ref, segid, sclkdp, quats, avvs, starts) =>
      send<void>({ method: 'writeCk03', name, inst, ref, segid, sclkdp, quats, avvs, starts }),
    twovec: (axdef, indexa, plndef, indexp) => send<Mat3>({ method: 'twovec', axdef, indexa, plndef, indexp }),
    m2q: (matrix) => send<number[]>({ method: 'm2q', matrix }),
    q2m: (quat) => send<Mat3>({ method: 'q2m', quat }),
    raxisa: (matrix) => send<{ axis: Vec3; angle: number }>({ method: 'raxisa', matrix }),
    readDsk: (name, bytes) => send<DskShape>({ method: 'readDsk', name, bytes }),
    recgeo: (rectan, re, f) => send<GeodeticPoint>({ method: 'recgeo', rectan, re, f }),
    et2lst: (et, body, lon, lstType) =>
      send<LocalSolarTime>({ method: 'et2lst', et, body, lon, lstType }),
    tkvrsn: () => send<string>({ method: 'tkvrsn' }),
    evalSeries: (spec: EvalSpec, signal?: AbortSignal): Promise<EvalSeriesResult> => {
      const id = nextId++;
      const promise = new Promise<EvalSeriesResult>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        worker.postMessage({ method: 'evalSeries', spec, id } as SpiceWorkerRequest);
      });
      if (signal) {
        const cancel = (): void =>
          worker.postMessage({ method: 'cancelJob', jobId: id, id: nextId++ } as SpiceWorkerRequest);
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      }
      return promise;
    },
  };
}
