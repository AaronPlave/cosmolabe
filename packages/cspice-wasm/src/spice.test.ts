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
import {
  createSpiceBindings, createSpiceEngine, spiceEngineOver, SpiceError, type SpiceBindings, type SpiceEngine,
} from './index.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))));

// Reference values pinned from de440s at 2004-07-01T00:00:00 (see module header).
const REF = {
  et: 141912064.184103,
  position: { x: -384016039.3242731, y: 1192912618.287345, z: 509243085.7438889 },
  lightTime: 4512.17091228751,
};

describe('cspice-wasm CSPICE-WASM engine', () => {
  let bindings: SpiceBindings;
  let engine: SpiceEngine;

  beforeAll(async () => {
    bindings = await createSpiceBindings();
    engine = spiceEngineOver(bindings);
    await engine.furnsh('naif0012.tls', fixture('naif0012.tls'));
    await engine.furnsh('de440s-inner-cassini.bsp', fixture('de440s-inner-cassini.bsp'));
  });

  it('runs CSPICE N0067', async () => {
    expect(await engine.tkvrsn()).toBe('CSPICE_N0067');
  });

  it('converts the test UTC epoch to the reference ET', async () => {
    const et = await engine.str2et('2004-07-01T00:00:00');
    expect(Math.abs(et - REF.et)).toBeLessThan(1e-3);
  });

  it('accepts ISO UTC with a trailing Z in both time parsers', async () => {
    const utc = '2004-07-01T00:00:00';
    expect(await engine.str2et(`${utc}Z`)).toBe(await engine.str2et(utc));
    expect(await engine.utc2et(`${utc}Z`)).toBe(await engine.utc2et(utc));
  });

  it('converts uniform time between GPS and TT', () => {
    // GPS is TAI minus 19 s. TT is TAI plus 32.184 s.
    expect(bindings.unitim(0, 'GPS', 'TT')).toBeCloseTo(51.184, 12);
    expect(bindings.unitim(51.184, 'TT', 'GPS')).toBeCloseTo(0, 12);
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

describe('N0067 frame transforms with the published pck00011.tpc', () => {
  const pck = 'pck00011.tpc';
  const et = 730_000_000;
  // Native NAIF N0067 (Mac M1/clang) pxform_c and sxform_c applied to the
  // J2000 state [1, -2, 3, 0, 0, 0], with this fixture as the only kernel.
  const references = [
    {
      frame: 'IAU_MARS',
      position: [-0.40115346866669688, -0.71293497896317115, 3.651136755908694],
      velocity: [-5.0534384607272463e-5, 2.8434633430924065e-5, 3.0531780391690649e-13],
    },
    {
      frame: 'IAU_PHOBOS',
      position: [0.16497544036932688, -0.8698050655236137, 3.6354122533853581],
      velocity: [-1.9506935590131612e-4, -3.6999434285043463e-5, -1.7672555780088755e-10],
    },
    {
      frame: 'IAU_DEIMOS',
      position: [-0.50665853671542593, -0.42072809319839388, 3.6832438147327453],
      velocity: [-2.4235411887302e-5, 2.918519554164855e-5, -1.2666458793529668e-11],
    },
  ];

  it('matches native position and velocity transforms after furnishing and reloading the PCK', async () => {
    const engine = await createSpiceEngine();
    // NAIF warns against using this PCK's Mars-system orientation data on N0066.
    expect(await engine.tkvrsn()).toBe('CSPICE_N0067');
    const bytes = fixture(pck);

    for (let load = 0; load < 2; load++) {
      await engine.furnsh(pck, bytes);
      for (const { frame, position, velocity } of references) {
        const rotation = await engine.pxform('J2000', frame, et);
        const state = await engine.sxform('J2000', frame, et);
        for (let row = 0; row < 3; row++) {
          const r = 3 * row;
          const p = 6 * row;
          const v = p + 18;
          expect(rotation[r]! - 2 * rotation[r + 1]! + 3 * rotation[r + 2]!).toBeCloseTo(position[row]!, 9);
          expect(state[p]! - 2 * state[p + 1]! + 3 * state[p + 2]!).toBeCloseTo(position[row]!, 9);
          expect(state[v]! - 2 * state[v + 1]! + 3 * state[v + 2]!).toBeCloseTo(velocity[row]!, 13);
        }
      }
      await engine.unload(pck);
      await expect(engine.pxform('J2000', 'IAU_MARS', et)).rejects.toBeInstanceOf(SpiceError);
    }
  });

  it('resolves a product frame through position and state transforms', async () => {
    const engine = await createSpiceEngine();
    await engine.furnsh('product.tf', new TextEncoder().encode(`\\begindata
FRAME_DEMO_PRODUCT          = 1890000
FRAME_1890000_NAME          = 'DEMO_PRODUCT'
FRAME_1890000_CLASS         = 5
FRAME_1890000_CLASS_ID      = 1890000
FRAME_1890000_CENTER        = 399
FRAME_1890000_RELATIVE      = 'J2000'
FRAME_1890000_DEF_STYLE     = 'PARAMETERIZED'
FRAME_1890000_FAMILY        = 'PRODUCT'
FRAME_1890000_ROTATION_STATE = 'ROTATING'
FRAME_1890000_FROM_FRAMES   = ( 'J2000', 'J2000' )
FRAME_1890000_TO_FRAMES     = ( 'IAU_EARTH', 'ECLIPJ2000' )
\\begintext
`));
    // The PCK supplies Earth orientation for the rotating factor.
    await engine.furnsh(pck, fixture(pck));

    for (const [transform, size] of [[engine.pxform, 3], [engine.sxform, 6]] as const) {
      const earth = await transform('J2000', 'IAU_EARTH', et);
      const ecliptic = await transform('J2000', 'ECLIPJ2000', et);
      const product = await transform('J2000', 'DEMO_PRODUCT', et);
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          let expected = 0;
          for (let k = 0; k < size; k++) expected += earth[row * size + k]! * ecliptic[k * size + col]!;
          expect(product[row * size + col]!).toBeCloseTo(expected, 12);
        }
      }
    }
  });
});
