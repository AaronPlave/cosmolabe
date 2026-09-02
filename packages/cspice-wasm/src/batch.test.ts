// F3: the batched spkposBatch returns the same positions as per-epoch spkpos in a
// single call, and the worker hands the result Float64Array back zero-copy (its
// buffer is in the postMessage transfer list). (STK_PARITY_SPEC F3.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, type SpiceEngine } from './index.ts';
import { installSpiceWorker, type SpiceWorkerScope } from './worker-core.ts';
import type { SpiceWorkerRequest, SpiceWorkerResponse } from './protocol.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

describe('cspice-wasm spkposBatch (F3 batching)', () => {
  let spice: SpiceEngine;
  let et0: number;

  beforeAll(async () => {
    spice = await createSpiceEngine();
    for (const k of ['naif0012.tls', 'de440s-inner-cassini.bsp']) await spice.furnsh(k, fixture(k));
    et0 = await spice.str2et('2004-07-01T00:00:00');
  });

  it('matches per-epoch spkpos for every sample', async () => {
    const grid = Float64Array.from({ length: 20 }, (_, k) => et0 + k * 600);
    const batch = await spice.spkposBatch('6', grid, 'J2000', 'NONE', '10');
    expect(batch).toHaveLength(grid.length * 3);
    for (let k = 0; k < grid.length; k++) {
      const single = await spice.spkpos('6', grid[k]!, 'J2000', 'NONE', '10');
      expect(batch[k * 3]).toBeCloseTo(single.position.x, 6);
      expect(batch[k * 3 + 1]).toBeCloseTo(single.position.y, 6);
      expect(batch[k * 3 + 2]).toBeCloseTo(single.position.z, 6);
    }
  });

  it('transfers the result buffer zero-copy from the worker', async () => {
    // Drive installSpiceWorker with a fake scope that captures responses by id.
    const responses = new Map<number, { res: SpiceWorkerResponse; transfer?: Transferable[] }>();
    const scope: SpiceWorkerScope = {
      onmessage: null,
      postMessage: (res, transfer) => responses.set(res.id, { res, transfer }),
    };
    installSpiceWorker(scope);
    const send = (req: SpiceWorkerRequest) => scope.onmessage!({ data: req } as MessageEvent<SpiceWorkerRequest>);
    const waitFor = async (id: number) => {
      for (let i = 0; i < 200 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 20));
      return responses.get(id)!;
    };

    // The worker has its own engine; furnish kernels through the scope first.
    send({ id: 1, method: 'furnsh', name: 'naif0012.tls', bytes: fixture('naif0012.tls') });
    send({ id: 2, method: 'furnsh', name: 'de440s-inner-cassini.bsp', bytes: fixture('de440s-inner-cassini.bsp') });
    await waitFor(2);

    const grid = Float64Array.from({ length: 5 }, (_, k) => et0 + k * 600);
    send({ id: 3, method: 'spkposBatch', target: '6', etArray: grid, frame: 'J2000', abcorr: 'NONE', observer: '10' });
    const { res, transfer } = await waitFor(3);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const buffer = (res.result as Float64Array).buffer;
    expect(transfer).toEqual([buffer]); // zero-copy: the buffer is handed off
  });
});
