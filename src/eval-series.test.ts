// F3: the EvalSpec interpreter walks a grid once and returns columns equal to the
// per-epoch SPICE calls; it cancels via the token; the worker runs it as a job that a
// cancelJob message aborts; and the worker pool partitions a sweep across workers and
// reassembles the identical result. (STK_PARITY_SPEC F3.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createSpiceEngine,
  createSpiceWorkerPool,
  dispatchSpice,
  gridEpochs,
  installSpiceWorker,
  runEvalSpec,
  JobCancelledError,
  type EvalSpec,
  type SpiceEngine,
  type SpiceWorkerScope,
} from './index.ts';
import type { SpiceWorkerRequest, SpiceWorkerResponse } from './protocol.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));
const KERNELS = ['naif0012.tls', 'de440s-inner-cassini.bsp'] as const;

// A fake Worker backed by an in-process engine, so the client/pool can be exercised
// without a real Web Worker. Messages cross asynchronously, like a real worker.
function makeFakeWorker(): Worker {
  const listeners = new Set<(ev: MessageEvent<SpiceWorkerResponse>) => void>();
  const scope: SpiceWorkerScope = {
    onmessage: null,
    postMessage: (res) => {
      setTimeout(() => {
        const ev = { data: res } as MessageEvent<SpiceWorkerResponse>;
        for (const l of listeners) l(ev);
      }, 0);
    },
  };
  installSpiceWorker(scope);
  return {
    postMessage: (msg: unknown) =>
      setTimeout(() => scope.onmessage?.({ data: msg as SpiceWorkerRequest } as MessageEvent<SpiceWorkerRequest>), 0),
    addEventListener: (_t: 'message', h: (ev: MessageEvent<SpiceWorkerResponse>) => void) => listeners.add(h),
    removeEventListener: (_t: 'message', h: (ev: MessageEvent<SpiceWorkerResponse>) => void) => listeners.delete(h),
    terminate: () => listeners.clear(),
  } as unknown as Worker;
}

describe('cspice-wasm EvalSpec interpreter (F3)', () => {
  let spice: SpiceEngine;
  let et0: number;

  beforeAll(async () => {
    spice = await createSpiceEngine();
    for (const k of KERNELS) await spice.furnsh(k, fixture(k));
    et0 = await spice.str2et('2004-07-01T00:00:00');
  });

  it('builds uniform and explicit grids', () => {
    expect(Array.from(gridEpochs({ start: 0, stop: 10, step: 5 }))).toEqual([0, 5, 10]);
    expect(gridEpochs({ et: [1, 2, 3] })).toEqual(Float64Array.from([1, 2, 3]));
  });

  it('fails loudly on a runaway grid size instead of over-allocating', () => {
    expect(() => gridEpochs({ start: 0, stop: 1e12, step: 1 })).toThrow(/too large/);
  });

  it('matches per-epoch spkpos/spkezr for range and position columns', async () => {
    const spec: EvalSpec = {
      grid: { start: et0, stop: et0 + 600 * 9, step: 600 },
      providers: [
        { kind: 'range', observer: '10', target: '6' },
        { kind: 'position', observer: '10', target: '6', frame: 'J2000' },
      ],
    };
    const out = await runEvalSpec(spice, spec);
    expect(out.names).toEqual(['range', 'pos.x', 'pos.y', 'pos.z']);
    expect(out.et).toHaveLength(10);
    for (let i = 0; i < out.et.length; i++) {
      const r = await spice.spkpos('6', out.et[i]!, 'J2000', 'NONE', '10');
      expect(out.columns[0]![i]).toBeCloseTo(Math.hypot(r.position.x, r.position.y, r.position.z), 6);
      expect(out.columns[1]![i]).toBeCloseTo(r.position.x, 6);
      expect(out.columns[2]![i]).toBeCloseTo(r.position.y, 6);
      expect(out.columns[3]![i]).toBeCloseTo(r.position.z, 6);
    }
  });

  it('throws a located SpiceError for rangeRate of a coincident pair (|r|=0)', async () => {
    // Observer == target gives a zero relative position, so d|r|/dt is undefined: the
    // provider must throw rather than divide by a faked 1.0 and emit a km^2/s dot product.
    const spec: EvalSpec = {
      grid: { et: [et0] },
      providers: [{ kind: 'rangeRate', observer: '10', target: '10' }],
    };
    await expect(runEvalSpec(spice, spec)).rejects.toThrow(/rangeRate undefined/);
  });

  it('throws a located SpiceError for subPointLonLat of a coincident pair (|r|=0)', async () => {
    const spec: EvalSpec = {
      grid: { et: [et0] },
      providers: [{ kind: 'subPointLonLat', observer: '10', target: '10', frame: 'J2000' }],
    };
    await expect(runEvalSpec(spice, spec)).rejects.toThrow(/subPointLonLat undefined/);
  });

  it('throws JobCancelledError when the token trips', async () => {
    const spec: EvalSpec = {
      grid: { start: et0, stop: et0 + 600 * 99, step: 600 },
      providers: [{ kind: 'range', observer: '10', target: '6' }],
    };
    await expect(runEvalSpec(spice, spec, { isCancelled: () => true })).rejects.toBeInstanceOf(JobCancelledError);
  });
});

