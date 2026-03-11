import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '../Spice.js';

const KERNEL_DIR = join(__dirname, '../../test-kernels');

describe('Spice WASM integration', () => {
  let spice: Spice;

  beforeAll(async () => {
    spice = await Spice.init();

    // Load leap seconds, planetary constants, and ephemeris
    const lsk = readFileSync(join(KERNEL_DIR, 'naif0012.tls'));
    const pck = readFileSync(join(KERNEL_DIR, 'pck00010.tpc'));
    const spk = readFileSync(join(KERNEL_DIR, 'de425s.bsp'));

    await spice.furnish({ type: 'buffer', data: lsk.buffer, filename: 'naif0012.tls' });
    await spice.furnish({ type: 'buffer', data: pck.buffer, filename: 'pck00010.tpc' });
    await spice.furnish({ type: 'buffer', data: spk.buffer, filename: 'de425s.bsp' });
  }, 30000); // WASM init can be slow

  // --- Time conversion ---

  it('str2et: converts UTC string to ET', () => {
    const et = spice.str2et('2000-01-01T12:00:00');
    // J2000 epoch = 0 ET (plus ~64.184s for TDB-UTC offset)
    expect(et).toBeCloseTo(64.184, 0);
  });

  it('et2utc: converts ET back to UTC', () => {
    const utc = spice.et2utc(0, 'ISOC', 3);
    expect(utc).toContain('2000');
    expect(utc).toContain('01-01'); // ISO calendar format
  });

  it('str2et/et2utc roundtrip', () => {
    const original = '2024-06-15T10:30:00';
    const et = spice.str2et(original);
    const utc = spice.et2utc(et, 'ISOC', 0);
    expect(utc).toBe('2024-06-15T10:30:00');
  });

  // --- Body name/code ---

  it('bodn2c: resolves Earth to NAIF ID 399', () => {
    const code = spice.bodn2c('EARTH');
    expect(code).toBe(399);
  });

  it('bodc2n: resolves 399 to EARTH', () => {
    const name = spice.bodc2n(399);
    expect(name).toBe('EARTH');
  });

  it('bodn2c: returns null for unknown body', () => {
    const code = spice.bodn2c('NONEXISTENT_BODY_XYZ');
    expect(code).toBeNull();
  });

  // --- State vectors ---

  it('spkpos: Earth position relative to Sun', () => {
    const et = spice.str2et('2024-01-01T00:00:00');
    const { position, lightTime } = spice.spkpos('EARTH', et, 'ECLIPJ2000', 'NONE', 'SUN');

    // Earth is ~1 AU from Sun (~149.6M km)
    const dist = Math.sqrt(position[0] ** 2 + position[1] ** 2 + position[2] ** 2);
    expect(dist).toBeGreaterThan(140e6);
    expect(dist).toBeLessThan(160e6);
    // spkpos always computes light time even with NONE correction
    expect(lightTime).toBeGreaterThan(400); // ~499 seconds for 1 AU
  });

  it('spkezr: returns 6-element state', () => {
    const et = spice.str2et('2024-01-01T00:00:00');
    const { state } = spice.spkezr('EARTH', et, 'ECLIPJ2000', 'NONE', 'SUN');

    expect(state).toHaveLength(6);
    // Velocity should be ~30 km/s for Earth
    const speed = Math.sqrt(state[3] ** 2 + state[4] ** 2 + state[5] ** 2);
    expect(speed).toBeGreaterThan(25);
    expect(speed).toBeLessThan(35);
  });

  // --- Frame transforms ---

  it('pxform: rotation matrix between frames', () => {
    const et = spice.str2et('2024-01-01T00:00:00');
    const mat = spice.pxform('J2000', 'ECLIPJ2000', et);

    expect(mat).toHaveLength(9);
    // Should be a proper rotation matrix: det ≈ 1
    const det =
      mat[0] * (mat[4] * mat[8] - mat[5] * mat[7]) -
      mat[1] * (mat[3] * mat[8] - mat[5] * mat[6]) +
      mat[2] * (mat[3] * mat[7] - mat[4] * mat[6]);
    expect(det).toBeCloseTo(1, 5);
  });

  // --- Body constants ---

  it('bodvrd: Earth radii', () => {
    const radii = spice.bodvrd('EARTH', 'RADII');
    expect(radii).toHaveLength(3);
    // Earth equatorial radius ~6378 km
    expect(radii[0]).toBeCloseTo(6378.1, 0);
  });

  // --- Orbital elements ---

  it('oscelt/conics roundtrip', () => {
    const et = spice.str2et('2024-01-01T00:00:00');
    const { state } = spice.spkezr('EARTH', et, 'J2000', 'NONE', 'SUN');

    // Sun GM in km^3/s^2 (pck00010 doesn't have BODY10_GM, use known value)
    const mu = 132712440041.94;

    // State → elements → state roundtrip
    const elements = spice.oscelt(state, et, mu);
    const recovered = spice.conics(elements, et);

    for (let i = 0; i < 6; i++) {
      expect(recovered[i]).toBeCloseTo(state[i], 3);
    }
  });

  // --- Math ---

  it('vnorm: vector magnitude', () => {
    expect(spice.vnorm([3, 4, 0])).toBeCloseTo(5);
  });

  it('vdot: dot product', () => {
    expect(spice.vdot([1, 2, 3], [4, 5, 6])).toBeCloseTo(32);
  });

  it('vcrss: cross product', () => {
    const result = spice.vcrss([1, 0, 0], [0, 1, 0]);
    expect(result[0]).toBeCloseTo(0);
    expect(result[1]).toBeCloseTo(0);
    expect(result[2]).toBeCloseTo(1);
  });

  it('vhat: unit vector', () => {
    const result = spice.vhat([3, 4, 0]);
    expect(result[0]).toBeCloseTo(0.6);
    expect(result[1]).toBeCloseTo(0.8);
    expect(result[2]).toBeCloseTo(0);
  });

  it('vadd/vsub', () => {
    const sum = spice.vadd([1, 2, 3], [10, 20, 30]);
    expect(sum).toEqual([11, 22, 33]);

    const diff = spice.vsub([10, 20, 30], [1, 2, 3]);
    expect(diff).toEqual([9, 18, 27]);
  });

  it('vscl: scalar multiply', () => {
    const result = spice.vscl(2, [3, 4, 5]);
    expect(result).toEqual([6, 8, 10]);
  });

  it('mxv: matrix-vector multiply', () => {
    // Identity matrix
    const result = spice.mxv([1, 0, 0, 0, 1, 0, 0, 0, 1], [3, 4, 5]);
    expect(result[0]).toBeCloseTo(3);
    expect(result[1]).toBeCloseTo(4);
    expect(result[2]).toBeCloseTo(5);
  });

  // --- Error handling ---

  it('throws on SPICE error', () => {
    expect(() => spice.str2et('NOT A VALID TIME STRING!!!')).toThrow('SPICE');
  });

  // --- Kernel management ---

  it('tracks loaded kernels', () => {
    expect(spice.totalLoaded()).toBe(3);
  });
});
