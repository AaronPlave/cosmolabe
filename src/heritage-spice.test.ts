// Conformance tests for the heritage adapter: the SpiceInstance-compatible
// surface the Session 4 re-point injects into cosmolabe. Values are checked
// against an independent cspice-wasm oracle over the same kernel bytes, and
// the deliberate gaps (members without WASM exports) fail loudly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceBindings, SpiceError, type SpiceBindings } from 'cspice-wasm';
import { createHeritageSpice, type HeritageSpice } from './index.ts';

const fixtureBytes = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))),
  );

const FIXTURES = ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp'];

describe('@cosmolabe/frames heritage adapter', () => {
  let spice: HeritageSpice;
  let oracle: SpiceBindings;
  let et0: number;

  beforeAll(async () => {
    spice = await createHeritageSpice();
    oracle = await createSpiceBindings();
    for (const name of FIXTURES) {
      const bytes = fixtureBytes(name);
      await spice.furnish({
        type: 'buffer',
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        filename: name,
      });
      oracle.furnsh(name, bytes);
    }
    et0 = spice.str2et('2004-07-01T02:00:00');
  });

  it('answers time conversions like the oracle', () => {
    expect(et0).toBe(oracle.str2et('2004-07-01T02:00:00'));
    expect(spice.utc2et('2004-07-01T02:00:00Z')).toBe(oracle.utc2et('2004-07-01T02:00:00'));
    expect(spice.et2utc(et0, 'ISOC', 3).startsWith('2004-07-01T02:00:00')).toBe(true);
    expect(spice.timout(et0, 'YYYY-MM-DD HR:MN:SC ::UTC')).toContain('2004-07-01');
    expect(spice.unitim(et0, 'TDB', 'TDB')).toBe(et0);
  });

  it('returns heritage-shaped states identical to the oracle', () => {
    const { state, lightTime } = spice.spkezr('CASSINI', et0, 'J2000', 'NONE', 'SATURN');
    const ref = oracle.spkezr('CASSINI', et0, 'J2000', 'NONE', 'SATURN');
    expect(state).toEqual([
      ref.position.x, ref.position.y, ref.position.z,
      ref.velocity.x, ref.velocity.y, ref.velocity.z,
    ]);
    expect(lightTime).toBe(ref.lightTime);
    const { position } = spice.spkpos('SUN', et0, 'ECLIPJ2000', 'LT+S', 'CASSINI');
    const refP = oracle.spkpos('SUN', et0, 'ECLIPJ2000', 'LT+S', 'CASSINI');
    expect(position).toEqual([refP.position.x, refP.position.y, refP.position.z]);
  });

  it('returns frames and bodies like the oracle', () => {
    expect(spice.pxform('J2000', 'IAU_SATURN', et0)).toEqual([
      ...oracle.pxform('J2000', 'IAU_SATURN', et0),
    ]);
    expect(spice.sxform('J2000', 'ECLIPJ2000', et0)).toEqual([
      ...oracle.sxform('J2000', 'ECLIPJ2000', et0),
    ]);
    expect(spice.bodn2c('SATURN')).toBe(699);
    expect(spice.bodc2n(699)).toBe('SATURN');
    expect(spice.bodn2c('NOSUCHBODY')).toBeNull();
    expect(spice.bodvcd(699, 'RADII').length).toBe(3);
    expect(spice.frmnam(1)).toBe('J2000');
  });

  it('reconstructs spkobj and spkcov from DAF summaries', () => {
    const bodies = spice.spkobj('cassini-soi.bsp');
    expect(bodies).toContain(-82);
    const windows = spice.spkcov(-82);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]!.start).toBeLessThan(et0);
    expect(windows[windows.length - 1]!.end).toBeGreaterThan(et0);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.start).toBeGreaterThan(windows[i - 1]!.end);
    }
  });

  it('computes sub-points with heritage lat, lon, and altitude semantics', () => {
    const sub = spice.subpnt('NEAR POINT/ELLIPSOID', 'SATURN', et0, 'IAU_SATURN', 'NONE', 'CASSINI');
    const p = sub.point;
    expect(sub.latitude).toBeCloseTo(Math.atan2(p[2], Math.hypot(p[0], p[1])), 12);
    expect(sub.longitude).toBeCloseTo(Math.atan2(p[1], p[0]), 12);
    expect(sub.altitude).toBeGreaterThan(0);
    const slr = spice.subslr('NEAR POINT/ELLIPSOID', 'SATURN', et0, 'IAU_SATURN', 'NONE', 'CASSINI');
    expect(Math.abs(slr.longitude - sub.longitude)).toBeGreaterThan(0); // distinct points
  });

  it('drives the geometry finders over a cnfine window list', () => {
    const windows = spice.gfdist('SUN', 'NONE', 'CASSINI', '<', 2.0e9, 0, 3600, [
      { start: et0, end: et0 + 4 * 3600 },
    ]);
    expect(windows.length).toBe(1);
    expect(windows[0]!.start).toBeCloseTo(et0, 3);
    expect(windows[0]!.end).toBeCloseTo(et0 + 4 * 3600, 3);
    expect(() =>
      spice.gfdist('SUN', 'NONE', 'CASSINI', 'ABSMIN', 0, 1, 3600, [{ start: et0, end: et0 + 60 }]),
    ).toThrow(SpiceError);
  });

  it('matches SPICE vector math semantics', () => {
    expect(spice.vsep([1, 0, 0], [0, 2, 0])).toBeCloseTo(Math.PI / 2, 14);
    expect(spice.vcrss([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(spice.vhat([3, 0, 4])).toEqual([0.6, 0, 0.8]);
    expect(spice.mxv([1, 0, 0, 0, 0, 1, 0, -1, 0], [0, 0, 2])).toEqual([0, 2, 0]);
    expect(spice.mtxv([1, 0, 0, 0, 0, 1, 0, -1, 0], [0, 2, 0])).toEqual([0, 0, 2]);
    const rr = spice.recrad([0, 1, 0]);
    expect(rr.ra).toBeCloseTo(Math.PI / 2, 14);
    expect(rr.dec).toBeCloseTo(0, 14);
  });

  it('exposes the frames tier beneath it for provenance', () => {
    const info = spice.frames.kernels();
    expect(info.count).toBe(FIXTURES.length);
    expect(info.setHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails loudly on the deliberate allowlist gaps and file sources', async () => {
    expect(() => spice.cidfrm(699)).toThrow(SpiceError);
    expect(() =>
      spice.fovray('X', [1, 0, 0], 'J2000', 'NONE', 'CASSINI', et0),
    ).toThrow(SpiceError);
    await expect(spice.furnish({ type: 'file', path: '/nope.bsp' })).rejects.toThrow(SpiceError);
  });

  it('clear() empties the pool and the provenance list', async () => {
    const scratch = await createHeritageSpice();
    await scratch.furnish({
      type: 'buffer',
      data: fixtureBytes('naif0012.tls').buffer,
      filename: 'naif0012.tls',
    });
    expect(scratch.totalLoaded()).toBe(1);
    scratch.clear();
    expect(scratch.totalLoaded()).toBe(0);
    expect(scratch.frames.kernels().count).toBe(0);
  });
});
