import { describe, it, expect } from 'vitest';
import { CatalogLoader } from '../catalog/CatalogLoader.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';
import { FixedRotation } from '../rotations/FixedRotation.js';
import { FixedEulerRotation } from '../rotations/FixedEulerRotation.js';
import { InterpolatedRotation, parseQFile } from '../rotations/InterpolatedRotation.js';

// ─── FixedSpherical Trajectory ────────────────────────────────────────────

describe('FixedSpherical trajectory', () => {
  it('converts lat/lon/radius to Cartesian (Tvashtar on Io)', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'Tvashtar',
        center: 'Io',
        trajectory: {
          type: 'FixedSpherical',
          latitude: 62.76,
          longitude: -123.53,
          radius: 1820,
        },
      }],
    };

    const loader = new CatalogLoader();
    const result = loader.load(catalog);
    const body = result.bodies[0];

    const state = body.stateAt(0);
    const [x, y, z] = state.position;
    // Verify radius is preserved: sqrt(x² + y² + z²) ≈ 1820
    const r = Math.sqrt(x * x + y * y + z * z);
    expect(r).toBeCloseTo(1820, 1);

    // Verify latitude: z = r * sin(lat)
    const latRad = Math.asin(z / r);
    expect(latRad * 180 / Math.PI).toBeCloseTo(62.76, 1);

    // Verify longitude: atan2(y, x)
    const lonRad = Math.atan2(y, x);
    expect(lonRad * 180 / Math.PI).toBeCloseTo(-123.53, 1);

    // Velocity should be zero (fixed point)
    expect(state.velocity).toEqual([0, 0, 0]);
  });

  it('handles zero lat/lon (equator, prime meridian)', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'Point',
        trajectory: { type: 'FixedSpherical', latitude: 0, longitude: 0, radius: 100 },
      }],
    };
    const result = new CatalogLoader().load(catalog);
    const [x, y, z] = result.bodies[0].stateAt(0).position;
    expect(x).toBeCloseTo(100, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  it('handles north pole (lat=90)', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'NorthPole',
        trajectory: { type: 'FixedSpherical', latitude: 90, longitude: 0, radius: 6371 },
      }],
    };
    const result = new CatalogLoader().load(catalog);
    const [x, y, z] = result.bodies[0].stateAt(0).position;
    expect(x).toBeCloseTo(0, 2);
    expect(y).toBeCloseTo(0, 2);
    expect(z).toBeCloseTo(6371, 1);
  });

  it('applies distanceUnits scaling', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'Point',
        trajectory: { type: 'FixedSpherical', latitude: 0, longitude: 0, radius: 1, distanceUnits: 'au' },
      }],
    };
    const result = new CatalogLoader().load(catalog);
    const [x] = result.bodies[0].stateAt(0).position;
    expect(x).toBeCloseTo(149597870.7, 0); // 1 AU in km
  });
});

// ─── Fixed Rotation Model ─────────────────────────────────────────────────

describe('Fixed rotation model', () => {
  it('returns constant quaternion from explicit spec', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'HST',
        center: 'Earth',
        trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        rotationModel: {
          type: 'Fixed',
          quaternion: [0.91355, -0.40674, 0.0, 0.0],
        },
      }],
    };
    const result = new CatalogLoader().load(catalog);
    const body = result.bodies[0];

    const q0 = body.rotationAt(0)!;
    expect(q0[0]).toBeCloseTo(0.91355, 4);
    expect(q0[1]).toBeCloseTo(-0.40674, 4);
    expect(q0[2]).toBeCloseTo(0, 5);
    expect(q0[3]).toBeCloseTo(0, 5);

    // Same quaternion at any time
    const q1 = body.rotationAt(86400)!;
    expect(q1[0]).toBeCloseTo(q0[0], 10);
    expect(q1[1]).toBeCloseTo(q0[1], 10);
  });

  it('composes pole angles (inclination/ascendingNode/meridianAngle)', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'Body',
        trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        rotationModel: {
          type: 'Fixed',
          inclination: 90,
          ascendingNode: 0,
          meridianAngle: 0,
        },
      }],
    };
    const result = new CatalogLoader().load(catalog);
    const q = result.bodies[0].rotationAt(0)!;

    // Rz(0) * Rx(90°) * Rz(0) = Rx(90°) = [cos(45°), sin(45°), 0, 0]
    expect(q[0]).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    expect(q[1]).toBeCloseTo(Math.sin(Math.PI / 4), 5);
    expect(q[2]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(0, 5);
  });

  it('identity when no quaternion and no angles', () => {
    const rotation = FixedRotation.fromPoleAngles(0, 0, 0);
    const q = rotation.rotationAt(0);
    expect(q[0]).toBeCloseTo(1, 5);
    expect(q[1]).toBeCloseTo(0, 5);
    expect(q[2]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(0, 5);
  });
});

