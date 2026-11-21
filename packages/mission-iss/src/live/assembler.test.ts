import { describe, it, expect } from 'vitest';
import { CoherentAssembler, type ItemUpdate } from './assembler.js';

const NOW = 1_800_000_000_000;
const make = (opts = {}) => new CoherentAssembler(['q0', 'q1', 'q2', 'q3'], { now: () => NOW, ...opts });
const u = (item: string, value: number, dt: number): ItemUpdate => ({ item, value, sourceTimeMs: NOW + dt });

describe('CoherentAssembler', () => {
  it('emits only when every component shares a source time', () => {
    const a = make();
    expect(a.accept(u('q0', 1, -1000)).kind).toBe('pending');
    expect(a.accept(u('q1', 0, -1000)).kind).toBe('pending');
    expect(a.accept(u('q2', 0, -1000)).kind).toBe('pending');
    const r = a.accept(u('q3', 0, -1000));
    expect(r).toEqual({ kind: 'sample', sample: { sourceTimeMs: NOW - 1000, values: { q0: 1, q1: 0, q2: 0, q3: 0 } } });
  });

  it('never mixes components from different frames: a half-updated frame stays pending', () => {
    const a = make();
    for (const [i, name] of ['q0', 'q1', 'q2', 'q3'].entries()) a.accept(u(name, i, -2000));
    // Next frame arrives component by component: the old components are not reused.
    expect(a.accept(u('q0', 10, -1000)).kind).toBe('pending');
    expect(a.accept(u('q1', 11, -1000)).kind).toBe('pending');
    expect(a.accept(u('q2', 12, -1000)).kind).toBe('pending');
    const r = a.accept(u('q3', 13, -1000));
    expect(r.kind === 'sample' && r.sample.values).toEqual({ q0: 10, q1: 11, q2: 12, q3: 13 });
    expect(a.emitted).toBe(2);
  });

  it('tolerance lets one frame with slightly skewed component times through, and uses the newest time', () => {
    const a = make({ toleranceMs: 50 });
    a.accept(u('q0', 1, -1000)); a.accept(u('q1', 0, -990)); a.accept(u('q2', 0, -1000));
    const r = a.accept(u('q3', 0, -970));
    expect(r.kind === 'sample' && r.sample.sourceTimeMs).toBe(NOW - 970);
    const tooWide = make({ toleranceMs: 10 });
    tooWide.accept(u('q0', 1, -1000)); tooWide.accept(u('q1', 0, -1000)); tooWide.accept(u('q2', 0, -1000));
    expect(tooWide.accept(u('q3', 0, -900)).kind).toBe('pending');
  });

  it('rejects stale, future, out-of-order, non-finite, bad-time and unknown values and counts them', () => {
    const a = make();
    expect(a.accept(u('q0', 1, -60_000))).toEqual({ kind: 'rejected', reason: 'stale' });
    expect(a.accept(u('q0', 1, 120_000))).toEqual({ kind: 'rejected', reason: 'future' });
    expect(a.accept(u('q0', NaN, -1000))).toEqual({ kind: 'rejected', reason: 'non-finite-value' });
    expect(a.accept({ item: 'q0', value: 1, sourceTimeMs: NaN })).toEqual({ kind: 'rejected', reason: 'bad-timestamp' });
    expect(a.accept(u('nope', 1, -1000))).toEqual({ kind: 'rejected', reason: 'unknown-item' });
    a.accept(u('q0', 1, -1000));
    expect(a.accept(u('q0', 2, -2000))).toEqual({ kind: 'rejected', reason: 'out-of-order' });
    expect(a.rejected).toMatchObject({ stale: 1, future: 1, 'non-finite-value': 1, 'bad-timestamp': 1, 'unknown-item': 1, 'out-of-order': 1 });
  });

  it('does not re-emit a repeated frame (same timestamps again) and refuses older frames once newer ones were emitted', () => {
    const a = make();
    const frame = (dt: number) => ['q0', 'q1', 'q2', 'q3'].map((n, i) => a.accept(u(n, i, dt)));
    expect(frame(-1000).at(-1)?.kind).toBe('sample');
    expect(frame(-1000).at(-1)?.kind).toBe('pending'); // identical replay
    expect(frame(-3000).map((r) => r.kind)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    expect(a.emitted).toBe(1);
  });

  it('reset drops partial components but keeps the emission watermark', () => {
    const a = make();
    for (const [i, n] of ['q0', 'q1', 'q2', 'q3'].entries()) a.accept(u(n, i, -1000));
    a.accept(u('q0', 9, -500));
    a.reset();
    // q0@-500 is forgotten: completing the other three at -500 does not emit q0 from before the reset.
    a.accept(u('q1', 9, -500)); a.accept(u('q2', 9, -500));
    expect(a.accept(u('q3', 9, -500)).kind).toBe('pending');
    expect(a.lastSourceTimeMs).toBe(NOW - 1000);
  });

  it('is a distinct-set, non-empty configuration', () => {
    expect(() => new CoherentAssembler([])).toThrow();
    expect(() => new CoherentAssembler(['a', 'a'])).toThrow();
  });
});
