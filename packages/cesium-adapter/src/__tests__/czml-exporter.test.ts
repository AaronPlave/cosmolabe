import { describe, it, expect } from 'vitest';
import { Universe, Body, CatalogLoader } from '@spicecraft/core';
import { exportToCzml } from '../CzmlExporter.js';

describe('CzmlExporter', () => {
  function createTestUniverse(): Universe {
    const universe = new Universe();
    const loader = new CatalogLoader();
    const result = loader.load({
      name: 'test',
      items: [
        {
          name: 'Sun',
          class: 'star',
          trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
        },
        {
          name: 'Earth',
          center: 'Sun',
          class: 'planet',
          trajectory: {
            type: 'Keplerian',
            semiMajorAxis: 149597870.7,
            eccentricity: 0.0167,
            inclination: 0,
            longitudeOfAscendingNode: 0,
            argOfPeriapsis: 102.9,
            meanAnomaly: 0,
            epoch: '2000-01-01T12:00:00Z',
          },
          geometry: {
            type: 'Globe',
          },
        },
        {
          name: 'Satellite',
          center: 'Earth',
          class: 'spacecraft',
          trajectory: {
            type: 'Keplerian',
            semiMajorAxis: 7000,
            eccentricity: 0.001,
            inclination: 51.6,
            longitudeOfAscendingNode: 0,
            argOfPeriapsis: 0,
            meanAnomaly: 0,
            epoch: '2000-01-01T12:00:00Z',
          },
          geometry: {
            type: 'Mesh',
            source: 'models/satellite.glb',
            size: 0.01,
          },
        },
      ],
    });
    for (const body of result.bodies) {
      universe.addBody(body);
    }
    return universe;
  }

  it('produces valid CZML with document packet first', () => {
    const universe = createTestUniverse();
    const czml = exportToCzml(universe, { startEt: 0, endEt: 3600, sampleInterval: 600 });

    expect(czml.length).toBeGreaterThan(0);
    expect(czml[0].id).toBe('document');
    expect(czml[0].version).toBe('1.0');
    expect(czml[0].clock).toBeDefined();
  });

  it('exports all bodies as packets', () => {
    const universe = createTestUniverse();
    const czml = exportToCzml(universe, { startEt: 0, endEt: 3600, sampleInterval: 600 });

    // document + Sun + Earth + Satellite = 4 packets
    expect(czml.length).toBe(4);
    const names = czml.slice(1).map(p => p.name);
    expect(names).toContain('Sun');
    expect(names).toContain('Earth');
    expect(names).toContain('Satellite');
  });

  it('includes position data in ICRF', () => {
    const universe = createTestUniverse();
    const czml = exportToCzml(universe, { startEt: 0, endEt: 3600, sampleInterval: 600 });

    const earthPacket = czml.find(p => p.name === 'Earth');
    expect(earthPacket).toBeDefined();
    const pos = earthPacket!.position as Record<string, unknown>;
    expect(pos.referenceFrame).toBe('INERTIAL');
    expect(pos.epoch).toBeDefined();
    expect(pos.cartesian).toBeDefined();
    expect(Array.isArray(pos.cartesian)).toBe(true);
    // Each sample is 4 values: [t, x, y, z]
    expect((pos.cartesian as number[]).length % 4).toBe(0);
  });

  it('positions are in meters (not km)', () => {
    const universe = createTestUniverse();
    const czml = exportToCzml(universe, { startEt: 0, endEt: 60, sampleInterval: 60 });

    const earthPacket = czml.find(p => p.name === 'Earth');
    const cartesian = (earthPacket!.position as Record<string, unknown>).cartesian as number[];
    // Earth is ~1 AU from Sun = ~149,597,870 km = ~1.496e11 m
    // X position (index 1) should be on the order of 1e11
    const x = Math.abs(cartesian[1]);
    expect(x).toBeGreaterThan(1e10); // at least 10 billion meters
  });

  it('includes model for glTF bodies', () => {
    const universe = createTestUniverse();
    const czml = exportToCzml(universe, { startEt: 0, endEt: 3600, sampleInterval: 600 });

    const satPacket = czml.find(p => p.name === 'Satellite');
    expect(satPacket!.model).toBeDefined();
    const model = satPacket!.model as Record<string, unknown>;
    expect(model.gltf).toBe('models/satellite.glb');
    expect(model.scale).toBeDefined();
  });

  it('includes point for bodies without models', () => {
    const universe = createTestUniverse();
    const czml = exportToCzml(universe, { startEt: 0, endEt: 3600, sampleInterval: 600 });

    const sunPacket = czml.find(p => p.name === 'Sun');
    expect(sunPacket!.point).toBeDefined();
    expect(sunPacket!.model).toBeUndefined();
  });

  it('supports centerBody for relative positions', () => {
    const universe = createTestUniverse();
    const czml = exportToCzml(universe, {
      startEt: 0,
      endEt: 60,
      sampleInterval: 60,
      centerBody: 'Earth',
    });

    const satPacket = czml.find(p => p.name === 'Satellite');
    const cartesian = (satPacket!.position as Record<string, unknown>).cartesian as number[];
    // Satellite orbits at 7000 km = 7e6 m from Earth
    const x = Math.abs(cartesian[1]);
    const y = Math.abs(cartesian[2]);
    const z = Math.abs(cartesian[3]);
    const dist = Math.sqrt(x * x + y * y + z * z);
    expect(dist).toBeGreaterThan(5e6);  // > 5000 km in meters
    expect(dist).toBeLessThan(1e7);     // < 10000 km in meters
  });

  it('respects showPaths and showLabels options', () => {
    const universe = createTestUniverse();
    const czmlWithout = exportToCzml(universe, {
      startEt: 0,
      endEt: 3600,
      sampleInterval: 600,
      showPaths: false,
      showLabels: false,
    });

    const earthPacket = czmlWithout.find(p => p.name === 'Earth');
    expect(earthPacket!.path).toBeUndefined();
    expect(earthPacket!.label).toBeUndefined();
  });

  it('includes clock in document packet', () => {
    const universe = createTestUniverse();
    const czml = exportToCzml(universe, { startEt: 0, endEt: 86400 });

    const clock = czml[0].clock as Record<string, unknown>;
    expect(clock.interval).toBeDefined();
    expect(clock.currentTime).toBeDefined();
    expect(typeof clock.interval).toBe('string');
    expect((clock.interval as string)).toContain('/');
  });
});
