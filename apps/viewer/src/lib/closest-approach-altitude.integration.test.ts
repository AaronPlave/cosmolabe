/**
 * Closest approach against real kernels: the instant is GF's, and the altitude
 * reported with it is SPICE's surface geometry rather than a projection done
 * here.
 *
 * Cassini's Saturn orbit insertion (2004-07-01) is the fixture encounter: the
 * committed SPK covers it, and pck00011 gives Saturn the triaxial `RADII` the
 * altitude is measured against.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import { EventSearch, builtinEventKinds, type InstantEvent } from '@cosmolabe/core';
import { spiceAltitude } from '@cosmolabe/three';
import { eventSearchUnavailable, spiceEphemeris, spiceGeometryFinder } from './event-finder.svelte';

const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(fileURLToPath(new URL(`../../../../kernels/fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

const KERNELS = ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp'];
const CASSINI = '-82';
const SATURN = '699';

describe('closest-approach altitude against real kernels', () => {
  let spice: HeritageSpice;
  let window: { start: number; end: number };
  let radii: number[];

  beforeAll(async () => {
    spice = await createHeritageSpice();
    for (const name of KERNELS) {
      await spice.furnish({ type: 'buffer', data: fixture(name), filename: name });
    }
    window = { start: spice.str2et('2004-06-30T12:00:00'), end: spice.str2et('2004-07-01T12:00:00') };
    radii = spice.bodvrd(SATURN, 'RADII');
  }, 120_000);

  it('reports GF-refined approaches carrying altitude ahead of range', async () => {
    const search = new EventSearch({ registry: builtinEventKinds(), provider: spiceGeometryFinder(spice) });
    const result = await search.run({
      id: 'soi',
      kind: 'closest-approach',
      bodies: { observer: CASSINI, target: SATURN },
      window,
      step: 600,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    const event = result.events[0] as InstantEvent;
    expect(event.metrics?.map((m) => m.key)).toEqual(['altitude', 'range']);

    const [altitude, range] = event.metrics!.map((m) => m.value);
    // Above an ellipsoid with semi-axes a ≥ b ≥ c, the altitude of a point at
    // range r from the centre lies in [r − a, r − c]: the triaxial shape is
    // honoured, not replaced by a sphere.
    const a = Math.max(...radii);
    const c = Math.min(...radii);
    expect(altitude).toBeGreaterThanOrEqual(range - a - 1e-6);
    expect(altitude).toBeLessThanOrEqual(range - c + 1e-6);
    // SOI passed about 0.3 Saturn radii above the cloud tops.
    expect(altitude).toBeGreaterThan(15_000);
    expect(altitude).toBeLessThan(25_000);

    // The number on the event is exactly what SPICE answers at that instant.
    expect(altitude).toBe(spiceAltitude(spice, SATURN, 'NONE', CASSINI, event.et));
  });

  it('accepts the target by SPICE name as well as by NAIF id', () => {
    const et = (window.start + window.end) / 2;
    expect(spiceAltitude(spice, 'SATURN', 'NONE', CASSINI, et))
      .toBe(spiceAltitude(spice, SATURN, 'NONE', CASSINI, et));
  });

  it('reports no altitude for a target SPICE has no shape for', async () => {
    const et = (window.start + window.end) / 2;
    // A spacecraft has no RADII: "no shape" is an answer, not a failure.
    expect(spiceAltitude(spice, CASSINI, 'NONE', SATURN, et)).toBeNaN();
    expect(spiceAltitude(spice, 'NOT A BODY', 'NONE', SATURN, et)).toBeNaN();

    const search = new EventSearch({ registry: builtinEventKinds(), provider: spiceGeometryFinder(spice) });
    const result = await search.run({
      id: 'reverse',
      kind: 'closest-approach',
      bodies: { observer: SATURN, target: CASSINI },
      window,
      step: 600,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same approach, seen the other way round: range only.
    expect(result.events).toHaveLength(1);
    expect(result.events[0].metrics?.map((m) => m.key)).toEqual(['range']);
  });
});

describe('event search availability against real kernels', () => {
  // A mixed scene: kernels are loaded, and SPICE resolves every one of these
  // names, but only some of them have states in a furnished SPK. de440s carries
  // planets and the Moon, cassini-soi carries Cassini and Saturn; nothing
  // carries Io (501), which is exactly a catalog's built-in analytic Io.
  let spice: HeritageSpice;
  let soi: { start: number; end: number };
  const check = (bodies: Record<string, string>, window: { start: number; end: number }) =>
    eventSearchUnavailable(spice.totalLoaded(), bodies, window, (name) => spiceEphemeris(spice, name));

  beforeAll(async () => {
    spice = await createHeritageSpice();
    for (const name of KERNELS) {
      await spice.furnish({ type: 'buffer', data: fixture(name), filename: name });
    }
    soi = { start: spice.str2et('2004-06-30T12:00:00'), end: spice.str2et('2004-07-01T12:00:00') };
  }, 120_000);

  it('refuses a body SPICE can name when no loaded SPK carries it', () => {
    expect(spice.bodn2c('IO')).toBe(501);
    const fault = check({ observer: CASSINI, target: 'IO' }, soi);
    expect(fault?.code).toBe('unavailable');
    expect(fault?.message).toMatch(/^No loaded SPK has ephemeris for IO/);
    // The same refusal by NAIF id, which is how the viewer hands bodies over.
    expect(check({ observer: CASSINI, target: '501' }, soi)?.message).toMatch(/ephemeris for 501/);
  });

  it('allows bodies whose SPK coverage reaches the window', () => {
    expect(check({ observer: CASSINI, target: SATURN }, soi)).toBeNull();
    expect(check({ observer: 'EARTH', target: 'MOON' }, soi)).toBeNull();
  });

  it('refuses a window outside the bodies\' coverage', () => {
    // cassini-soi.bsp ends on 2004-08-23.
    const late = { start: spice.str2et('2004-10-01'), end: spice.str2et('2004-10-02') };
    expect(check({ observer: CASSINI, target: SATURN }, late)?.message)
      .toMatch(/do not cover -82 and 699 anywhere in this search window/);
  });
});
