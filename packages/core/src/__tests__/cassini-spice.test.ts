/**
 * Full-stack Cassini integration test:
 * Real SPICE kernels + Catalog JSON → Universe → query body positions
 *
 * Uses Cassini SOI (Saturn Orbit Insertion, 2004-07-01) SCPSE kernel
 * which includes Cassini, Saturn, and satellite ephemerides.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '@spicecraft/spice';
import { Universe } from '../Universe.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';

const KERNEL_DIR = join(__dirname, '../../../spice/test-kernels');
const CASSINI_DIR = join(KERNEL_DIR, 'cassini');

const CASSINI_SOI_CATALOG: CatalogJson = {
  name: 'Cassini SOI Test',
  items: [
    {
      name: 'Sun',
      class: 'star',
      trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
      geometry: { type: 'Globe', radius: 695000 },
    },
    {
      name: 'Saturn',
      class: 'planet',
      center: 'Sun',
      trajectory: { type: 'Builtin', name: 'Saturn' },
      geometry: { type: 'Globe', radii: [60268, 60268, 54364] },
      items: [
        {
          name: 'Titan',
          class: 'moon',
          center: 'Saturn',
          trajectory: { type: 'Builtin', name: 'Titan' },
          geometry: { type: 'Globe', radius: 2575 },
        },
        {
          name: 'Enceladus',
          class: 'moon',
          center: 'Saturn',
          trajectory: { type: 'Builtin', name: 'Enceladus' },
          geometry: { type: 'Globe', radius: 252 },
        },
        {
          name: 'Cassini',
          class: 'spacecraft',
          center: 'Saturn',
          trajectoryFrame: 'J2000',
          trajectory: {
            type: 'Spice',
            target: 'CASSINI',
            center: 'SATURN',
          },
          items: [
            {
              name: 'ISS NAC',
              class: 'instrument',
              center: 'Cassini',
              trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
              geometry: {
                type: 'Sensor',
                target: 'Saturn',
                shape: 'rectangular',
                horizontalFov: 0.35,
                verticalFov: 0.35,
                range: 200000,
                frustumColor: [0.2, 0.6, 1.0],
                frustumOpacity: 0.3,
              },
            },
          ],
        },
      ],
    },
  ],
};

describe('Cassini full-stack integration (SPICE + Catalog + Universe)', () => {
  let spice: Spice;
  let universe: Universe;

  beforeAll(async () => {
    spice = await Spice.init();

    // Standard kernels
    await spice.furnish({ type: 'buffer', data: readFileSync(join(KERNEL_DIR, 'naif0012.tls')).buffer, filename: 'naif0012.tls' });
    await spice.furnish({ type: 'buffer', data: readFileSync(join(KERNEL_DIR, 'pck00010.tpc')).buffer, filename: 'pck00010.tpc' });

    // Cassini kernels
    await spice.furnish({ type: 'buffer', data: readFileSync(join(CASSINI_DIR, 'cas_v43.tf')).buffer, filename: 'cas_v43.tf' });
    await spice.furnish({ type: 'buffer', data: readFileSync(join(CASSINI_DIR, 'cas00172.tsc')).buffer, filename: 'cas00172.tsc' });
    await spice.furnish({ type: 'buffer', data: readFileSync(join(CASSINI_DIR, 'cas_iss_v10.ti')).buffer, filename: 'cas_iss_v10.ti' });
    await spice.furnish({ type: 'buffer', data: readFileSync(join(CASSINI_DIR, '040629AP_SCPSE_04179_04185.bsp')).buffer, filename: '040629AP_SCPSE_04179_04185.bsp' });

    universe = new Universe(spice);
    universe.loadCatalog(CASSINI_SOI_CATALOG);
  }, 30000);

  it('loads all bodies from catalog', () => {
    const bodies = universe.getAllBodies();
    const names = bodies.map(b => b.name).sort();
    expect(names).toEqual(['Cassini', 'Enceladus', 'ISS NAC', 'Saturn', 'Sun', 'Titan']);
  });

  it('Cassini parent is Saturn', () => {
    const cassini = universe.getBody('Cassini')!;
    expect(cassini.parentName).toBe('Saturn');
    expect(cassini.classification).toBe('spacecraft');
  });

  it('ISS NAC is a child of Cassini with Sensor geometry', () => {
    const nac = universe.getBody('ISS NAC')!;
    expect(nac.parentName).toBe('Cassini');
    expect(nac.geometryType).toBe('Sensor');
    expect(nac.geometryData).toMatchObject({
      target: 'Saturn',
      shape: 'rectangular',
      horizontalFov: 0.35,
      verticalFov: 0.35,
    });
  });

  it('Cassini SPICE trajectory returns valid position at SOI', () => {
    const cassini = universe.getBody('Cassini')!;
    const et = spice.str2et('2004-07-01T02:48:00');
    const state = cassini.stateAt(et);

    // Position relative to Saturn (center)
    const dist = Math.sqrt(
      state.position[0] ** 2 + state.position[1] ** 2 + state.position[2] ** 2,
    );
    // At SOI, Cassini was ~80k-130k km from Saturn
    expect(dist).toBeGreaterThan(50_000);
    expect(dist).toBeLessThan(200_000);
  });

  it('Cassini position changes over time', () => {
    const cassini = universe.getBody('Cassini')!;
    const et1 = spice.str2et('2004-06-30T00:00:00');
    const et2 = spice.str2et('2004-07-02T00:00:00');
    const pos1 = cassini.stateAt(et1).position;
    const pos2 = cassini.stateAt(et2).position;

    // Positions should differ significantly (Cassini is moving fast at SOI)
    const dx = pos1[0] - pos2[0];
    const dy = pos1[1] - pos2[1];
    const dz = pos1[2] - pos2[2];
    const displacement = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(displacement).toBeGreaterThan(100_000); // > 100,000 km in 2 days
  });

  it('Titan and Enceladus have valid positions at SOI', () => {
    const titan = universe.getBody('Titan')!;
    const enceladus = universe.getBody('Enceladus')!;
    const et = spice.str2et('2004-07-01T00:00:00');

    const titanDist = Math.sqrt(
      titan.stateAt(et).position.reduce((s, v) => s + v * v, 0),
    );
    const enceladusDist = Math.sqrt(
      enceladus.stateAt(et).position.reduce((s, v) => s + v * v, 0),
    );

    // Titan ~1.2M km, Enceladus ~238k km from Saturn
    expect(titanDist).toBeGreaterThan(900_000);
    expect(titanDist).toBeLessThan(1_500_000);
    expect(enceladusDist).toBeGreaterThan(200_000);
    expect(enceladusDist).toBeLessThan(280_000);
  });

  it('getfov reads ISS NAC FOV from loaded kernels', () => {
    const fov = spice.getfov(-82360);
    expect(fov.shape).toBe('RECTANGLE');
    expect(fov.frame).toBe('CASSINI_ISS_NAC');
    // NAC is 0.35 x 0.35 deg (half-angle 0.175 deg)
    expect(fov.bounds).toHaveLength(4);
  });
});
