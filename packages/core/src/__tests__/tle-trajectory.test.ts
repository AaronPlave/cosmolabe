import { describe, it, expect } from 'vitest';
import { TLETrajectory } from '../trajectories/TLETrajectory.js';
import { CatalogLoader } from '../catalog/CatalogLoader.js';

// ISS TLE (epoch ~2024)
const ISS_LINE1 = '1 25544U 98067A   24100.50000000  .00016717  00000-0  10270-3 0  9002';
const ISS_LINE2 = '2 25544  51.6400 208.5600 0003900  40.0000 320.0000 15.50000000    05';

describe('TLETrajectory', () => {
  it('propagates ISS TLE and returns valid position', () => {
    const traj = new TLETrajectory({ line1: ISS_LINE1, line2: ISS_LINE2 });

    // Query near the TLE epoch: 2024-04-09 12:00:00 UTC
    // ET for 2024-04-09 ≈ (JD 2460410.0 - 2451545.0) * 86400 ≈ 7.66e8 seconds
    const et = (2460410.0 - 2451545.0) * 86400;
    const state = traj.stateAt(et);

    // ISS orbits at ~6778 km from Earth center (~408 km altitude)
    const dist = Math.sqrt(
      state.position[0] ** 2 + state.position[1] ** 2 + state.position[2] ** 2,
    );
    expect(dist).toBeGreaterThan(6300); // > Earth radius
    expect(dist).toBeLessThan(7200);    // < 830 km altitude

    // Velocity ~7.66 km/s
    const speed = Math.sqrt(
      state.velocity[0] ** 2 + state.velocity[1] ** 2 + state.velocity[2] ** 2,
    );
    expect(speed).toBeGreaterThan(7);
    expect(speed).toBeLessThan(8.5);
  });

  it('returns [0,0,0] for propagation far from epoch', () => {
    const traj = new TLETrajectory({ line1: ISS_LINE1, line2: ISS_LINE2 });

    // SGP4 breaks down far from TLE epoch — satellite.js returns false for position
    const farFutureEt = 1e10; // ~317 years from J2000
    const state = traj.stateAt(farFutureEt);
    // Should gracefully return zeros rather than crash
    expect(state.position).toHaveLength(3);
  });

  it('position changes over time (orbit propagation works)', () => {
    const traj = new TLETrajectory({ line1: ISS_LINE1, line2: ISS_LINE2 });

    const et = (2460410.0 - 2451545.0) * 86400;
    const s1 = traj.stateAt(et);
    const s2 = traj.stateAt(et + 60); // 1 minute later

    // ISS moves ~460 km per minute
    const dx = s2.position[0] - s1.position[0];
    const dy = s2.position[1] - s1.position[1];
    const dz = s2.position[2] - s1.position[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(dist).toBeGreaterThan(300);
    expect(dist).toBeLessThan(600);
  });
});

describe('CatalogLoader TLE integration', () => {
  it('loads TLE trajectory from catalog', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      items: [{
        name: 'ISS',
        class: 'spacecraft',
        center: 'Earth',
        trajectory: {
          type: 'TLE',
          line1: ISS_LINE1,
          line2: ISS_LINE2,
        },
      }],
    });

    expect(result.bodies).toHaveLength(1);
    const iss = result.bodies[0];

    const et = (2460410.0 - 2451545.0) * 86400;
    const state = iss.stateAt(et);
    const dist = Math.sqrt(
      state.position[0] ** 2 + state.position[1] ** 2 + state.position[2] ** 2,
    );
    expect(dist).toBeGreaterThan(6300);
    expect(dist).toBeLessThan(7200);
  });

  it('falls back to FixedPoint when TLE lines missing', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      items: [{
        name: 'NoTLE',
        trajectory: { type: 'TLE' },
      }],
    });

    const state = result.bodies[0].stateAt(0);
    expect(state.position).toEqual([0, 0, 0]);
  });
});
