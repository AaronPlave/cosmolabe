// Round trip for the synthetic-fixture path the differential harness relies
// on (ADR M-0002, GS-4): writeSpkType13 stages and furnishes a Type 13
// Hermite segment, readKernelBytes hands the exact bytes back out, and a
// second, independent bindings instance furnished with those bytes returns
// the identical interpolated states.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceBindings, SpiceError, type SpiceBindings } from './index.ts';

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
