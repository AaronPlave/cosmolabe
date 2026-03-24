import type { Quaternion, RotationModel } from './RotationModel.js';

/**
 * Fixed (constant) rotation model. Returns the same quaternion at all times.
 *
 * Supports two Cosmographia catalog forms:
 *  1. Explicit quaternion: { type: "Fixed", quaternion: [w, x, y, z] }
 *  2. Pole angles: { type: "Fixed", inclination, ascendingNode, meridianAngle }
 *     Composed as Rz(ascendingNode) * Rx(inclination) * Rz(meridianAngle).
 */
export class FixedRotation implements RotationModel {
  private readonly q: Quaternion;

  constructor(quaternion: Quaternion) {
    this.q = quaternion;
  }

  rotationAt(_et: number): Quaternion {
    return [...this.q] as Quaternion;
  }

  /**
   * Create from Cosmographia pole angles (all in radians).
   * Equivalent to Rz(ascendingNode) * Rx(inclination) * Rz(meridianAngle).
   */
  static fromPoleAngles(inclination: number, ascendingNode: number, meridianAngle: number): FixedRotation {
    return new FixedRotation(composeZXZ(ascendingNode, inclination, meridianAngle));
  }
}

/** Compose Rz(a) * Rx(b) * Rz(c) into a single quaternion. */
function composeZXZ(a: number, b: number, c: number): Quaternion {
  // qZ(a) = [cos(a/2), 0, 0, sin(a/2)]
  const ca = Math.cos(a / 2), sa = Math.sin(a / 2);
  // qX(b) = [cos(b/2), sin(b/2), 0, 0]
  const cb = Math.cos(b / 2), sb = Math.sin(b / 2);
  // qZ(c) = [cos(c/2), 0, 0, sin(c/2)]
  const cc = Math.cos(c / 2), sc = Math.sin(c / 2);

  // First multiply qZ(a) * qX(b)
  // [ca, 0, 0, sa] * [cb, sb, 0, 0]
  const w1 = ca * cb;
  const x1 = ca * sb;
  const y1 = sa * sb;
  const z1 = sa * cb;

  // Then multiply result * qZ(c)
  // [w1, x1, y1, z1] * [cc, 0, 0, sc]
  const w = w1 * cc - z1 * sc;
  const x = x1 * cc + y1 * sc;
  const y = y1 * cc - x1 * sc;
  const z = z1 * cc + w1 * sc;

  return [w, x, y, z];
}
