import { kernelArrayBuffer } from './_kernel-bytes.js';
/** Integration coverage on the supported frames adapter. */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHeritageSpice, type HeritageSpice } from '../index.js';

const KERNEL_DIR = join(__dirname, '../../../../kernels/test-data');
const CASSINI_DIR = join(KERNEL_DIR, 'cassini');

describe('Cassini SPICE integration', () => {
  let spice: HeritageSpice;

  // SOI epoch: 2004-07-01 ~02:48 UTC (ring plane crossing)
  const SOI_TIME = '2004-07-01T02:48:00';

  beforeAll(async () => {
    spice = await createHeritageSpice();

    // Standard kernels
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(readFileSync(join(KERNEL_DIR, 'naif0012.tls'))), filename: 'naif0012.tls' });
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(readFileSync(join(KERNEL_DIR, 'pck00010.tpc'))), filename: 'pck00010.tpc' });

    // Cassini kernels
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(readFileSync(join(CASSINI_DIR, 'cas_v43.tf'))), filename: 'cas_v43.tf' });
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(readFileSync(join(CASSINI_DIR, 'cas00172.tsc'))), filename: 'cas00172.tsc' });
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(readFileSync(join(CASSINI_DIR, 'cas_iss_v10.ti'))), filename: 'cas_iss_v10.ti' });
    await spice.furnish({ type: 'buffer', data: kernelArrayBuffer(readFileSync(join(CASSINI_DIR, '040629AP_SCPSE_04179_04185.bsp'))), filename: '040629AP_SCPSE_04179_04185.bsp' });
  }, 30000);

  // --- Body identification ---

  it('resolves Cassini NAIF ID', () => {
    expect(spice.bodn2c('CASSINI')).toBe(-82);
    expect(spice.bodc2n(-82)).toBe('CASSINI');
  });

  // --- Cassini position at SOI ---

  it('Cassini position relative to Saturn at SOI', () => {
    const et = spice.str2et(SOI_TIME);
    const { position } = spice.spkpos('CASSINI', et, 'J2000', 'NONE', 'SATURN');
    const dist = Math.sqrt(position[0] ** 2 + position[1] ** 2 + position[2] ** 2);

    // At SOI, Cassini was ~80,000-130,000 km from Saturn (inside the rings)
    expect(dist).toBeGreaterThan(50_000);
    expect(dist).toBeLessThan(200_000);
  });

  it('Cassini position relative to Sun at SOI', () => {
    const et = spice.str2et(SOI_TIME);
    const { position } = spice.spkpos('CASSINI', et, 'J2000', 'NONE', 'SUN');
    const distAU = Math.sqrt(position[0] ** 2 + position[1] ** 2 + position[2] ** 2) / 149_597_870.7;

    // Saturn is ~9.5 AU from Sun
    expect(distAU).toBeGreaterThan(8);
    expect(distAU).toBeLessThan(11);
  });

  // --- Saturn moons from SCPSE kernel ---

  it('Titan position relative to Saturn', () => {
    const et = spice.str2et(SOI_TIME);
    const { position } = spice.spkpos('TITAN', et, 'J2000', 'NONE', 'SATURN');
    const dist = Math.sqrt(position[0] ** 2 + position[1] ** 2 + position[2] ** 2);

    // Titan orbits at ~1.22 million km from Saturn
    expect(dist).toBeGreaterThan(900_000);
    expect(dist).toBeLessThan(1_500_000);
  });

  it('Enceladus position relative to Saturn', () => {
    const et = spice.str2et(SOI_TIME);
    const { position } = spice.spkpos('ENCELADUS', et, 'J2000', 'NONE', 'SATURN');
    const dist = Math.sqrt(position[0] ** 2 + position[1] ** 2 + position[2] ** 2);

    // Enceladus orbits at ~238,000 km from Saturn
    expect(dist).toBeGreaterThan(200_000);
    expect(dist).toBeLessThan(280_000);
  });

  // --- ISS instrument FOV ---

  it('getfov: ISS NAC has rectangular FOV with 0.35 deg full width', () => {
    const fov = spice.getfov(-82360);
    expect(fov.shape).toBe('RECTANGLE');
    expect(fov.frame).toBe('CASSINI_ISS_NAC');
    expect(fov.boresight[2]).toBeCloseTo(1, 8);
    expect(fov.bounds).toHaveLength(4);

    // NAC half-angle is 0.175 deg — verify boundary vectors
    const halfAngle = Math.atan2(
      Math.sqrt(fov.bounds[0][0] ** 2 + fov.bounds[0][1] ** 2),
      fov.bounds[0][2],
    );
    expect(halfAngle * 180 / Math.PI).toBeCloseTo(0.247, 1); // corner diagonal ~0.247 deg
  });

  it('getfov: ISS WAC has rectangular FOV with 3.48 deg full width', () => {
    const fov = spice.getfov(-82361);
    expect(fov.shape).toBe('RECTANGLE');
    expect(fov.frame).toBe('CASSINI_ISS_WAC');
    expect(fov.bounds).toHaveLength(4);

    // WAC half-angle is 1.74 deg
    const halfAngle = Math.atan2(
      Math.sqrt(fov.bounds[0][0] ** 2 + fov.bounds[0][1] ** 2),
      fov.bounds[0][2],
    );
    expect(halfAngle * 180 / Math.PI).toBeCloseTo(2.46, 0); // corner diagonal ~2.46 deg
  });

  // --- Orbital mechanics at SOI ---

  it('Cassini orbital elements around Saturn at SOI', () => {
    const et = spice.str2et(SOI_TIME);
    const { state } = spice.spkezr('CASSINI', et, 'J2000', 'NONE', 'SATURN');
    // Saturn GM (km³/s²)
    const mu = 37931207.8;
    const elts = spice.oscelt(state, et, mu);

    // SOI was a hyperbolic capture — eccentricity should be near 1 or >1
    // (actual insertion burn reduces it, but at this instant it's high)
    expect(elts.ecc).toBeGreaterThan(0.5);
  });

  // --- Frame transformations ---

  it('pxform: J2000 to IAU_SATURN rotation at SOI', () => {
    const et = spice.str2et(SOI_TIME);
    const rot = spice.pxform('J2000', 'IAU_SATURN', et);
    // 3x3 rotation matrix (9 elements)
    expect(rot).toHaveLength(9);
    // Verify it's a proper rotation (det ≈ 1)
    const det =
      rot[0] * (rot[4] * rot[8] - rot[5] * rot[7]) -
      rot[1] * (rot[3] * rot[8] - rot[5] * rot[6]) +
      rot[2] * (rot[3] * rot[7] - rot[4] * rot[6]);
    expect(det).toBeCloseTo(1, 6);
  });

  // fovray is outside the supported adapter API; see retirement coverage mapping.
  it('rejects the unsupported fovray entrypoint explicitly', () => {
    expect(() => spice.fovray('unused', [0, 0, 1], 'J2000', 'NONE', 'EARTH', 0))
      .toThrow(/not in the CSPICE WASM export allowlist/);
  });
});
