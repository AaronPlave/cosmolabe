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
import { join } from 'node:path';
import { Spice } from '../Spice.js';

const KERNEL_DIR = join(__dirname, '../../../../apps/viewer/test-catalogs/kernels');

describe('LRO position validation', () => {
  let spice: Spice;
  let et: number;

  beforeAll(async () => {
    spice = await Spice.init();

    // Load generic kernels
    const lsk = readFileSync(join(KERNEL_DIR, 'naif0012.tls'));
    const pck = readFileSync(join(KERNEL_DIR, 'pck00011.tpc'));
    const spk = readFileSync(join(KERNEL_DIR, 'de440s.bsp'));

    await spice.furnish({ type: 'buffer', data: lsk.buffer, filename: 'naif0012.tls' });
    await spice.furnish({ type: 'buffer', data: pck.buffer, filename: 'pck00011.tpc' });
    await spice.furnish({ type: 'buffer', data: spk.buffer, filename: 'de440s.bsp' });

    // Load LRO kernels
    const lroSpk = readFileSync(join(KERNEL_DIR, 'lro/lrorg_2024350_2025074_v01.bsp'));
    const lroFrames = readFileSync(join(KERNEL_DIR, 'lro/lro_frames_2014049_v01.tf'));

    await spice.furnish({ type: 'buffer', data: lroSpk.buffer, filename: 'lrorg_2024350_2025074_v01.bsp' });
    await spice.furnish({ type: 'buffer', data: lroFrames.buffer, filename: 'lro_frames_2014049_v01.tf' });

    et = spice.str2et('2025-01-15T00:03:26');
  }, 30000);

  it('prints LRO state at screenshot epoch with different aberration corrections', () => {
    console.log(`\n=== LRO Position Validation ===`);
    console.log(`Epoch: 2025-01-15 00:03:26 UTC`);
    console.log(`ET: ${et}`);
    console.log(`ET formatted: ${spice.et2utc(et, 'ISOC', 3)}\n`);

    // Query LRO relative to Moon in J2000 frame with different aberration corrections
    const corrections = ['NONE', 'LT', 'LT+S', 'CN+S'] as const;

    for (const abcorr of corrections) {
      const result = spice.spkezr('LRO', et, 'J2000', abcorr, 'MOON');
      const [x, y, z, vx, vy, vz] = result.state;
      const r = Math.sqrt(x * x + y * y + z * z);
      const v = Math.sqrt(vx * vx + vy * vy + vz * vz);

      console.log(`--- abcorr: ${abcorr} ---`);
      console.log(`  Position (km): [${x.toFixed(6)}, ${y.toFixed(6)}, ${z.toFixed(6)}]`);
      console.log(`  Velocity (km/s): [${vx.toFixed(6)}, ${vy.toFixed(6)}, ${vz.toFixed(6)}]`);
      console.log(`  Distance from Moon center: ${r.toFixed(3)} km`);
      console.log(`  Altitude above Moon (R=1737.4): ${(r - 1737.4).toFixed(3)} km`);
      console.log(`  Speed: ${v.toFixed(6)} km/s`);
      console.log(`  Light time: ${result.lightTime.toFixed(9)} s`);
    }

    // Show the difference between NONE and LT+S
    const none = spice.spkezr('LRO', et, 'J2000', 'NONE', 'MOON');
    const lts = spice.spkezr('LRO', et, 'J2000', 'LT+S', 'MOON');
    const dx = none.state[0] - lts.state[0];
    const dy = none.state[1] - lts.state[1];
    const dz = none.state[2] - lts.state[2];
    const posDiff = Math.sqrt(dx * dx + dy * dy + dz * dz);
    console.log(`\n--- NONE vs LT+S position difference ---`);
    console.log(`  Delta: ${posDiff.toFixed(6)} km = ${(posDiff * 1000).toFixed(3)} m`);

    // Also query LRO relative to Earth (for Horizons comparison)
    console.log(`\n--- LRO wrt Earth (for Horizons comparison) ---`);
    const earthNone = spice.spkezr('LRO', et, 'J2000', 'NONE', 'EARTH');
    const [ex, ey, ez] = earthNone.state;
    const er = Math.sqrt(ex * ex + ey * ey + ez * ez);
    console.log(`  Position (km): [${ex.toFixed(6)}, ${ey.toFixed(6)}, ${ez.toFixed(6)}]`);
    console.log(`  Distance from Earth: ${er.toFixed(3)} km`);

    // Moon position wrt Earth (for sanity check)
    const moonEarth = spice.spkezr('MOON', et, 'J2000', 'NONE', 'EARTH');
    const [mx, my, mz] = moonEarth.state;
    const mr = Math.sqrt(mx * mx + my * my + mz * mz);
    console.log(`\n--- Moon wrt Earth ---`);
    console.log(`  Position (km): [${mx.toFixed(6)}, ${my.toFixed(6)}, ${mz.toFixed(6)}]`);
    console.log(`  Distance: ${mr.toFixed(3)} km`);

    // LRO position in RA/Dec (for Horizons comparison)
    const rrd = spice.recrad([ex, ey, ez]);
    console.log(`\n--- LRO RA/Dec from Earth ---`);
    console.log(`  RA: ${(rrd.ra * 180 / Math.PI).toFixed(6)}°`);
    console.log(`  Dec: ${(rrd.dec * 180 / Math.PI).toFixed(6)}°`);

    expect(true).toBe(true); // Just for output
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

    const dx = ours.state[0] - horizons.x;
    const dy = ours.state[1] - horizons.y;
    const dz = ours.state[2] - horizons.z;
    const posDiff = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const dvx = ours.state[3] - horizons.vx;
    const dvy = ours.state[4] - horizons.vy;
    const dvz = ours.state[5] - horizons.vz;
    const velDiff = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);

    console.log(`\n=== Horizons vs Our Kernel at 00:03:00 UTC ===`);
    console.log(`Horizons (ICRF, geometric, Moon center):`);
    console.log(`  Pos: [${horizons.x.toFixed(6)}, ${horizons.y.toFixed(6)}, ${horizons.z.toFixed(6)}]`);
    console.log(`  Vel: [${horizons.vx.toFixed(6)}, ${horizons.vy.toFixed(6)}, ${horizons.vz.toFixed(6)}]`);
    console.log(`Our kernel (J2000, NONE, MOON):`);
    console.log(`  Pos: [${ours.state[0].toFixed(6)}, ${ours.state[1].toFixed(6)}, ${ours.state[2].toFixed(6)}]`);
    console.log(`  Vel: [${ours.state[3].toFixed(6)}, ${ours.state[4].toFixed(6)}, ${ours.state[5].toFixed(6)}]`);
    console.log(`\nDelta position: ${posDiff.toFixed(3)} km = ${(posDiff * 1000).toFixed(1)} m`);
    console.log(`Delta velocity: ${(velDiff * 1000).toFixed(3)} m/s`);
    console.log(`Delta X: ${(dx * 1000).toFixed(1)} m`);
    console.log(`Delta Y: ${(dy * 1000).toFixed(1)} m`);
    console.log(`Delta Z: ${(dz * 1000).toFixed(1)} m`);

    // Position should agree to within a few km (same GSFC reconstruction source)
    expect(posDiff).toBeLessThan(5); // 5 km tolerance
  });
});