describe('cspice-wasm evalSeries worker job (F3)', () => {
  it('runs a series job and a cancelJob aborts it', async () => {
    const responses = new Map<number, { res: SpiceWorkerResponse }>();
    const scope: SpiceWorkerScope = {
      onmessage: null,
      postMessage: (res) => responses.set(res.id, { res }),
    };
    installSpiceWorker(scope);
    const send = (req: SpiceWorkerRequest) => scope.onmessage!({ data: req } as MessageEvent<SpiceWorkerRequest>);
    const waitFor = async (id: number) => {
      for (let i = 0; i < 400 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 20));
      return responses.get(id)!;
    };

    send({ id: 1, method: 'furnsh', name: KERNELS[0], bytes: fixture(KERNELS[0]) });
    send({ id: 2, method: 'furnsh', name: KERNELS[1], bytes: fixture(KERNELS[1]) });
    await waitFor(2);

    const spec: EvalSpec = {
      grid: { start: 1.4e8, stop: 1.4e8 + 600 * 9, step: 600 },
      providers: [{ kind: 'range', observer: '10', target: '6' }],
    };
    send({ id: 10, method: 'evalSeries', spec });
    const done = await waitFor(10);
    expect(done.res.ok).toBe(true);
    if (done.res.ok) {
      const result = done.res.result as { et: Float64Array; columns: Float64Array[] };
      expect(result.et).toHaveLength(10);
      expect(result.columns[0]!.every((v) => v > 0)).toBe(true);
    }

    // A big job, cancelled synchronously before its first yield, rejects.
    const big: EvalSpec = {
      grid: { start: 1.4e8, stop: 1.4e8 + 1 * 999, step: 1 },
      providers: [{ kind: 'range', observer: '10', target: '6' }],
    };
    send({ id: 20, method: 'evalSeries', spec: big });
    send({ id: 21, method: 'cancelJob', jobId: 20 });
    const cancelled = await waitFor(20);
    expect(cancelled.res.ok).toBe(false);
    if (!cancelled.res.ok) expect(cancelled.res.error).toContain('cancelled');
  });

  it('rejects an unknown worker method instead of resolving undefined', async () => {
    // A future request variant without a dispatch arm must reject, not silently resolve
    // {ok:true,result:undefined}. The engine is never touched, so a bare stub suffices.
    const stub = {} as SpiceEngine;
    const unknown = { id: 99, method: 'doesNotExist' } as unknown as SpiceWorkerRequest;
    await expect(dispatchSpice(stub, unknown)).rejects.toThrow(/unhandled worker method/);
  });
});

describe('cspice-wasm worker pool (F3)', () => {
  it('broadcasts kernels and partitions an evalSeries across workers', async () => {
    const pool = createSpiceWorkerPool([makeFakeWorker(), makeFakeWorker()]);
    expect(pool.size).toBe(2);
    for (const k of KERNELS) await pool.furnsh(k, fixture(k));
    const et0 = await pool.str2et('2004-07-01T00:00:00');

    const spec: EvalSpec = {
      grid: { start: et0, stop: et0 + 600 * 19, step: 600 },
      providers: [{ kind: 'range', observer: '10', target: '6' }],
    };
    const single = await pool.evalSeries(spec);
    const parallel = await pool.evalSeriesParallel(spec);
    expect(parallel.et).toHaveLength(20);
    // The partitioned result equals the single-worker result, epoch for epoch.
    expect(Array.from(parallel.et)).toEqual(Array.from(single.et));
    for (let i = 0; i < single.et.length; i++) {
      expect(parallel.columns[0]![i]).toBeCloseTo(single.columns[0]![i]!, 9);
    }
    pool.dispose();
  });
});
