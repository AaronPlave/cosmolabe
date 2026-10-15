/** Integration coverage on the supported frames adapter. */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHeritageSpice, type HeritageSpice } from '../index.js';
import { kernelArrayBuffer } from './_kernel-bytes.js';

const KERNEL_DIR = join(__dirname, '../../../../kernels/test-data');

describe('SPICE FOV functions', () => {
  let spice: HeritageSpice;

  beforeAll(async () => {
    spice = await createHeritageSpice();

    // Load standard kernels (fovray needs a valid observer even with NONE abcorr)
    const lsk = readFileSync(join(KERNEL_DIR, 'naif0012.tls'));
    const pck = readFileSync(join(KERNEL_DIR, 'pck00010.tpc'));
    const spk = readFileSync(join(KERNEL_DIR, 'de425s.bsp'));
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(lsk), filename: 'naif0012.tls' });
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(pck), filename: 'pck00010.tpc' });
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(spk), filename: 'de425s.bsp' });

    // Load IK with test instrument definitions
    const ik = readFileSync(join(KERNEL_DIR, 'test_instruments.ti'));
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(ik), filename: 'test_instruments.ti' });
  }, 30000);

  // --- getfov ---

  it('getfov: reads circular FOV definition', () => {
    const fov = spice.getfov(-999001);
    expect(fov.shape).toBe('CIRCLE');
    expect(fov.frame).toBe('J2000');
    expect(fov.boresight[0]).toBeCloseTo(0, 10);
    expect(fov.boresight[1]).toBeCloseTo(0, 10);
    expect(fov.boresight[2]).toBeCloseTo(1, 10);
    // Circle has 1 boundary vector
    expect(fov.bounds).toHaveLength(1);
    // Boundary vector should be at 5 deg from boresight along ref vector
    const angle = Math.acos(fov.bounds[0][2]); // angle from +Z
    expect(angle).toBeCloseTo((5 * Math.PI) / 180, 4);
  });

  it('getfov: reads rectangular FOV definition', () => {
    const fov = spice.getfov(-999002);
    expect(fov.shape).toBe('RECTANGLE');
    expect(fov.frame).toBe('J2000');
    expect(fov.boresight[2]).toBeCloseTo(1, 10);
    // Rectangle has 4 boundary vectors (corners)
    expect(fov.bounds).toHaveLength(4);
  });

  // fovray is outside the supported adapter API; see retirement coverage mapping.










  it('rejects the unsupported fovray entrypoint explicitly', () => {
    expect(() => spice.fovray('unused', [0, 0, 1], 'J2000', 'NONE', 'EARTH', 0))
      .toThrow(/not in the CSPICE WASM export allowlist/);
  });
});
