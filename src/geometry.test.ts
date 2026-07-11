// Validates the Phase 1 geometry surface of cspice-wasm against committed
// fixtures: body radii (bodvrd), instrument field of view (getfov), the
// sub-observer point (subpnt), and a surface intercept (sincpt). The fixtures are
// the Cassini ISS instrument kernel, a planetary constants kernel, and the bounded
// Cassini and de440 SPK subsets.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, type SpiceEngine } from './index.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

const CASSINI_ISS_NAC = -82360;
const ET_UTC = '2004-07-01T02:00:00';

describe('cspice-wasm geometry surface', () => {
  let spice: SpiceEngine;
  let et: number;

  beforeAll(async () => {
    spice = await createSpiceEngine();
    for (const k of [
      'naif0012.tls',
      'pck00011.tpc',
      'cas_iss_v10.ti',
      'de440s-inner-cassini.bsp',
      'cassini-soi.bsp',
    ]) {
      await spice.furnsh(k, fixture(k));
    }
    et = await spice.str2et(ET_UTC);
  });

  it('reads Saturn body radii via bodvrd', async () => {
    const radii = await spice.bodvrd('SATURN', 'RADII');
    expect(radii).toHaveLength(3);
    expect(radii[0]).toBeGreaterThan(60000);
    expect(radii[0]).toBeLessThan(60600);
    expect(radii[2]).toBeGreaterThan(54000);
    expect(radii[2]).toBeLessThan(54600);
  });

  it('reads the Cassini ISS NAC field of view via getfov', async () => {
    const fov = await spice.getfov(CASSINI_ISS_NAC);
    expect(fov.frame).toContain('CASSINI_ISS_NAC');
    expect(fov.bounds.length).toBeGreaterThanOrEqual(3);
    // The boresight is a unit vector.
    const m = Math.hypot(fov.boresight.x, fov.boresight.y, fov.boresight.z);
    expect(m).toBeCloseTo(1, 3);
  });

  it('never returns more getfov boundary vectors than the requested room', async () => {
    // The bounds buffer holds room*24 bytes, so the reader is clamped to room: even if a
    // reported count exceeded room it could not read past the buffer. CSPICE enforces
    // room >= the shape's corners, so request enough room and assert the clamp invariant.
    const room = 8;
    const fov = await spice.getfov(CASSINI_ISS_NAC, room);
    expect(fov.bounds.length).toBeLessThanOrEqual(room);
    expect(fov.bounds.length).toBe(4); // the NAC is a rectangle (4 corners)
  });

  it('computes the sub-spacecraft point on Saturn via subpnt', async () => {
    const sub = await spice.subpnt('NEAR POINT/ELLIPSOID', 'SATURN', et, 'IAU_SATURN', 'NONE', 'CASSINI');
    const r = Math.hypot(sub.point.x, sub.point.y, sub.point.z);
    // The point lies on Saturn's surface (between polar and equatorial radius).
    expect(r).toBeGreaterThan(54000);
    expect(r).toBeLessThan(60600);
  });

  it('computes a surface intercept toward Saturn via sincpt', async () => {
    const dir = await spice.spkpos('SATURN', et, 'J2000', 'NONE', 'CASSINI');
    const hit = await spice.sincpt(
      'ELLIPSOID',
      'SATURN',
      et,
      'IAU_SATURN',
      'NONE',
      'CASSINI',
      'J2000',
      dir.position,
    );
    expect(hit.found).toBe(true);
    const r = Math.hypot(hit.point.x, hit.point.y, hit.point.z);
    expect(r).toBeGreaterThan(54000);
    expect(r).toBeLessThan(60600);
  });

  it('computes illumination angles (phase, incidence, emission) via ilumin', async () => {
    const sub = await spice.subpnt('NEAR POINT/ELLIPSOID', 'SATURN', et, 'IAU_SATURN', 'NONE', 'CASSINI');
    const ill = await spice.ilumin(
      'ELLIPSOID',
      'SATURN',
      et,
      'IAU_SATURN',
      'NONE',
      'CASSINI',
      sub.point,
    );
    for (const angle of [ill.phase, ill.incidence, ill.emission]) {
      expect(Number.isFinite(angle)).toBe(true);
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThanOrEqual(Math.PI);
    }
    // At the sub-spacecraft point the emission angle is near zero (observer at nadir).
    expect(ill.emission).toBeLessThan(0.2);
  });
});