// ─── FixedEuler Rotation Model ────────────────────────────────────────────

describe('FixedEuler rotation model', () => {
  it('composes XYZ Euler sequence from catalog', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'Probe',
        trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        rotationModel: {
          type: 'FixedEuler',
          sequence: 'XYZ',
          angles: [90, 0, 0],
        },
      }],
    };
    const result = new CatalogLoader().load(catalog);
    const q = result.bodies[0].rotationAt(0)!;

    // Rx(90°) = [cos(45°), sin(45°), 0, 0]
    expect(q[0]).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    expect(q[1]).toBeCloseTo(Math.sin(Math.PI / 4), 5);
    expect(q[2]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(0, 5);
  });

  it('composes ZXZ Euler sequence', () => {
    const rot = new FixedEulerRotation('ZXZ', [90, 45, 30]);
    const q = rot.rotationAt(0);
    // Just verify it's a unit quaternion
    const norm = Math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2);
    expect(norm).toBeCloseTo(1, 5);
  });

  it('identity with zero angles', () => {
    const rot = new FixedEulerRotation('XYZ', [0, 0, 0]);
    const q = rot.rotationAt(0);
    expect(q[0]).toBeCloseTo(1, 5);
  });

  it('returns undefined when sequence/angles missing', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'Bad',
        trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        rotationModel: { type: 'FixedEuler' },
      }],
    };
    const result = new CatalogLoader().load(catalog);
    expect(result.bodies[0].rotation).toBeUndefined();
  });
});

// ─── Interpolated Rotation Model ──────────────────────────────────────────

describe('Interpolated rotation model', () => {
  describe('parseQFile', () => {
    it('parses .q file format with JD timestamps', () => {
      const text = `# Test quaternion file
# JD w x y z
2451545.0  1.0 0.0 0.0 0.0
2451546.0  0.7071067811865476 0.7071067811865476 0.0 0.0
2451547.0  0.0 1.0 0.0 0.0
`;
      const records = parseQFile(text);
      expect(records).toHaveLength(3);

      // First record: JD 2451545.0 = ET 0
      expect(records[0].et).toBeCloseTo(0, 0);
      expect(records[0].q).toEqual([1, 0, 0, 0]);

      // Second record: JD 2451546.0 = ET 86400
      expect(records[1].et).toBeCloseTo(86400, 0);
      expect(records[1].q[0]).toBeCloseTo(0.7071, 3);
    });

    it('skips comments and blank lines', () => {
      const text = `# comment
2451545.0  1.0 0.0 0.0 0.0

# another comment
2451546.0  0.0 1.0 0.0 0.0
`;
      const records = parseQFile(text);
      expect(records).toHaveLength(2);
    });
  });

  describe('InterpolatedRotation', () => {
    it('returns first record before start time', () => {
      const rot = new InterpolatedRotation([
        { et: 100, q: [1, 0, 0, 0] },
        { et: 200, q: [0, 1, 0, 0] },
      ]);
      const q = rot.rotationAt(0);
      expect(q[0]).toBeCloseTo(1, 5);
      expect(q[1]).toBeCloseTo(0, 5);
    });

    it('returns last record after end time', () => {
      const rot = new InterpolatedRotation([
        { et: 100, q: [1, 0, 0, 0] },
        { et: 200, q: [0, 1, 0, 0] },
      ]);
      const q = rot.rotationAt(1000);
      expect(q[0]).toBeCloseTo(0, 5);
      expect(q[1]).toBeCloseTo(1, 5);
    });

    it('SLERPs between records at midpoint', () => {
      const rot = new InterpolatedRotation([
        { et: 0, q: [1, 0, 0, 0] },       // Identity
        { et: 100, q: [0, 0, 0, 1] },     // 180° around Z
      ]);
      const q = rot.rotationAt(50); // Midpoint → 90° around Z
      // SLERP midpoint of identity and 180°Z = 90° around Z = [cos(45°), 0, 0, sin(45°)]
      expect(q[0]).toBeCloseTo(Math.cos(Math.PI / 4), 3);
      expect(q[3]).toBeCloseTo(Math.sin(Math.PI / 4), 3);
      expect(q[1]).toBeCloseTo(0, 5);
      expect(q[2]).toBeCloseTo(0, 5);
    });

    it('identity when empty', () => {
      const rot = new InterpolatedRotation([]);
      const q = rot.rotationAt(0);
      expect(q).toEqual([1, 0, 0, 0]);
    });
  });

  it('loads via CatalogLoader with resolveFile', () => {
    const qFileContent = `# attitude data
2451545.0  1.0 0.0 0.0 0.0
2451545.5  0.7071067811865476 0.0 0.0 0.7071067811865476
2451546.0  0.0 0.0 0.0 1.0
`;
    const loader = new CatalogLoader({
      resolveFile: (source: string) => source === 'attitude.q' ? qFileContent : undefined,
    });
    const result = loader.load({
      items: [{
        name: 'Probe',
        trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        rotationModel: { type: 'Interpolated', source: 'attitude.q' },
      }],
    });

    const body = result.bodies[0];
    expect(body.rotation).toBeDefined();

    // At ET=0 (JD 2451545.0), should return first record
    const q0 = body.rotationAt(0)!;
    expect(q0[0]).toBeCloseTo(1, 3);

    // At ET=86400 (JD 2451546.0), should return last record
    const q2 = body.rotationAt(86400)!;
    expect(q2[0]).toBeCloseTo(0, 3);
    expect(q2[3]).toBeCloseTo(1, 3);
  });
});

