import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '../Spice.js';

const KERNEL_DIR = join(__dirname, '../../test-kernels');

describe('SPICE FOV functions', () => {
  let spice: Spice;

  beforeAll(async () => {
    spice = await Spice.init();

    // Load standard kernels (fovray needs a valid observer even with NONE abcorr)
    const lsk = readFileSync(join(KERNEL_DIR, 'naif0012.tls'));
    const pck = readFileSync(join(KERNEL_DIR, 'pck00010.tpc'));
    const spk = readFileSync(join(KERNEL_DIR, 'de425s.bsp'));
    await spice.furnish({ type: 'buffer', data: lsk.buffer, filename: 'naif0012.tls' });
    await spice.furnish({ type: 'buffer', data: pck.buffer, filename: 'pck00010.tpc' });
    await spice.furnish({ type: 'buffer', data: spk.buffer, filename: 'de425s.bsp' });

    // Load IK with test instrument definitions
    const ik = readFileSync(join(KERNEL_DIR, 'test_instruments.ti'));
    await spice.furnish({ type: 'buffer', data: ik.buffer, filename: 'test_instruments.ti' });
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

  // --- fovray ---

  it('fovray: boresight direction is inside FOV', () => {
    // Ray along +Z = boresight of -999001
    const inside = spice.fovray('-999001', [0, 0, 1], 'J2000', 'NONE', 'EARTH', 0);
    expect(inside).toBe(true);
  });

  it('fovray: perpendicular direction is outside FOV', () => {
    // Ray along +X = 90 deg from boresight, well outside 5 deg cone
    const inside = spice.fovray('-999001', [1, 0, 0], 'J2000', 'NONE', 'EARTH', 0);
    expect(inside).toBe(false);
  });

  it('fovray: ray just inside circular cone', () => {
    // 4 deg off boresight (inside 5 deg cone)
    const angle = (4 * Math.PI) / 180;
    const inside = spice.fovray('-999001', [Math.sin(angle), 0, Math.cos(angle)], 'J2000', 'NONE', 'EARTH', 0);
    expect(inside).toBe(true);
  });

  it('fovray: ray just outside circular cone', () => {
    // 6 deg off boresight (outside 5 deg cone)
    const angle = (6 * Math.PI) / 180;
    const inside = spice.fovray('-999001', [Math.sin(angle), 0, Math.cos(angle)], 'J2000', 'NONE', 'EARTH', 0);
    expect(inside).toBe(false);
  });

  it('fovray: rectangular FOV respects asymmetric bounds', () => {
    // 8 deg in X direction (inside 10 deg half-angle)
    const ax = (8 * Math.PI) / 180;
    const insideX = spice.fovray('-999002', [Math.sin(ax), 0, Math.cos(ax)], 'J2000', 'NONE', 'EARTH', 0);
    expect(insideX).toBe(true);

    // 8 deg in Y direction (outside 5 deg cross-angle)
    const ay = (8 * Math.PI) / 180;
    const insideY = spice.fovray('-999002', [0, Math.sin(ay), Math.cos(ay)], 'J2000', 'NONE', 'EARTH', 0);
    expect(insideY).toBe(false);
  });
});
