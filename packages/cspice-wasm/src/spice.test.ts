// cspice-wasm acceptance test (SPEC 5.1): load an LSK plus a planetary SPK and
// assert spkpos of a known body at a known epoch matches a NAIF reference within
// tolerance. The reference is the position of Saturn barycenter (6) relative to
// the Sun (10) in J2000 at 2004-07-01, taken from de440 (NAIF's authoritative
// planetary ephemeris) via packages/cspice-wasm/scripts/make-fixture-spk.mjs. de440 is
// the published NAIF ephemeris, so this both validates the WASM build and pins an
// independent physical truth (Saturn sits ~9.04 AU from the Sun).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceEngine, SpiceError, type SpiceEngine } from './index.ts';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

// Reference values pinned from de440s at 2004-07-01T00:00:00 (see module header).
const REF = {
  et: 141912064.184103,
  position: { x: -384016039.3242731, y: 1192912618.287345, z: 509243085.7438889 },
  lightTime: 4512.17091228751,
};

describe('cspice-wasm CSPICE-WASM engine', () => {
  let engine: SpiceEngine;

  beforeAll(async () => {
    engine = await createSpiceEngine();
    await engine.furnsh('naif0012.tls', fixture('naif0012.tls'));
    await engine.furnsh('de440s-inner-cassini.bsp', fixture('de440s-inner-cassini.bsp'));
  });

  it('reports a CSPICE toolkit version', async () => {
    expect(await engine.tkvrsn()).toMatch(/^CSPICE_N\d+$/);
  });

  it('converts the test UTC epoch to the reference ET', async () => {
    const et = await engine.str2et('2004-07-01T00:00:00');
    expect(Math.abs(et - REF.et)).toBeLessThan(1e-3);
  });

  it('matches the NAIF reference spkpos within tolerance', async () => {
    const et = await engine.str2et('2004-07-01T00:00:00');
    const { position, lightTime } = await engine.spkpos('6', et, 'J2000', 'NONE', '10');
    // Same kernel and engine: agreement should be far tighter than 1 metre.
    expect(Math.abs(position.x - REF.position.x)).toBeLessThan(1e-3);
    expect(Math.abs(position.y - REF.position.y)).toBeLessThan(1e-3);
    expect(Math.abs(position.z - REF.position.z)).toBeLessThan(1e-3);
    expect(Math.abs(lightTime - REF.lightTime)).toBeLessThan(1e-6);

    // Physical sanity: Saturn is ~9.04 AU from the Sun.
    const auKm = 1.495978707e8;
    const dist = Math.hypot(position.x, position.y, position.z) / auKm;
    expect(dist).toBeGreaterThan(8.5);
    expect(dist).toBeLessThan(10.5);
  });

  it('round-trips ET to UTC and back', async () => {
    const utc = await engine.et2utc(REF.et, 'ISOC', 3);
    expect(utc.startsWith('2004-07-01')).toBe(true);
    const et = await engine.utc2et(utc);
    expect(Math.abs(et - REF.et)).toBeLessThan(1e-2);
  });

  it('formats ET as a TDB calendar string distinct from UTC', async () => {
    const tdb = await engine.et2tdb(REF.et, 3);
    // Well-formed ISO calendar date at the reference epoch, with a time component.
    expect(/^\d{4}-\d{2}-\d{2}T/.test(tdb)).toBe(true);
    expect(tdb.startsWith('2004-07-01')).toBe(true);
    // TDB leads UTC by the leap-second offset plus 32.184 s, so the strings differ.
    const utc = await engine.et2utc(REF.et, 'ISOC', 3);
    expect(tdb).not.toBe(utc);
  });

  it('fails loudly with a typed error for an unresolved body', async () => {
    await expect(engine.spkpos('NOT_A_BODY', REF.et, 'J2000', 'NONE', '10')).rejects.toBeInstanceOf(
      SpiceError,
    );
  });
});
