// Reusable SPICE worker plumbing, independent of how the worker scope is created.
// worker.ts wires it to a plain module worker; bundler-specific shells (the Vite
// web app) wire it with a locateFile that points at the emitted cspice.wasm asset.

import { createSpiceEngine, type SpiceEngineOptions } from './engine.ts';
import { SpiceError, type SpiceEngine } from './index.ts';
import type { SpiceWorkerRequest, SpiceWorkerResponse } from './protocol.ts';
import { runEvalSpec } from './eval-series.ts';

export interface SpiceWorkerScope {
  onmessage: ((ev: MessageEvent<SpiceWorkerRequest>) => void) | null;
  postMessage(message: SpiceWorkerResponse, transfer?: Transferable[]): void;
}

/**
 * Buffers to transfer zero-copy: collect every typed-array buffer reachable in the
 * result (a bare typed array, or an EvalSeriesResult's et + columns), so batched and
 * series results are handed off rather than copied.
 */
function transferList(result: unknown, depth = 0): Transferable[] {
  if (ArrayBuffer.isView(result)) return [(result as ArrayBufferView).buffer];
  if (depth > 2 || result === null || typeof result !== 'object') return [];
  if (Array.isArray(result)) return result.flatMap((v) => transferList(v, depth + 1));
  return Object.values(result as Record<string, unknown>).flatMap((v) => transferList(v, depth + 1));
}

/** A macrotask yield so the worker can deliver a queued cancelJob between batches. */
const macrotaskYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function dispatchSpice(engine: SpiceEngine, req: SpiceWorkerRequest): Promise<unknown> {
  switch (req.method) {
    case 'furnsh':
      return engine.furnsh(req.name, req.bytes);
    case 'unload':
      return engine.unload(req.name);
    case 'kclear':
      return engine.kclear();
    case 'ktotal':
      return engine.ktotal(req.kind);
    case 'str2et':
      return engine.str2et(req.utc);
    case 'et2utc':
      return engine.et2utc(req.et, req.format, req.precision);
    case 'et2tdb':
      return engine.et2tdb(req.et, req.precision);
    case 'utc2et':
      return engine.utc2et(req.utc);
    case 'spkpos':
      return engine.spkpos(req.target, req.et, req.frame, req.abcorr, req.observer);
    case 'spkposBatch':
      return engine.spkposBatch(req.target, req.etArray, req.frame, req.abcorr, req.observer);
    case 'spkezrBatch':
      return engine.spkezrBatch(req.target, req.etArray, req.frame, req.abcorr, req.observer);
    case 'spkezr':
      return engine.spkezr(req.target, req.et, req.frame, req.abcorr, req.observer);
    case 'oscelt':
      return engine.oscelt(req.state, req.et, req.mu);
    case 'conics':
      return engine.conics(req.elements, req.et);
    case 'prop2b':
      return engine.prop2b(req.mu, req.state, req.dt);
    case 'gfoclt':
      return engine.gfoclt(
        req.occtyp,
        req.front,
        req.fshape,
        req.fframe,
        req.back,
        req.bshape,
        req.bframe,
        req.abcorr,
        req.observer,
        req.step,
        req.start,
        req.stop,
      );
    case 'gfdist':
      return engine.gfdist(
        req.target,
        req.abcorr,
        req.observer,
        req.relate,
        req.refval,
        req.step,
        req.start,
        req.stop,
      );
    case 'gfsep':
      return engine.gfsep(
        req.targ1,
        req.shape1,
        req.frame1,
        req.targ2,
        req.shape2,
        req.frame2,
        req.abcorr,
        req.observer,
        req.relate,
        req.refval,
        req.adjust,
        req.step,
        req.start,
        req.stop,
      );
    case 'gfposc':
      return engine.gfposc(
        req.target,
        req.frame,
        req.abcorr,
        req.observer,
        req.crdsys,
        req.coord,
        req.relate,
        req.refval,
        req.adjust,
        req.step,
        req.start,
        req.stop,
      );
    case 'occult':
      return engine.occult(
        req.targ1,
        req.shape1,
        req.frame1,
        req.targ2,
        req.shape2,
        req.frame2,
        req.abcorr,
        req.observer,
        req.et,
      );
    case 'getfov':
      return engine.getfov(req.instId, req.room);
    case 'bodvrd':
      return engine.bodvrd(req.body, req.item);
    case 'bodvcd':
      return engine.bodvcd(req.bodyId, req.item);
    case 'pxform':
      return engine.pxform(req.from, req.to, req.et);
    case 'sxform':
      return engine.sxform(req.from, req.to, req.et);
    case 'sincpt':
      return engine.sincpt(
        req.surfaceMethod,
        req.target,
        req.et,
        req.fixref,
        req.abcorr,
        req.observer,
        req.dref,
        req.dvec,
      );
    case 'subpnt':
      return engine.subpnt(
        req.surfaceMethod,
        req.target,
        req.et,
        req.fixref,
        req.abcorr,
        req.observer,
      );
    case 'ilumin':
      return engine.ilumin(
        req.surfaceMethod,
        req.target,
        req.et,
        req.fixref,
        req.abcorr,
        req.observer,
        req.point,
      );
    case 'writeSpkType13':
      return engine.writeSpkType13(
        req.name,
        req.body,
        req.center,
        req.frame,
        req.segid,
        req.degree,
        req.et,
        req.states,
      );
    case 'sce2c':
      return engine.sce2c(req.sc, req.et);
    case 'sct2e':
      return engine.sct2e(req.sc, req.sclkdp);
    case 'ckgp':
      return engine.ckgp(req.inst, req.sclkdp, req.tol, req.ref);
    case 'writeCk03':
      return engine.writeCk03(
        req.name,
        req.inst,
        req.ref,
        req.segid,
        req.sclkdp,
        req.quats,
        req.avvs,
        req.starts,
      );
    case 'twovec':
      return engine.twovec(req.axdef, req.indexa, req.plndef, req.indexp);
    case 'm2q':
      return engine.m2q(req.matrix);
    case 'q2m':
      return engine.q2m(req.quat);
    case 'raxisa':
      return engine.raxisa(req.matrix);
    case 'readDsk':
      return engine.readDsk(req.name, req.bytes);
    case 'recgeo':
      return engine.recgeo(req.rectan, req.re, req.f);
    case 'et2lst':
      return engine.et2lst(req.et, req.body, req.lon, req.lstType);
    case 'tkvrsn':
      return engine.tkvrsn();
    default:
      // A request variant with no dispatch arm must reject, never resolve undefined
      // (which the client would silently surface as a missing result). evalSeries and
      // cancelJob are handled in installSpiceWorker before reaching here, so any method
      // landing in this default is genuinely unhandled. Fail loudly (CLAUDE.md).
      throw new SpiceError(`dispatchSpice: unhandled worker method "${req.method}"`);
  }
}

