// F3: a pool of SPICE workers. Kernel-state mutations (furnsh/unload/kclear, SPK
// writes, DSK reads) broadcast to every worker so they share an identical kernel
// pool; stateless reads round-robin across workers; and a heavy evalSeries sweep can
// be partitioned across all workers and reassembled. This is what lets coverage
// grids, conjunction screening, and porkchop sweeps use every core without blocking
// the UI. (STK_PARITY_SPEC F3.)

import { createSpiceWorkerClient } from './client.ts';
import { gridEpochs, type EvalSeriesResult, type EvalSpec } from './eval-series.ts';
import type { SpiceComputeEngine } from './index.ts';

export interface SpiceWorkerPool extends SpiceComputeEngine {
  /** Number of workers in the pool. */
  readonly size: number;
  /**
   * Evaluate an EvalSpec by partitioning its grid across all workers and
   * concatenating the results, for a near-linear speedup on large sweeps. Aborting
   * the signal cancels every partition.
   */
  evalSeriesParallel(spec: EvalSpec, signal?: AbortSignal): Promise<EvalSeriesResult>;
  /** Terminate every worker. */
  dispose(): void;
}

/** Reassemble partitioned series results (same providers, disjoint epochs) in order. */
function concatSeries(parts: EvalSeriesResult[]): EvalSeriesResult {
  const live = parts.filter((p) => p.et.length > 0);
  if (live.length === 0) return parts[0] ?? { et: new Float64Array(0), columns: [], names: [] };
  const names = live[0]!.names;
  const total = live.reduce((n, p) => n + p.et.length, 0);
  const et = new Float64Array(total);
  const columns = names.map(() => new Float64Array(total));
  let off = 0;
  for (const part of live) {
    et.set(part.et, off);
    for (let c = 0; c < columns.length; c++) columns[c]!.set(part.columns[c]!, off);
    off += part.et.length;
  }
  return { et, columns, names };
}

