import type { Vec3 } from '@cosmolabe/spice';
import type { CartesianState, Trajectory } from './Trajectory.js';

export interface Waypoint {
  /** ET seconds (J2000 TDB). Use the loader to convert UTC strings or epoch+offset. */
  et: number;
  latDeg: number;
  lonDeg: number;
  /** Altitude above the reference radius, in km. */
  altKm: number;
}

/**
 * A body-fixed trajectory expressed as a small list of (lat, lon, alt) keyframes.
 *
 * Output positions are body-fixed Cartesian with radius = referenceRadius + alt.
 * The catalog must set the body's `trajectoryFrame` to "BodyFixed" so the
 * Universe rotates samples by the parent's rotation conjugate before stacking
 * the parent's inertial position.
 *
 * Interpolation uses C¹ cubic Hermite splines with centered-difference tangents.
 * Linear interpolation made position continuous but velocity discontinuous at
 * each waypoint (visible as kinks in motion and a stop-and-go feel during
 * hovers); the cubic eases through each waypoint with continuous velocity.
 */
export class WaypointTrajectory implements Trajectory {
  private readonly samples: Array<{ et: number; pos: Vec3; vel: Vec3; tangent: Vec3 }>;
  /** The original (lat, lon, alt, et) waypoints — exposed so the renderer can
   *  pre-sample terrain along the path for smooth above-terrain altitude. */
  readonly waypoints: ReadonlyArray<Waypoint>;
  readonly referenceRadiusKm: number;
  /**
   * When true, the body's altitudes are absolute (km above referenceRadiusKm)
   * — the renderer must NOT apply surfaceLock terrain adjustment to this body
   * even if its geometry has `surfaceLock: aboveTerrain`. Use this for long
   * flights where terrain pre-sampling isn't reliable (tiles not all loaded),
   * with absolute altitudes pre-computed from an offline DEM.
   */
  readonly useAbsoluteAlt: boolean;
  readonly startTime: number;
  readonly endTime: number;

  constructor(waypoints: Waypoint[], referenceRadiusKm: number, opts?: { useAbsoluteAlt?: boolean }) {
    if (waypoints.length < 2) {
      throw new Error('WaypointTrajectory requires at least 2 waypoints');
    }
    const sorted = [...waypoints].sort((a, b) => a.et - b.et);
    this.waypoints = sorted;
    this.referenceRadiusKm = referenceRadiusKm;
    this.useAbsoluteAlt = opts?.useAbsoluteAlt === true;
    this.startTime = sorted[0].et;
    this.endTime = sorted[sorted.length - 1].et;

    const pts = sorted.map(w => {
      const lat = w.latDeg * Math.PI / 180;
      const lon = w.lonDeg * Math.PI / 180;
      const r = referenceRadiusKm + w.altKm;
      return {
        et: w.et,
        pos: [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)] as Vec3,
      };
    });

    // Hermite tangents: centered finite difference for interior points, one-sided
    // at the endpoints. Tangent is the "instantaneous velocity" the curve should
    // have when it passes through this waypoint, in km/s.
    this.samples = pts.map((p, i) => {
      const prev = pts[i - 1] ?? p;
      const next = pts[i + 1] ?? p;
      const dt = Math.max(next.et - prev.et, 1e-9);
      const tangent: Vec3 = [
        (next.pos[0] - prev.pos[0]) / dt,
        (next.pos[1] - prev.pos[1]) / dt,
        (next.pos[2] - prev.pos[2]) / dt,
      ];
      return { et: p.et, pos: p.pos, vel: tangent, tangent };
    });
  }

  stateAt(et: number): CartesianState {
    const s = this.samples;
    if (et <= s[0].et) return { position: [...s[0].pos] as Vec3, velocity: [...s[0].tangent] as Vec3 };
    if (et >= s[s.length - 1].et) {
      const last = s[s.length - 1];
      return { position: [...last.pos] as Vec3, velocity: [...last.tangent] as Vec3 };
    }

    let i = 0;
    while (i < s.length - 1 && et > s[i + 1].et) i++;
    const a = s[i];
    const b = s[i + 1];
    const dt = b.et - a.et;
    const u = (et - a.et) / dt;
    const u2 = u * u;
    const u3 = u2 * u;

    // Cubic Hermite basis functions
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;

    // Derivative basis (for velocity): du-derivative scaled by 1/dt to get d/dt
    const dh00 = (6 * u2 - 6 * u);
    const dh10 = (3 * u2 - 4 * u + 1);
    const dh01 = (-6 * u2 + 6 * u);
    const dh11 = (3 * u2 - 2 * u);

    const position: Vec3 = [
      h00 * a.pos[0] + h10 * dt * a.tangent[0] + h01 * b.pos[0] + h11 * dt * b.tangent[0],
      h00 * a.pos[1] + h10 * dt * a.tangent[1] + h01 * b.pos[1] + h11 * dt * b.tangent[1],
      h00 * a.pos[2] + h10 * dt * a.tangent[2] + h01 * b.pos[2] + h11 * dt * b.tangent[2],
    ];
    const velocity: Vec3 = [
      (dh00 * a.pos[0] + dh01 * b.pos[0]) / dt + dh10 * a.tangent[0] + dh11 * b.tangent[0],
      (dh00 * a.pos[1] + dh01 * b.pos[1]) / dt + dh10 * a.tangent[1] + dh11 * b.tangent[1],
      (dh00 * a.pos[2] + dh01 * b.pos[2]) / dt + dh10 * a.tangent[2] + dh11 * b.tangent[2],
    ];
    return { position, velocity };
  }
}
