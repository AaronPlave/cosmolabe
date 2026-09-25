// Round trip for the synthetic-fixture path the differential harness relies
// on (ADR M-0002, GS-4): writeSpkType13 stages and furnishes a Type 13
// Hermite segment, readKernelBytes hands the exact bytes back out, and a
// second, independent bindings instance furnished with those bytes returns
// the identical interpolated states.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceBindings, SpiceError, type SpiceBindings } from './index.js';

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))),
  );

const MU_EARTH = 398600.4418;
const SMA = 6928.137;
const BODY = -9990;

describe('cspice-wasm SPK write and read-back', () => {
  let writer: SpiceBindings;
  let reader: SpiceBindings;
  let et0: number;
  let epochs: Float64Array;
  let states: Float64Array;

  beforeAll(async () => {
    writer = await createSpiceBindings();
    reader = await createSpiceBindings();
    const lsk = fixture('naif0012.tls');
    writer.furnsh('naif0012.tls', lsk);
    reader.furnsh('naif0012.tls', lsk);
    et0 = writer.str2et('2026-06-15T00:00:00');

    // A circular two-body arc sampled every 60 s for 20 minutes.
    const n = Math.sqrt(MU_EARTH / (SMA * SMA * SMA));
    const count = 21;
    epochs = new Float64Array(count);
    states = new Float64Array(count * 6);
    for (let i = 0; i < count; i++) {
      const dt = i * 60;
      const u = n * dt;
      epochs[i] = et0 + dt;
      states.set(
        [
          SMA * Math.cos(u),
          SMA * Math.sin(u),
          0,
          -SMA * n * Math.sin(u),
          SMA * n * Math.cos(u),
          0,
        ],
        i * 6,
      );
    }
    writer.writeSpkType13('writeback.bsp', BODY, 399, 'J2000', 'WRITEBACK', 7, epochs, states);
  });

  it('reads the staged kernel bytes back out', () => {
    const bytes = writer.readKernelBytes('writeback.bsp');
    expect(bytes.length).toBeGreaterThan(1024);
    // DAF binary SPKs open with the DAF/SPK id word.
    expect(new TextDecoder().decode(bytes.slice(0, 7))).toBe('DAF/SPK');
  });

  it('a second instance furnished with the bytes returns identical states', () => {
    reader.furnsh('writeback.bsp', writer.readKernelBytes('writeback.bsp'));
    for (const dt of [0, 90, 605, 1170]) {
      const a = writer.spkezr(String(BODY), et0 + dt, 'J2000', 'NONE', '399');
      const b = reader.spkezr(String(BODY), et0 + dt, 'J2000', 'NONE', '399');
      expect(b.position).toEqual(a.position);
      expect(b.velocity).toEqual(a.velocity);
    }
  });

  it('interpolates through the written samples to the sampled truth', () => {
    // At a sample node the Hermite interpolant reproduces the input exactly.
    const s = writer.spkezr(String(BODY), et0 + 300, 'J2000', 'NONE', '399');
    expect(Math.abs(s.position.x - states[5 * 6]!)).toBeLessThan(1e-9);
    expect(Math.abs(s.position.y - states[5 * 6 + 1]!)).toBeLessThan(1e-9);
  });

  it('fails loudly for an unknown staged kernel name', () => {
    expect(() => writer.readKernelBytes('missing.bsp')).toThrow(SpiceError);
  });
});

describe('cspice-wasm SPK write with segment breaks', () => {
  it('keeps a discontinuity as a step instead of interpolating across it', async () => {
    const b = await createSpiceBindings();
    b.furnsh('naif0012.tls', fixture('naif0012.tls'));
    const et0 = b.str2et('2016-01-01T00:00:00');
    // Straight-line motion at 1 km/s along x, with a 50 km jump in x at t = 300 s
    // (an orbit-determination update). The jump epoch is sampled on both sides.
    const t = [0, 100, 200, 300, 300, 400, 500, 600];
    const epochs = new Float64Array(t.map((dt) => et0 + dt));
    const states = new Float64Array(t.length * 6);
    t.forEach((dt, i) => states.set([dt + (i >= 4 ? 50 : 0), 0, 0, 1, 0, 0], i * 6));
    b.writeSpkType13('broken.bsp', -9991, 399, 'J2000', 'BROKEN', 7, epochs, states, [4]);

    const x = (dt: number) => b.spkpos('-9991', et0 + dt, 'J2000', 'NONE', '399').position.x;
    // Each side is exact straight-line motion; nothing leaks across the jump.
    expect(x(250)).toBeCloseTo(250, 9);
    expect(x(299.999)).toBeCloseTo(299.999, 6);
    expect(x(350)).toBeCloseTo(400, 9);
    // At the shared epoch the later segment wins.
    expect(x(300)).toBeCloseTo(350, 9);
  });

  it('refuses a segment with fewer than two samples', async () => {
    const b = await createSpiceBindings();
    const epochs = new Float64Array([0, 1, 2]);
    expect(() => b.writeSpkType13('bad.bsp', -9992, 399, 'J2000', 'BAD', 7, epochs, new Float64Array(18), [2])).toThrow(/fewer than 2/);
  });
});
