import type { Trajectory } from '../trajectories/Trajectory.js';
import type { Body } from '../Body.js';
import type { Quaternion, RotationModel } from './RotationModel.js';

/**
 * Orientation for a body sitting on (or hovering over) a parent body's surface.
 * The body's local +X axis always points "up" (radially outward from the
 * parent's center), regardless of how the parent rotates or where the body
 * moves on the parent's surface. Unlike `TrajectoryNadirRotation`, this does
 * NOT depend on the body's velocity — so it stays stable at hover and during
 * vertical climbs/descents.
 *
 *   +X = local "up" (radially outward)
 *   +Y = local "east" (= pole × up, normalized)
 *   +Z = local "north" (= up × east)
 *
 * Used for aircraft / landers / surface assets whose model is authored with
 * its vertical axis as local +X.
 */
export class SurfaceUpRotation implements RotationModel {
  constructor(
    private readonly trajectory: Trajectory,
    private readonly parent: Body,
  ) {}

  rotationAt(et: number): Quaternion {
    // Trajectory is body-fixed for surface bodies — position is already in the
    // parent's body-fixed frame, where the parent's pole = +Z.
    const { position } = this.trajectory.stateAt(et);
    const [px, py, pz] = position;
    const r = Math.sqrt(px * px + py * py + pz * pz);
    if (r < 1e-20) return [1, 0, 0, 0];

    // up = position / |position|  (in parent body-fixed frame)
    const ux = px / r, uy = py / r, uz = pz / r;

    // east = pole × up, normalized. pole in parent body-fixed = (0, 0, 1).
    let ex = -uy, ey = ux, ez = 0;
    const eLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (eLen < 1e-20) return [1, 0, 0, 0]; // body at the parent's pole
    ex /= eLen; ey /= eLen; ez /= eLen;

    // north = up × east
    const nx = uy * ez - uz * ey;
    const ny = uz * ex - ux * ez;
    const nz = ux * ey - uy * ex;

    // Rotation matrix M_pf2body whose rows are the body's axes expressed in
    // the parent's body-fixed frame. Apply M_pf2body to a parent-body-fixed
    // vector to get its coordinates in the body's frame.
    const m_pf2body = matToQuat(ux, uy, uz, ex, ey, ez, nx, ny, nz);

    // Compose with parent's rotation: parent maps inertial → parent body-fixed,
    // m_pf2body maps parent body-fixed → body. Together: inertial → body.
    const parentRot = this.parent.rotationAt(et);
    if (!parentRot) return m_pf2body;
    return quatMultiply(m_pf2body, parentRot);
  }
}

function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/** Convert 3×3 row-major rotation matrix to quaternion [w, x, y, z] (Shepperd's method) */
function matToQuat(
  m00: number, m01: number, m02: number,
  m10: number, m11: number, m12: number,
  m20: number, m21: number, m22: number,
): Quaternion {
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return [0.25 / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
}
