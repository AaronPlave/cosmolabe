/**
 * The memory readout's own logic, which is all in the shaping.
 *
 * `performance.measureUserAgentSpecificMemory()` hands back a flat list of
 * breakdown entries, several per realm, attributed by URL and scope. Turning
 * that into "what does each thread hold" is the part that can be wrong, and the
 * part a real session would make expensive to check: the probe is a dev aid, so
 * a wrong answer from it costs an investigation pointed at the wrong thread.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { measureMemory, isUnavailable, type MemorySnapshot } from './memory-probe';

type Entry = { bytes: number; attribution: { url?: string; scope?: string }[]; types: string[] };

const install = (result: { bytes: number; breakdown: Entry[] } | Error): void => {
  (performance as unknown as { measureUserAgentSpecificMemory: unknown })
    .measureUserAgentSpecificMemory = vi.fn(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    );
};

const page = (bytes: number, types = ['JavaScript']): Entry => ({
  bytes,
  attribution: [{ url: 'https://host/viewer/', scope: 'Window' }],
  types,
});

const worker = (file: string, bytes: number, types = ['JavaScript']): Entry => ({
  bytes,
  attribution: [{ url: `https://host/assets/${file}`, scope: 'DedicatedWorkerGlobalScope' }],
  types,
});

/** Narrows away the unavailable case so a test can read the snapshot. */
const snapshot = async (): Promise<MemorySnapshot> => {
  const result = await measureMemory();
  if (isUnavailable(result)) throw new Error(`expected a snapshot: ${result.unavailable}`);
  return result;
};

describe('measureMemory', () => {
  const original = (performance as unknown as { measureUserAgentSpecificMemory?: unknown })
    .measureUserAgentSpecificMemory;

  beforeEach(() => { install({ bytes: 0, breakdown: [] }); });
  afterEach(() => {
    (performance as unknown as { measureUserAgentSpecificMemory?: unknown })
      .measureUserAgentSpecificMemory = original;
  });

  it('separates the page from each worker', async () => {
    // The whole reason for using this API rather than a process total: the
    // viewer runs SPICE on two workers plus the main thread, and "which realm"
    // is the first question worth answering.
    install({
      bytes: 300,
      breakdown: [
        page(100),
        worker('spice-cache.worker-abc.js', 150),
        worker('geometry.worker-def.js', 50),
      ],
    });

    const { realms } = await snapshot();
    expect(realms.map((r) => r.label)).toEqual([
      'worker: spice-cache.worker-abc.js',
      'page: /viewer/',
      'worker: geometry.worker-def.js',
    ]);
    // Largest first: a readout scanned by eye should lead with the suspect.
    expect(realms.map((r) => r.bytes)).toEqual([150, 100, 50]);
  });

  it('sums the several entries one realm reports', async () => {
    // The browser splits a realm by type. Left unsummed, one thread appears as
    // several smaller ones and no single row shows what it actually holds.
    install({
      bytes: 300,
      breakdown: [page(100, ['JavaScript']), page(180, ['DOM']), page(20, ['Shared'])],
    });

    const { realms } = await snapshot();
    expect(realms).toHaveLength(1);
    expect(realms[0]!.bytes).toBe(300);
    expect([...realms[0]!.types].sort()).toEqual(['DOM', 'JavaScript', 'Shared']);
  });

  it('keeps the total the browser reported, not its own sum', async () => {
    // Zero-byte entries are dropped from the rows as noise, and entries can in
    // principle be attributed in ways the grouping does not model. The total
    // must stay the browser's, or the rows and the headline disagree.
    install({ bytes: 512, breakdown: [page(100), worker('w.js', 0)] });

    const result = await snapshot();
    expect(result.total).toBe(512);
    expect(result.realms).toHaveLength(1);
  });

  it('keeps unattributed memory visible', async () => {
    // Memory the browser cannot assign to a realm is still memory. Dropping it
    // would make the rows quietly fail to add up to the total.
    install({ bytes: 60, breakdown: [{ bytes: 60, attribution: [], types: ['Shared'] }] });

    const { realms } = await snapshot();
    expect(realms[0]!.label).toContain('unattributed');
    expect(realms[0]!.bytes).toBe(60);
  });

  it('explains itself when the API is missing', async () => {
    delete (performance as unknown as { measureUserAgentSpecificMemory?: unknown })
      .measureUserAgentSpecificMemory;

    const result = await measureMemory();
    expect(isUnavailable(result)).toBe(true);
    // The likeliest cause by far, and not guessable: the API is hidden unless
    // the page is cross-origin isolated, which the production build is not.
    expect((result as { unavailable: string }).unavailable).toMatch(/cross-origin isolated/i);
  });

  it('reports a failed measurement rather than throwing', async () => {
    // A dev aid that throws into whatever called it is worse than no dev aid.
    install(new Error('measurement already in progress'));

    const result = await measureMemory();
    expect(isUnavailable(result)).toBe(true);
    expect((result as { unavailable: string }).unavailable).toContain('measurement already in progress');
  });
});
