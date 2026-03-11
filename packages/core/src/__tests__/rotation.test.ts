import { describe, it, expect } from 'vitest';
import { UniformRotation } from '../rotations/UniformRotation.js';

describe('UniformRotation', () => {
  it('returns identity-like quaternion at epoch with zero meridian angle', () => {
    const rot = new UniformRotation(86400, 0, 0, 0, Math.PI / 2); // pole at +Z
    const q = rot.rotationAt(0);
    // At angle=0, quaternion should be [1, 0, 0, 0] (identity)
    expect(q[0]).toBeCloseTo(1, 5);
    expect(q[1]).toBeCloseTo(0, 5);
    expect(q[2]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(0, 5);
  });

  it('rotates 180 degrees after half period', () => {
    const period = 86400;
    const rot = new UniformRotation(period, 0, 0, 0, Math.PI / 2); // pole at +Z
    const q = rot.rotationAt(period / 2);
    // After half period, angle = π, quaternion around Z: [cos(π/2), 0, 0, sin(π/2)] = [0, 0, 0, 1]
    expect(Math.abs(q[0])).toBeCloseTo(0, 3);
    expect(Math.abs(q[3])).toBeCloseTo(1, 3);
  });

  it('returns to identity after full period', () => {
    const period = 86400;
    const rot = new UniformRotation(period, 0, 0, 0, Math.PI / 2);
    const q = rot.rotationAt(period);
    // Full rotation: angle = 2π, quaternion = [-1, 0, 0, 0] or [1, 0, 0, 0]
    // cos(π) = -1, so w ≈ -1
    expect(Math.abs(q[0])).toBeCloseTo(1, 3);
  });
});