export function createSpiceWorkerPool(workers: Worker[]): SpiceWorkerPool {
  if (workers.length === 0) throw new Error('createSpiceWorkerPool needs at least one worker');
  const clients = workers.map(createSpiceWorkerClient);

  // Round-robin index for stateless reads and single-job evalSeries dispatch.
  let rr = 0;
  const next = (): SpiceComputeEngine => {
    const c = clients[rr % clients.length]!;
    rr += 1;
    return c;
  };
  const all = <T>(fn: (c: SpiceComputeEngine) => Promise<T>): Promise<T> =>
    Promise.all(clients.map(fn)).then((rs) => rs[0]!);

  return {
    size: clients.length,

    // State mutations: broadcast so every worker stays consistent.
    furnsh: (name, bytes) => all((c) => c.furnsh(name, bytes)),
    unload: (name) => all((c) => c.unload(name)),
    kclear: () => all((c) => c.kclear()),
    writeSpkType13: (name, body, center, frame, segid, degree, et, states) =>
      all((c) => c.writeSpkType13(name, body, center, frame, segid, degree, et, states)),
    writeCk03: (name, inst, ref, segid, sclkdp, quats, avvs, starts) =>
      all((c) => c.writeCk03(name, inst, ref, segid, sclkdp, quats, avvs, starts)),
    readDsk: (name, bytes) => all((c) => c.readDsk(name, bytes)),

    // Stateless reads: round-robin.
    ktotal: (kind) => next().ktotal(kind),
    str2et: (utc) => next().str2et(utc),
    et2utc: (et, format, precision) => next().et2utc(et, format, precision),
    et2tdb: (et, precision) => next().et2tdb(et, precision),
    utc2et: (utc) => next().utc2et(utc),
    spkpos: (target, et, frame, abcorr, observer) => next().spkpos(target, et, frame, abcorr, observer),
    spkezr: (target, et, frame, abcorr, observer) => next().spkezr(target, et, frame, abcorr, observer),
    oscelt: (state, et, mu) => next().oscelt(state, et, mu),
    conics: (elements, et) => next().conics(elements, et),
    prop2b: (mu, state, dt) => next().prop2b(mu, state, dt),
    gfoclt: (occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, start, stop) =>
      next().gfoclt(occtyp, front, fshape, fframe, back, bshape, bframe, abcorr, observer, step, start, stop),
    gfdist: (target, abcorr, observer, relate, refval, step, start, stop) =>
      next().gfdist(target, abcorr, observer, relate, refval, step, start, stop),
    gfsep: (targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, relate, refval, adjust, step, start, stop) =>
      next().gfsep(targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, relate, refval, adjust, step, start, stop),
    gfposc: (target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, start, stop) =>
      next().gfposc(target, frame, abcorr, observer, crdsys, coord, relate, refval, adjust, step, start, stop),
    occult: (targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, et) =>
      next().occult(targ1, shape1, frame1, targ2, shape2, frame2, abcorr, observer, et),
    spkposBatch: (target, etArray, frame, abcorr, observer) =>
      next().spkposBatch(target, etArray, frame, abcorr, observer),
    spkezrBatch: (target, etArray, frame, abcorr, observer) =>
      next().spkezrBatch(target, etArray, frame, abcorr, observer),
    getfov: (instId, room) => next().getfov(instId, room),
    bodvrd: (body, item) => next().bodvrd(body, item),
    bodvcd: (bodyId, item) => next().bodvcd(bodyId, item),
    pxform: (from, to, et) => next().pxform(from, to, et),
    sxform: (from, to, et) => next().sxform(from, to, et),
    sce2c: (sc, et) => next().sce2c(sc, et),
    sct2e: (sc, sclkdp) => next().sct2e(sc, sclkdp),
    ckgp: (inst, sclkdp, tol, ref) => next().ckgp(inst, sclkdp, tol, ref),
    sincpt: (method, target, et, fixref, abcorr, observer, dref, dvec) =>
      next().sincpt(method, target, et, fixref, abcorr, observer, dref, dvec),
    subpnt: (method, target, et, fixref, abcorr, observer) =>
      next().subpnt(method, target, et, fixref, abcorr, observer),
    ilumin: (method, target, et, fixref, abcorr, observer, point) =>
      next().ilumin(method, target, et, fixref, abcorr, observer, point),
    twovec: (axdef, indexa, plndef, indexp) => next().twovec(axdef, indexa, plndef, indexp),
    m2q: (matrix) => next().m2q(matrix),
    q2m: (quat) => next().q2m(quat),
    raxisa: (matrix) => next().raxisa(matrix),
    recgeo: (rectan, re, f) => next().recgeo(rectan, re, f),
    et2lst: (et, body, lon, type) => next().et2lst(et, body, lon, type),
    tkvrsn: () => next().tkvrsn(),

    evalSeries: (spec, signal) => next().evalSeries(spec, signal),

    evalSeriesParallel: (spec, signal) => {
      const et = gridEpochs(spec.grid);
      const n = et.length;
      const k = Math.min(clients.length, Math.max(1, n));
      if (k <= 1) return clients[0]!.evalSeries(spec, signal);
      // One AbortController fans the caller's cancellation out to every partition.
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const chunk = Math.ceil(n / k);
      const parts: Promise<EvalSeriesResult>[] = [];
      for (let i = 0; i < k; i++) {
        const slice = et.slice(i * chunk, Math.min(n, (i + 1) * chunk));
        if (slice.length === 0) continue;
        const subSpec: EvalSpec = { grid: { et: slice }, providers: spec.providers };
        parts.push(clients[i]!.evalSeries(subSpec, controller.signal));
      }
      return Promise.all(parts)
        .then(concatSeries)
        .finally(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
        });
    },

    dispose: () => {
      for (const w of workers) w.terminate();
    },
  };
}