// ─── ParticleSystem Geometry ──────────────────────────────────────────────

describe('ParticleSystem geometry', () => {
  it('creates body for ParticleSystem items (no longer skips them)', () => {
    const catalog: CatalogJson = {
      items: [
        {
          name: 'Comet',
          center: 'Sun',
          trajectory: { type: 'FixedPoint', position: [1, 0, 0] },
          geometry: { type: 'Globe', radius: 10 },
        },
        {
          name: 'Comet Tail',
          center: 'Comet',
          geometry: {
            type: 'ParticleSystem',
            emitters: [{
              texture: 'gaussian.jpg',
              spawnRate: 5,
              lifetime: 400,
            }],
          },
        },
      ],
    };

    const loader = new CatalogLoader();
    const result = loader.load(catalog);

    // Both items should be loaded (ParticleSystem no longer skipped)
    expect(result.bodies).toHaveLength(2);

    const tail = result.bodies.find(b => b.name === 'Comet Tail')!;
    expect(tail).toBeDefined();
    expect(tail.parentName).toBe('Comet');
    expect(tail.geometryType).toBe('ParticleSystem');
    expect(tail.geometryData).toBeDefined();

    // ParticleSystem without trajectory gets FixedPoint at origin
    const state = tail.stateAt(0);
    expect(state.position).toEqual([0, 0, 0]);
  });

  it('preserves emitter configuration in geometryData', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'Tvashtar Plume',
        center: 'Io',
        geometry: {
          type: 'ParticleSystem',
          emitters: [{
            texture: 'gaussian.jpg',
            generator: { type: 'Box', center: [0, 0, 0], sides: [3, 3, 3] },
            force: [0, 0, -0.005],
            spawnRate: 5,
            lifetime: 400,
            startSize: 1,
            endSize: 7,
            colors: ['#5566ff', 0.2, '#5566ff', 0.4, '#5566ff', 0.0],
          }],
        },
      }],
    };

    const result = new CatalogLoader().load(catalog);
    const body = result.bodies[0];
    expect(body.geometryData?.emitters).toBeDefined();
    const emitters = body.geometryData!.emitters as unknown[];
    expect(emitters).toHaveLength(1);
  });

  it('ParticleSystem with trajectory uses that trajectory', () => {
    const catalog: CatalogJson = {
      items: [{
        name: 'Plume',
        center: 'Io',
        trajectory: {
          type: 'FixedSpherical',
          latitude: 62.76,
          longitude: -123.53,
          radius: 1820,
        },
        geometry: { type: 'ParticleSystem' },
      }],
    };
    const result = new CatalogLoader().load(catalog);
    const body = result.bodies[0];
    const r = Math.sqrt(
      body.stateAt(0).position[0] ** 2 +
      body.stateAt(0).position[1] ** 2 +
      body.stateAt(0).position[2] ** 2
    );
    expect(r).toBeCloseTo(1820, 1);
  });
});
