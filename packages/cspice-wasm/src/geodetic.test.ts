// The recgeo (rectangular -> geodetic) and et2lst (local solar time) bindings, against
// the bundled Earth PCK. (STK_PARITY_SPEC §4.12 / frame-time infrastructure.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, type SpiceEngine } from './index.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

describe('recgeo / et2lst bindings', () => {
  let spice: SpiceEngine;
  let re: number;
  let f: number;

  beforeAll(async () => {
    spice = await createSpiceEngine();
    // et2lst needs an SPK (it locates the Sun for local solar time).
    for (const k of ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp']) {
      await spice.furnsh(k, fixture(k));
    }
    const radii = await spice.bodvrd('EARTH', 'RADII');
    re = radii[0]!;
    f = (radii[0]! - radii[2]!) / radii[0]!;
  });

  it('recgeo returns equatorial lon/lat 0 and the right altitude for a point on +x', async () => {
    const g = await spice.recgeo({ x: re + 500, y: 0, z: 0 }, re, f);
    expect(g.lon).toBeCloseTo(0, 9);
    expect(g.lat).toBeCloseTo(0, 9);
    expect(g.alt).toBeCloseTo(500, 6);
  });

  it('recgeo puts a +y equatorial point at lon = 90 deg', async () => {
    const g = await spice.recgeo({ x: 0, y: re + 100, z: 0 }, re, f);
    expect(g.lon).toBeCloseTo(Math.PI / 2, 9);
    expect(g.lat).toBeCloseTo(0, 9);
  });

  it('et2lst returns a well-formed local solar time', async () => {
    const et = await spice.str2et('2004-07-01T12:00:00');
    const lst = await spice.et2lst(et, 399, 0, 'PLANETOCENTRIC');
    expect(lst.hr).toBeGreaterThanOrEqual(0);
    expect(lst.hr).toBeLessThan(24);
    expect(lst.time).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});
