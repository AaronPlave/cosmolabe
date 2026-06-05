/**
 * Full-stack Cassini integration test:
 * Real SPICE kernels + Catalog JSON → Universe → query body positions
 *
 * Uses Cassini SOI (Saturn Orbit Insertion, 2004-07-01) SCPSE kernel
 * which includes Cassini, Saturn, and satellite ephemerides.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '@cosmolabe/spice';
import { Universe } from '../Universe.js';
import { alignPositionToFrame, type Vec3 } from '../kinematics.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';

const KERNEL_DIR = join(__dirname, '../../../spice/test-kernels');
const CASSINI_DIR = join(KERNEL_DIR, 'cassini');

// SOI reconstructed-attitude CK (2004 days 183–185 ≈ Jul 1–3). It's git-LFS;
// if the working copy only has the pointer (e.g. CI without LFS), skip the
// pointing test rather than furnishing a corrupt kernel. >100 KB ⇒ materialized.
const SOI_CK = join(CASSINI_DIR, '04183_04185ra.bc');
const HAS_SOI_CK = existsSync(SOI_CK) && statSync(SOI_CK).size > 100_000;

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
    // Attitude CK — only needed by the boresight-pointing test below. Skipped
    // (with that test) when only the LFS pointer is present.
    if (HAS_SOI_CK) {
      await spice.furnish({ type: 'buffer', data: readFileSync(SOI_CK).buffer, filename: '04183_04185ra.bc' });
    }

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

  // Regression guard for the Cassini ISS instrument boresight misaligning with
  // Titan by ~the J2000 obliquity. The renderer fetches instrument pointing via
  // pxform(fovFrame, sceneFrame, et) and renders it against scene positions that
  // `Universe.absolutePositionOf` always aligns into EclipticJ2000. So the
  // boresight MUST be fetched in ECLIPJ2000 — fetching it in J2000 (equatorial),
  // as the renderer wrongly did for `trajectoryFrame: "J2000"` parents like
  // Cassini, leaves the cone/PiP ~23.4° off the (ecliptic) scene.
  it.skipIf(!HAS_SOI_CK)(
    'ISS NAC boresight in ECLIPJ2000 (scene frame) matches the obliquity-rotated J2000 boresight',
    () => {
      // Inside the SOI CK coverage (days 183–185); day 184 = 2004-07-02.
      const et = spice.str2et('2004-07-02T00:00:00');

      // pxform returns a row-major instrument→frame rotation; its +Z column
      // (indices 2,5,8) is the boresight expressed in the target frame — the
      // same convention SensorFrustum / InstrumentView use to point the cone.
      const boresightIn = (frame: string): Vec3 => {
        const r = spice.pxform('CASSINI_ISS_NAC', frame, et);
        const v: Vec3 = [r[2], r[5], r[8]];
        const m = Math.hypot(v[0], v[1], v[2]);
        return [v[0] / m, v[1] / m, v[2] / m];
      };
      const angleDeg = (a: Vec3, b: Vec3): number => {
        const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
        return (Math.acos(dot) * 180) / Math.PI;
      };

      const bsEcl = boresightIn('ECLIPJ2000'); // correct: matches the scene
      const bsEqu = boresightIn('J2000'); // the stale (buggy) renderer choice

      // (1) Exact contract: SPICE's J2000→ECLIPJ2000 transform of the boresight
      // equals cosmolabe's own analytical obliquity (the rotation
      // absolutePositionOf applies to put the scene in EclipticJ2000). This is
      // what makes "fetch boresight in ECLIPJ2000" provably consistent with the
      // ecliptic scene positions.
      const bsEquAligned = alignPositionToFrame(bsEqu, 'EquatorJ2000', 'EclipticJ2000');
      expect(bsEquAligned[0]).toBeCloseTo(bsEcl[0], 9);
      expect(bsEquAligned[1]).toBeCloseTo(bsEcl[1], 9);
      expect(bsEquAligned[2]).toBeCloseTo(bsEcl[2], 9);

      // (2) Regression magnitude: rendering the J2000 boresight tuple directly
      // into the ecliptic scene (the bug) mis-points it from the correct
      // boresight by a significant, obliquity-bounded angle (≤ 23.4392911°,
      // reached only for a boresight ⊥ the equinox X-axis).
      const misPointDeg = angleDeg(bsEqu, bsEcl);
      expect(misPointDeg).toBeGreaterThan(1);
      expect(misPointDeg).toBeLessThanOrEqual(23.4392911 + 1e-6);

      // (3) User-visible symptom, in the actual ecliptic scene: the correct
      // (ECLIPJ2000) boresight and the buggy (J2000-rendered) boresight point in
      // materially different directions relative to Titan as the scene places it.
      const cassini = universe.absolutePositionOf('Cassini', et);
      const titan = universe.absolutePositionOf('Titan', et);
      const dirTitan: Vec3 = [
        titan[0] - cassini[0],
        titan[1] - cassini[1],
        titan[2] - cassini[2],
      ];
      const dt = Math.hypot(dirTitan[0], dirTitan[1], dirTitan[2]);
      const dirTitanN: Vec3 = [dirTitan[0] / dt, dirTitan[1] / dt, dirTitan[2] / dt];
      const sepCorrect = angleDeg(bsEcl, dirTitanN);
      const sepBuggy = angleDeg(bsEqu, dirTitanN);
      // The two separations differ by the boresight mis-pointing — the buggy
      // frame shifts where the cone appears to look relative to Titan.
      expect(Math.abs(sepCorrect - sepBuggy)).toBeGreaterThan(0.5);
    },
  );
});