export function installSpiceWorker(scope: SpiceWorkerScope, options?: SpiceEngineOptions): void {
  let enginePromise: Promise<SpiceEngine> | null = null;
  const engine = (): Promise<SpiceEngine> => (enginePromise ??= createSpiceEngine(options));

  // Cancellation tokens for in-flight evalSeries jobs, keyed by the request id.
  const jobs = new Map<number, { cancelled: boolean }>();

  const ok = (id: number, result: unknown): void =>
    scope.postMessage({ id, ok: true, result }, transferList(result));
  const fail = (id: number, err: unknown): void => {
    const error = err instanceof Error ? err.message : String(err);
    const shortMessage =
      err && typeof err === 'object' && 'shortMessage' in err
        ? String((err as { shortMessage?: unknown }).shortMessage)
        : undefined;
    scope.postMessage({ id, ok: false, error, shortMessage });
  };

  scope.onmessage = (ev) => {
    const req = ev.data;
    // Job control: cancel runs synchronously so a long evalSeries can observe it at
    // its next yield. It does not need the engine.
    if (req.method === 'cancelJob') {
      const token = jobs.get(req.jobId);
      if (token) token.cancelled = true;
      ok(req.id, undefined);
      return;
    }
    if (req.method === 'evalSeries') {
      const token = { cancelled: false };
      jobs.set(req.id, token);
      engine()
        .then((e) =>
          runEvalSpec(e, req.spec, {
            yieldNow: macrotaskYield,
            isCancelled: () => token.cancelled,
          }),
        )
        .then(
          (result) => {
            jobs.delete(req.id);
            ok(req.id, result);
          },
          (err: unknown) => {
            jobs.delete(req.id);
            fail(req.id, err);
          },
        );
      return;
    }
    engine()
      .then((e) => dispatchSpice(e, req))
      .then(
        (result) => ok(req.id, result),
        (err: unknown) => fail(req.id, err),
      );
  };
}

export { JobCancelledError } from './eval-series.ts';
