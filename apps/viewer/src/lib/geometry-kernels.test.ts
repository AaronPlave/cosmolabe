/**
 * Which kernels a search's worker is given.
 *
 * Both failure modes here are expensive and neither is loud. Keep too much and
 * the geometry worker holds a second copy of a mission-length catalog -- 300 MB
 * on Cassini, measured, for as long as it lives. Keep too little and a search
 * fails with SPICE's "insufficient ephemeris data" for a window the user was
 * offered, which reads as a broken viewer rather than as a narrowing bug.
 *
 * So the asymmetry is the thing to pin: dropping is only ever allowed for a
 * file that provably cannot contribute.
 */
import { describe, it, expect } from 'vitest';
import {
  KERNEL_WINDOW_PAD_SECONDS,
  coversWindow,
  kernelSetKey,
  kernelsForWindow,
  type KernelWindow,
} from './geometry-kernels';

/** A day, the unit the SCPSE files below are sliced in. */
const DAY = 86_400;

interface Kernel {
  name: string;
  coverage: KernelWindow[] | null;
}

const lsk: Kernel = { name: 'naif0012.tls', coverage: null };
const pck: Kernel = { name: 'pck00011.tpc', coverage: null };
/** Mission phases, abutting, as a real SCPSE set is sliced. */
const phase = (n: number): Kernel => ({
  name: `phase${n}.bsp`,
  coverage: [{ start: n * 100 * DAY, end: (n + 1) * 100 * DAY }],
});

const narrow = (kernels: Kernel[], window: KernelWindow, pad?: number): string[] =>
  kernelsForWindow(kernels, (k) => k.coverage, window, pad).map((k) => k.name);

describe('kernelsForWindow', () => {
  const set = [lsk, pck, phase(0), phase(1), phase(2), phase(3)];

  it('keeps only the phases the window touches', () => {
    // The whole point: a window inside one phase should not cost the others.
    const inPhase2 = { start: 230 * DAY, end: 240 * DAY };
    expect(narrow(set, inPhase2)).toEqual(['naif0012.tls', 'pck00011.tpc', 'phase2.bsp']);
  });

  it('keeps every phase a window spans', () => {
    const across = { start: 90 * DAY, end: 210 * DAY };
    expect(narrow(set, across)).toEqual([
      'naif0012.tls', 'pck00011.tpc', 'phase0.bsp', 'phase1.bsp', 'phase2.bsp',
    ]);
  });

  it('keeps kernels that have no coverage to test', () => {
    // A leapseconds or text PCK kernel has no window, is needed by every
    // search, and is measured in kilobytes. Dropping one would fail every
    // search in the worker while saving nothing.
    expect(narrow([lsk, pck], { start: 0, end: DAY })).toEqual(['naif0012.tls', 'pck00011.tpc']);
  });

  it('keeps an SPK whose coverage could not be read', () => {
    // "I could not tell" must not read as "not needed". This is the case that
    // decides whether a narrowing bug degrades into a slightly larger worker or
    // into a search that cannot run.
    const unreadable: Kernel = { name: 'mystery.bsp', coverage: null };
    expect(narrow([unreadable], { start: 0, end: DAY })).toEqual(['mystery.bsp']);
    expect(narrow([{ name: 'empty.bsp', coverage: [] }], { start: 0, end: DAY })).toEqual(['empty.bsp']);
  });

  it('preserves furnish order', () => {
    // Furnish order is kernel precedence -- two SPKs covering one body, later
    // wins -- so a reordered set can answer a different question.
    const reversed = [phase(3), phase(2), phase(1), phase(0)];
    expect(narrow(reversed, { start: 0, end: 400 * DAY })).toEqual([
      'phase3.bsp', 'phase2.bsp', 'phase1.bsp', 'phase0.bsp',
    ]);
  });

  it('keeps a neighbour just outside the window', () => {
    // Light time, GF's bracketing and coverage precision all reach past the
    // endpoints. A window ending an hour into phase1 must not drop phase0.
    const justInto1 = { start: 100 * DAY + 3600, end: 100 * DAY + 7200 };
    expect(narrow(set, justInto1)).toContain('phase0.bsp');
  });

  it('drops a phase further away than the pad', () => {
    // The complement of the test above: the pad must not be so generous that
    // nothing is ever dropped, or the narrowing saves nothing.
    const wellInside1 = { start: 150 * DAY, end: 160 * DAY };
    expect(narrow(set, wellInside1)).not.toContain('phase0.bsp');
    expect(narrow(set, wellInside1)).not.toContain('phase2.bsp');
  });
});

describe('coversWindow', () => {
  const coverage = [{ start: 1000, end: 2000 }];

  it('counts a kernel touching either edge of the padded window', () => {
    expect(coversWindow(coverage, { start: 2000, end: 3000 }, 0)).toBe(true);
    expect(coversWindow(coverage, { start: 0, end: 1000 }, 0)).toBe(true);
  });

  it('excludes one outside it', () => {
    expect(coversWindow(coverage, { start: 2001, end: 3000 }, 0)).toBe(false);
    expect(coversWindow(coverage, { start: 0, end: 999 }, 0)).toBe(false);
  });

  it('admits a kernel the pad brings into range', () => {
    const justPast = { start: 2000 + KERNEL_WINDOW_PAD_SECONDS, end: 3e6 };
    expect(coversWindow(coverage, justPast)).toBe(true);
    expect(coversWindow(coverage, justPast, 0)).toBe(false);
  });

  it('counts any one of several disjoint coverage intervals', () => {
    // An SPK with a gap still serves the window if either side reaches it.
    const gapped = [{ start: 0, end: 100 }, { start: 9000, end: 10_000 }];
    expect(coversWindow(gapped, { start: 9500, end: 9600 }, 0)).toBe(true);
    expect(coversWindow(gapped, { start: 4000, end: 5000 }, 0)).toBe(false);
  });
});

describe('kernelSetKey', () => {
  it('distinguishes different sets and matches identical ones', () => {
    expect(kernelSetKey(['a.bsp', 'b.bsp'])).toBe(kernelSetKey(['a.bsp', 'b.bsp']));
    expect(kernelSetKey(['a.bsp'])).not.toBe(kernelSetKey(['a.bsp', 'b.bsp']));
  });

  it('distinguishes order, because furnish order is precedence', () => {
    expect(kernelSetKey(['a.bsp', 'b.bsp'])).not.toBe(kernelSetKey(['b.bsp', 'a.bsp']));
  });
});
