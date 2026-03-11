import { describe, it, expect } from 'vitest';
import { CatalogLoader } from '../catalog/CatalogLoader.js';

describe('CatalogLoader', () => {
  it('loads simple FixedPoint bodies', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      name: 'test',
      items: [
        { name: 'A', trajectory: { type: 'FixedPoint', position: [1, 2, 3] } },
        { name: 'B', trajectory: { type: 'FixedPoint', position: [4, 5, 6] } },
      ],
    });

    expect(result.bodies.length).toBe(2);
    expect(result.bodies[0].stateAt(0).position).toEqual([1, 2, 3]);
    expect(result.bodies[1].stateAt(0).position).toEqual([4, 5, 6]);
  });

  it('loads Keplerian trajectory', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      items: [
        {
          name: 'Satellite',
          trajectory: {
            type: 'Keplerian',
            semiMajorAxis: 7000,
            eccentricity: 0,
            inclination: 0,
            ascendingNode: 0,
            argOfPeriapsis: 0,
            meanAnomaly: 0,
          },
        },
      ],
    });

    expect(result.bodies.length).toBe(1);
    // Should be at periapsis (7000, 0, 0)
    const pos = result.bodies[0].stateAt(0).position;
    expect(pos[0]).toBeCloseTo(7000, 0);
  });

  it('loads nested items with parent references', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      items: [
        {
          name: 'Sun',
          trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
          items: [
            { name: 'Earth', trajectory: { type: 'FixedPoint', position: [1, 0, 0] } },
          ],
        },
      ],
    });

    expect(result.bodies.length).toBe(2);
    const earth = result.bodies.find(b => b.name === 'Earth');
    expect(earth?.parentName).toBe('Sun');
  });

  it('handles distance units', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      items: [
        {
          name: 'FarAway',
          trajectory: { type: 'FixedPoint', position: [1, 0, 0], distanceUnits: 'au' },
        },
      ],
    });

    const pos = result.bodies[0].stateAt(0).position;
    expect(pos[0]).toBeCloseTo(149597870.7, 0);
  });

  it('skips non-body item types', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      items: [
        { name: 'View1', type: 'Viewpoint' },
        { name: 'Body1', trajectory: { type: 'FixedPoint', position: [1, 0, 0] } },
      ],
    });

    expect(result.bodies.length).toBe(1);
    expect(result.bodies[0].name).toBe('Body1');
  });

  it('handles Composite trajectory', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      items: [
        {
          name: 'Craft',
          trajectory: {
            type: 'Composite',
            arcs: [
              {
                trajectory: { type: 'FixedPoint', position: [100, 0, 0] },
                startTime: '2000-01-01T12:00:00',
                endTime: '2000-06-01T12:00:00',
              },
              {
                trajectory: { type: 'FixedPoint', position: [200, 0, 0] },
                startTime: '2000-06-01T12:00:00',
                endTime: '2001-01-01T12:00:00',
              },
            ],
          },
        },
      ],
    });

    expect(result.bodies.length).toBe(1);
  });

  it('loads rotation model', () => {
    const loader = new CatalogLoader();
    const result = loader.load({
      items: [
        {
          name: 'Planet',
          trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
          rotationModel: {
            type: 'Uniform',
            period: 86400,
            meridianAngle: 0,
            ascension: 0,
            declination: 90,
          },
        },
      ],
    });

    const body = result.bodies[0];
    expect(body.rotation).toBeDefined();
    const q = body.rotationAt(0);
    expect(q).toBeDefined();
  });
});
