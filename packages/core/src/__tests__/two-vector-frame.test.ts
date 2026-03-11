import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '@spicecraft/spice';
import { TwoVectorFrame } from '../frames/TwoVectorFrame.js';
import { transformVector } from '../frames/Frame.js';

const KERNEL_DIR = join(__dirname, '../../../spice/test-kernels');

describe('TwoVectorFrame (SPICE integration)', () => {
  let spice: Spice;

  beforeAll(async () => {
    spice = await Spice.init();

    const lsk = readFileSync(join(KERNEL_DIR, 'naif0012.tls'));
    const pck = readFileSync(join(KERNEL_DIR, 'pck00010.tpc'));
    const spk = readFileSync(join(KERNEL_DIR, 'de425s.bsp'));

    await spice.furnish({ type: 'buffer', data: lsk.buffer, filename: 'naif0012.tls' });
    await spice.furnish({ type: 'buffer', data: pck.buffer, filename: 'pck00010.tpc' });
    await spice.furnish({ type: 'buffer', data: spk.buffer, filename: 'de425s.bsp' });
  }, 30000);

  it('produces orthonormal rotation matrix', () => {
    // Frame with X = Earth→Moon position, Y = Earth→Sun position
    const frame = new TwoVectorFrame('test', spice,
      'X', { type: 'position', target: 'MOON', observer: 'EARTH' },
      'Y', { type: 'position', target: 'SUN', observer: 'EARTH' },
    );

    const et = spice.str2et('2024-01-01T00:00:00');
    const mat = frame.toInertial(et);

    expect(mat).toHaveLength(9);

    // Each row should be a unit vector
    for (let r = 0; r < 3; r++) {
      const mag = Math.sqrt(mat[r * 3] ** 2 + mat[r * 3 + 1] ** 2 + mat[r * 3 + 2] ** 2);
      expect(mag).toBeCloseTo(1, 10);
    }

    // Rows should be orthogonal (dot products ≈ 0)
    const dot01 = mat[0] * mat[3] + mat[1] * mat[4] + mat[2] * mat[5];
    const dot02 = mat[0] * mat[6] + mat[1] * mat[7] + mat[2] * mat[8];
    const dot12 = mat[3] * mat[6] + mat[4] * mat[7] + mat[5] * mat[8];
    expect(dot01).toBeCloseTo(0, 10);
    expect(dot02).toBeCloseTo(0, 10);
    expect(dot12).toBeCloseTo(0, 10);

    // Determinant should be +1 (right-handed)
    const det =
      mat[0] * (mat[4] * mat[8] - mat[5] * mat[7]) -
      mat[1] * (mat[3] * mat[8] - mat[5] * mat[6]) +
      mat[2] * (mat[3] * mat[7] - mat[4] * mat[6]);
    expect(det).toBeCloseTo(1, 10);
  });

  it('X-axis aligns with primary vector direction', () => {
    const frame = new TwoVectorFrame('moon-frame', spice,
      'X', { type: 'position', target: 'MOON', observer: 'EARTH' },
      'Z', { type: 'position', target: 'SUN', observer: 'EARTH' },
    );

    const et = spice.str2et('2024-06-15T00:00:00');
    const mat = frame.toInertial(et);

    // Get the actual Moon position and normalize it
    const { position } = spice.spkpos('MOON', et, 'ECLIPJ2000', 'NONE', 'EARTH');
    const mag = Math.sqrt(position[0] ** 2 + position[1] ** 2 + position[2] ** 2);
    const moonDir = [position[0] / mag, position[1] / mag, position[2] / mag];

    // Frame's X-axis = first column of matrix (frame→inertial)
    expect(mat[0]).toBeCloseTo(moonDir[0], 8);
    expect(mat[3]).toBeCloseTo(moonDir[1], 8);
    expect(mat[6]).toBeCloseTo(moonDir[2], 8);
  });

  it('works with velocity vectors', () => {
    // Frame with X = Earth velocity relative to Sun, Y = Earth→Sun position
    const frame = new TwoVectorFrame('vel-frame', spice,
      'X', { type: 'velocity', target: 'EARTH', observer: 'SUN' },
      'Y', { type: 'position', target: 'EARTH', observer: 'SUN' },
    );

    const et = spice.str2et('2024-01-01T00:00:00');
    const mat = frame.toInertial(et);

    // Should be valid orthonormal matrix
    const det =
      mat[0] * (mat[4] * mat[8] - mat[5] * mat[7]) -
      mat[1] * (mat[3] * mat[8] - mat[5] * mat[6]) +
      mat[2] * (mat[3] * mat[7] - mat[4] * mat[6]);
    expect(det).toBeCloseTo(1, 10);
  });

  it('transforms vectors between frames', () => {
    const frame = new TwoVectorFrame('test', spice,
      'X', { type: 'position', target: 'MOON', observer: 'EARTH' },
      'Y', { type: 'position', target: 'SUN', observer: 'EARTH' },
    );

    const et = spice.str2et('2024-01-01T00:00:00');
    const mat = frame.toInertial(et);

    // Moon position in inertial frame
    const { position: moonPos } = spice.spkpos('MOON', et, 'ECLIPJ2000', 'NONE', 'EARTH');

    // Transform Moon position into our frame: should be along +X
    // For this we need the inverse (transpose) since mat goes frame→inertial
    const transposed = [
      mat[0], mat[3], mat[6],
      mat[1], mat[4], mat[7],
      mat[2], mat[5], mat[8],
    ] as [number, number, number, number, number, number, number, number, number];

    const moonInFrame = transformVector(transposed, moonPos);
    const dist = Math.sqrt(moonPos[0] ** 2 + moonPos[1] ** 2 + moonPos[2] ** 2);

    // X component should be ~distance, Y and Z should be ~0
    expect(moonInFrame[0]).toBeCloseTo(dist, 0);
    expect(Math.abs(moonInFrame[1])).toBeLessThan(1); // near zero
    expect(Math.abs(moonInFrame[2])).toBeLessThan(1);
  });
});
