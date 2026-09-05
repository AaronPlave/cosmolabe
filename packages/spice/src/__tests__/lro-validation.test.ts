/**
 * LRO Position Validation Test
 *
 * Compares LRO state vectors from our SPICE kernels against
 * JPL Horizons as an independent reference.
 *
 * Test epoch: 2025-01-15 00:03:26 UTC (matches NASA Eyes screenshot)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { Spice } from '../Spice.js';
import { kernelArrayBuffer } from './_kernel-bytes.js';

const KERNEL_DIR = join(__dirname, '../../../../apps/viewer/test-catalogs/kernels');

/** Mean lunar radius the altitude bound below is expressed against. */
const MOON_R_KM = 1737.4;

/** Read a kernel file; transparently decompress if it's stored gzipped on
 *  disk. The viewer's mission-specific kernels (LRO, etc.) ship as .gz to
 *  cut the repo checkout size — the catalog loader decompresses at load
 *  time. Tests need the same handling. */
function readKernel(relPath: string): Buffer {
  const fullPath = join(KERNEL_DIR, relPath);
  try {
    return readFileSync(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return gunzipSync(readFileSync(`${fullPath}.gz`));
  }
}

function norm3(v: readonly number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

describe('LRO position validation', () => {
  let spice: Spice;
  let et: number;

  beforeAll(async () => {
    spice = await Spice.init();

    // Load generic kernels
    const lsk = readKernel('naif0012.tls');
    const pck = readKernel('pck00011.tpc');
    const spk = readKernel('de440s.bsp');

    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(lsk), filename: 'naif0012.tls' });
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(pck), filename: 'pck00011.tpc' });
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(spk), filename: 'de440s.bsp' });

    // Load LRO kernels
    const lroSpk = readKernel('lro/lrorg_2024350_2025074_v01.bsp');
    const lroFrames = readKernel('lro/lro_frames_2014049_v01.tf');

    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(lroSpk), filename: 'lrorg_2024350_2025074_v01.bsp' });
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(lroFrames), filename: 'lro_frames_2014049_v01.tf' });

    et = spice.str2et('2025-01-15T00:03:26');
  }, 30000);

  // Was ~56 lines of console.log ending in `expect(true).toBe(true)` — a
  // diagnostic dump from the NASA Eyes screenshot comparison that ran on every
  // CI run and could never fail (issue #24). Two of the quantities it printed
  // are worth bounding; the rest (RA/Dec, Moon-wrt-Earth) restate de440s.bsp,
  // which other suites already cover, so they are gone rather than reprinted.
  it('places LRO in low lunar orbit at the screenshot epoch', () => {
    // LRO's orbit ranges roughly 20-165 km over a cycle, so a bound this tight
    // pins the right body at the right epoch: a wrong SPK, a wrong centre, or a
    // UTC/TDB epoch slip all move this by far more than 200 m.
    for (const abcorr of ['NONE', 'LT', 'LT+S', 'CN+S'] as const) {
      const r = norm3(spice.spkezr('LRO', et, 'J2000', abcorr, 'MOON').state);
      const altKm = r - MOON_R_KM;
      expect(altKm, `altitude with abcorr=${abcorr}`).toBeGreaterThan(75.5);
      expect(altKm, `altitude with abcorr=${abcorr}`).toBeLessThan(75.9);
    }
  });

  it('applies aberration corrections to the LRO state', () => {
    const none = spice.spkezr('LRO', et, 'J2000', 'NONE', 'MOON');
    const lts = spice.spkezr('LRO', et, 'J2000', 'LT+S', 'MOON');
    const posDiff = norm3([
      none.state[0] - lts.state[0],
      none.state[1] - lts.state[1],
      none.state[2] - lts.state[2],
    ]);

    // Bounded by physics rather than a measured constant, because the LRO
    // kernels are fetched rather than committed: at ~1770 km range the
    // light-time term is ~10 m (0.006 s of light time at 1.6 km/s) and stellar
    // aberration is ~180 m (range × v/c, on the observer's ~30 km/s
    // barycentric motion), so the delta must be well under a kilometre — and
    // it must not be zero, which is what a binding that silently dropped
    // `abcorr` would produce.
    expect(posDiff).toBeGreaterThan(0);
    expect(posDiff).toBeLessThan(1);
  });

  it('compares against JPL Horizons at 00:03:00 UTC', () => {
    // Horizons query: COMMAND='-85', CENTER='500@301', ICRF, geometric, TIME_TYPE=UT
    // Result at 2025-Jan-15 00:03:00.0000 UTC:
    const horizons = {
      x: -6.285413014634239e+01,
      y: -1.576152019101071e+03,
      z:  8.951363650005925e+02,
      vx: 1.885843252997175e-01,
      vy: -7.965082216650810e-01,
      vz: -1.432781298605911e+00,
    };

    const et03 = spice.str2et('2025-01-15T00:03:00');
    const ours = spice.spkezr('LRO', et03, 'J2000', 'NONE', 'MOON');

    const posDiff = norm3([
      ours.state[0] - horizons.x,
      ours.state[1] - horizons.y,
      ours.state[2] - horizons.z,
    ]);
    const velDiff = norm3([
      ours.state[3] - horizons.vx,
      ours.state[4] - horizons.vy,
      ours.state[5] - horizons.vz,
    ]);

    // Horizons and this SPK are the same GSFC reconstruction, so they agree far
    // more closely than "a few km": the old 5 km bound passed a delta 5000×
    // larger than the real one, and the velocity delta was computed and then
    // never asserted at all. Both deltas measured as 0 at the print precision
    // this test used to run at (issue #24), which bounds them at <0.05 m and
    // <5e-7 km/s; each bound below leaves ~20× headroom over that. Tighten
    // them once someone reads the real residuals off a run with the LRO
    // kernels present — they are fetched from NAIF, not committed.
    expect(posDiff, 'position vs Horizons (km)').toBeLessThan(1e-3); // 1 m
    expect(velDiff, 'velocity vs Horizons (km/s)').toBeLessThan(1e-5); // 1 cm/s
  });
});
