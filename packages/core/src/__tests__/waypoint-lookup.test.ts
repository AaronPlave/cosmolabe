import { describe, expect, it } from 'vitest';
import { WaypointTrajectory } from '../trajectories/WaypointTrajectory.js';

describe('dense waypoint lookup', () => {
  it('retains every knot and Hermite midpoint under reverse scrubbing and irregular spacing', () => {
    const points = Array.from({ length: 4097 }, (_, i) => ({ et: i + i * i / 4096,
      latDeg: 0, lonDeg: 0, altKm: Math.sin(i / 31) }));
    const path = new WaypointTrajectory(points, 100);
    const tangent = (i: number) => {
      const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
      return (b.altKm - a.altKm) / (b.et - a.et);
    };
    for (let i = points.length - 2; i >= 0; i--) {
      const a = points[i], b = points[i + 1], dt = b.et - a.et;
      expect(path.stateAt(a.et).position).toEqual([100 + a.altKm, 0, 0]);
      const middle = path.stateAt((a.et + b.et) / 2);
      expect(middle.position[0]).toBeCloseTo(100 + (a.altKm + b.altKm) / 2 + dt * (tangent(i) - tangent(i + 1)) / 8, 11);
      expect(middle.velocity[0]).toBeCloseTo(1.5 * (b.altKm - a.altKm) / dt - (tangent(i) + tangent(i + 1)) / 4, 11);
    }
    expect(path.stateAt(-Infinity)).toEqual(path.stateAt(points[0].et));
    expect(path.stateAt(Infinity)).toEqual(path.stateAt(points.at(-1)!.et));
  });

  it('selects the preceding interval at duplicate interior knot times', () => {
    const path = new WaypointTrajectory([0, 1, 1, 2].map((et, i) => ({ et, latDeg: 0, lonDeg: 0, altKm: i })), 100);
    expect(path.stateAt(1).position).toEqual([101, 0, 0]);
    expect(path.stateAt(1 + 1e-8).position[0]).toBeCloseTo(102, 6);
  });
});
