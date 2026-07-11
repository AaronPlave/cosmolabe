// In-process SPICE engine: loads CSPICE-WASM directly (no worker) and implements
// the SpiceEngine surface. Used by unit tests and by the worker entry point. The
// browser uses createSpiceWorkerClient (client.ts) to keep furnsh and geometry
// off the main thread; both paths share these bindings.

import CSpice from 'cspice-wasm/wasm/cspice.mjs';
import { SpiceBindings } from './bindings.ts';
import type { AberrationCorrection, SpiceEngine } from './index.ts';

export interface SpiceEngineOptions {
  /** Resolve the cspice.wasm URL. Bundlers (Vite) pass the emitted asset URL. */
  locateFile?: (path: string) => string;
}

/**
 * Load the CSPICE WASM module and return the synchronous typed bindings. The
 * in-process path for callers that need the full surface without the promise
 * wrapper, notably the frames tier (ADR M-0002) and conformance rigs.
 */
export async function createSpiceBindings(options?: SpiceEngineOptions): Promise<SpiceBindings> {
  const mod = await CSpice(options?.locateFile ? { locateFile: options.locateFile } : undefined);
  return new SpiceBindings(mod);
}

export async function createSpiceEngine(options?: SpiceEngineOptions): Promise<SpiceEngine> {
  return spiceEngineOver(await createSpiceBindings(options));
}

/**
 * Bind the promise-surface engine over an existing bindings instance, sharing
 * its kernel pool. The compute plane (M-0004) uses this so an engine and a
 * frames layer operate on one SPICE state and a product's kernel set hash
 * describes exactly the pool the engine computed with.
 */
export function spiceEngineOver(bindings: SpiceBindings): SpiceEngine {
  return {
    async furnsh(name, bytes) {
      bindings.furnsh(name, bytes);
    },
    async unload(name) {
      bindings.unload(name);
    },
    async kclear() {
      bindings.kclear();
    },
    async ktotal(kind) {
      return bindings.ktotal(kind);
    },
    async str2et(utc) {
      return bindings.str2et(utc);
    },
    async et2utc(et, format, precision) {
      return bindings.et2utc(et, format, precision);
    },
    async et2tdb(et, precision) {
      return bindings.et2tdb(et, precision);
    },
    async utc2et(utc) {
      return bindings.utc2et(utc);
    },
    async spkpos(target, et, frame, abcorr: AberrationCorrection, observer) {
      return bindings.spkpos(target, et, frame, abcorr, observer);
    },
    async spkezr(target, et, frame, abcorr: AberrationCorrection, observer) {
      return bindings.spkezr(target, et, frame, abcorr, observer);
    },
    async oscelt(state, et, mu) {
      return bindings.oscelt(state, et, mu);
    },
    async conics(elements, et) {
      return bindings.conics(elements, et);
    },
    async prop2b(mu, state, dt) {
      return bindings.prop2b(mu, state, dt);
    },
    async gfoclt(occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, start, stop) {
      return bindings.gfoclt(occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, start, stop);
    },
    async gfdist(target, abcorr, observer, relate, refval, step, start, stop) {
      return bindings.gfdist(target, abcorr, observer, relate, refval, step, start, stop);
    },
    async gfsep(targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, relate, refval, adjust, step, start, stop) {
      return bindings.gfsep(targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, relate, refval, adjust, step, start, stop);
    },
    async gfposc(target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, start, stop) {
      return bindings.gfposc(target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, start, stop);
    },
    async occult(targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, et) {
      return bindings.occult(targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, et);
    },
    async spkposBatch(target, etArray, frame, abcorr: AberrationCorrection, observer) {
      return bindings.spkposBatch(target, etArray, frame, abcorr, observer);
    },
    async spkezrBatch(target, etArray, frame, abcorr: AberrationCorrection, observer) {
      return bindings.spkezrBatch(target, etArray, frame, abcorr, observer);
    },
    async getfov(instId, room) {
      return bindings.getfov(instId, room);
    },
    async bodvrd(body, item) {
      return bindings.bodvrd(body, item);
    },
    async bodvcd(bodyId, item) {
      return bindings.bodvcd(bodyId, item);
    },
    async pxform(from, to, et) {
      return bindings.pxform(from, to, et);
    },
    async sxform(from, to, et) {
      return bindings.sxform(from, to, et);
    },
    async sincpt(method, target, et, fixref, abcorr: AberrationCorrection, observer, dref, dvec) {
      return bindings.sincpt(method, target, et, fixref, abcorr, observer, dref, dvec);
    },
    async subpnt(method, target, et, fixref, abcorr: AberrationCorrection, observer) {
      return bindings.subpnt(method, target, et, fixref, abcorr, observer);
    },
    async ilumin(method, target, et, fixref, abcorr: AberrationCorrection, observer, point) {
      return bindings.ilumin(method, target, et, fixref, abcorr, observer, point);
    },
    async writeSpkType13(name, body, center, frame, segid, degree, et, states) {
      return bindings.writeSpkType13(name, body, center, frame, segid, degree, et, states);
    },
    async sce2c(sc, et) {
      return bindings.sce2c(sc, et);
    },
    async sct2e(sc, sclkdp) {
      return bindings.sct2e(sc, sclkdp);
    },
    async ckgp(inst, sclkdp, tol, ref) {
      return bindings.ckgp(inst, sclkdp, tol, ref);
    },
    async writeCk03(name, inst, ref, segid, sclkdp, quats, avvs, starts) {
      return bindings.writeCk03(name, inst, ref, segid, sclkdp, quats, avvs, starts);
    },
    async twovec(axdef, indexa, plndef, indexp) {
      return bindings.twovec(axdef, indexa, plndef, indexp);
    },
    async m2q(matrix) {
      return bindings.m2q(matrix);
    },
    async q2m(quat) {
      return bindings.q2m(quat);
    },
    async raxisa(matrix) {
      return bindings.raxisa(matrix);
    },
    async readDsk(name, bytes) {
      return bindings.readDsk(name, bytes);
    },
    async recgeo(rectan, re, f) {
      return bindings.recgeo(rectan, re, f);
    },
    async et2lst(et, body, lon, type) {
      return bindings.et2lst(et, body, lon, type);
    },
    async tkvrsn() {
      return bindings.tkvrsn();
    },
  };
}
