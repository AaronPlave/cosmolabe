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

  it('getfov: preserves the rectangular FOV’s asymmetric half-angles', () => {
    const fov = spice.getfov(-999002);
    expect(fov.shape).toBe('RECTANGLE');
    expect(fov.frame).toBe('J2000');
    expect(fov.boresight[2]).toBeCloseTo(1, 10);
    // Rectangle has 4 boundary vectors (corners)
    expect(fov.bounds).toHaveLength(4);
    // The IK specifies +Z boresight, +X reference, 10° horizontal and 5° vertical
    // half-angles. Pin all four corners, including their quadrants: 8° fits
    // horizontally but exceeds the vertical extent (formerly checked by fovray).
    for (const [x, y, z] of fov.bounds) {
      expect(z).toBeGreaterThan(0);
      expect(Math.atan2(Math.abs(x), z) * 180 / Math.PI).toBeCloseTo(10, 10);
      expect(Math.atan2(Math.abs(y), z) * 180 / Math.PI).toBeCloseTo(5, 10);
    }
    expect(fov.bounds.map(([x, y]) => [Math.sign(x), Math.sign(y)]).sort())
      .toEqual([[-1, -1], [-1, 1], [1, -1], [1, 1]]);
  });

  // fovray is outside the supported adapter API; see retirement coverage mapping.

  it('rejects the unsupported fovray entrypoint explicitly', () => {
    expect(() => spice.fovray('unused', [0, 0, 1], 'J2000', 'NONE', 'EARTH', 0))
      .toThrow(/not in the CSPICE WASM export allowlist/);
  });
});
