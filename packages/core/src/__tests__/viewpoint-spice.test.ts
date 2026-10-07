/**
 * The semantic viewpoints shipped in `cassini-soi.json`, resolved through the
 * full stack (catalog → Universe → SPICE-backed trajectories and frames) and
 * checked against CSPICE's own answers for the same geometry: `spkezr` for
 * the Cassini–Saturn relationship and `pxform` for Saturn's pole.
 *
 * Runs on the real shipped catalog rather than a fixture: a catalog field the
 * loader silently drops would pass a fixture while the catalog stayed broken.
 * Needs the SOI SPK from git-LFS; skipped when only the pointer is present.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Spice } from '@cosmolabe/spice';
import { Universe } from '../Universe.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';
import { resolveViewpoint, type ViewpointDefinition } from '../viewpoint.js';
import type { Vec3 } from '../kinematics.js';

const KERNEL_DIR = fileURLToPath(new URL('../../../spice/test-kernels', import.meta.url));
const CASSINI_DIR = join(KERNEL_DIR, 'cassini');
const SOI_SPK = join(CASSINI_DIR, '040629AP_SCPSE_04179_04185.bsp');
const HAS_SPK = existsSync(SOI_SPK) && statSync(SOI_SPK).size > 100_000;
const CATALOG = fileURLToPath(new URL('../../../../apps/viewer/test-catalogs/cassini-soi.json', import.meta.url));

const unit = (v: readonly number[]): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angleDeg = (a: Vec3, b: Vec3) => {
  const ua = unit(a), ub = unit(b);
  return (Math.atan2(Math.hypot(...cross(ua, ub)), ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2]) * 180) / Math.PI;
};

describe.skipIf(!HAS_SPK)('cassini-soi semantic viewpoints against SPICE', () => {
  let spice: Spice;
  let universe: Universe;
  let byName: Map<string, ViewpointDefinition>;
  let soi: number;

  beforeAll(async () => {
    spice = await Spice.init();
    for (const [dir, name] of [
      [KERNEL_DIR, 'naif0012.tls'], [KERNEL_DIR, 'pck00010.tpc'],
      [CASSINI_DIR, 'cas_v43.tf'], [CASSINI_DIR, 'cas00172.tsc'], [CASSINI_DIR, '040629AP_SCPSE_04179_04185.bsp'],
    ]) {
      const b = readFileSync(join(dir, name));
      await spice.furnish({ type: 'buffer', data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, filename: name });
    }
    universe = new Universe(spice);
    universe.loadCatalog(JSON.parse(readFileSync(CATALOG, 'utf8')) as CatalogJson);
    byName = new Map(universe.viewpoints.map((v) => [v.name, v]));
    soi = spice.str2et('2004-07-01T02:48:00');
  }, 60_000);

  /** Cassini's state relative to Saturn in the scene frame, from CSPICE. */
  const cassiniFromSaturn = (et: number) => spice.spkezr('CASSINI', et, 'ECLIPJ2000', 'NONE', 'SATURN').state;

  it('puts Cassini between the camera and Saturn at SOI, looking at Saturn', () => {
    const vp = byName.get('SOI: Saturn beyond Cassini (2004-07-01)')!;
    expect(vp.epoch).toBeCloseTo(soi, 3);
    const r = resolveViewpoint(universe, vp, vp.epoch!);
    const s = cassiniFromSaturn(soi);
    const saturnFromCassini: Vec3 = [-s[0], -s[1], -s[2]];
    // The target is Saturn's centre as seen from Cassini…
    expect(Math.hypot(r.target[0] - saturnFromCassini[0], r.target[1] - saturnFromCassini[1], r.target[2] - saturnFromCassini[2])).toBeLessThan(1e-3);
    // …and the eye is 30 m on the far side of Cassini from it.
    expect(angleDeg(r.eye, s.slice(0, 3) as Vec3)).toBeLessThan(1e-6);
    expect(Math.hypot(...r.eye)).toBeCloseTo(0.03, 12);
    // Up is Saturn's pole, so the rings lie level in the frame.
    const m = spice.pxform('IAU_SATURN', 'ECLIPJ2000', soi);
    expect(angleDeg(r.up, [m[2], m[5], m[8]])).toBeLessThan(1e-3);
  });

  it('chases Cassini along its Saturn-relative velocity, up along the orbit normal', () => {
    const r = resolveViewpoint(universe, byName.get('Chase Cassini')!, soi);
    const s = cassiniFromSaturn(soi);
    const v: Vec3 = [s[3], s[4], s[5]];
    expect(angleDeg(r.eye, [-v[0], -v[1], -v[2]])).toBeLessThan(1e-3);
    expect(angleDeg(r.up, cross([s[0], s[1], s[2]], v))).toBeLessThan(1e-3);
  });

  it('follows the clock for a viewpoint that names no time', () => {
    const vp = byName.get('Chase Cassini')!;
    expect(vp.epoch).toBeUndefined();
    // Across SOI periapsis the velocity swings through tens of degrees in an hour.
    const before = resolveViewpoint(universe, vp, soi - 1800);
    const after = resolveViewpoint(universe, vp, soi + 1800);
    expect(angleDeg(before.eye, after.eye)).toBeGreaterThan(10);
  });

  it('places the Sun-side view on the Sun line', () => {
    const r = resolveViewpoint(universe, byName.get('Cassini from the Sun side')!, soi);
    const sun = spice.spkpos('SUN', soi, 'ECLIPJ2000', 'NONE', 'CASSINI').position;
    expect(angleDeg(r.eye, sun as Vec3)).toBeLessThan(1e-4);
  });
});
