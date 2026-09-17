// The ISO-8601 → SPICE normalisation that replaced the tier's trailing-Z strip
// (issue #8). Two halves: the string transform on its own, and the property
// that matters — the normalised string and the form CSPICE already accepted
// resolve to the same ET, bit for bit, so retiring the hack re-baselines
// nothing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSpiceBindings, SpiceError, type SpiceBindings } from 'cspice-wasm';
import { spiceUtcFromIso } from './iso-epoch.js';

const fixtureBytes = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../kernels/fixtures/${name}`, import.meta.url))),
  );

describe('spiceUtcFromIso', () => {
  it('names UTC explicitly instead of leaning on CSPICE default', () => {
    expect(spiceUtcFromIso('2004-07-01T02:00:00')).toBe('2004-07-01 02:00:00 UTC');
  });

  it('accepts the Z designator rather than stripping it', () => {
    expect(spiceUtcFromIso('2004-07-01T02:00:00Z')).toBe('2004-07-01 02:00:00 UTC');
    expect(spiceUtcFromIso('2004-07-01t02:00:00z')).toBe('2004-07-01 02:00:00 UTC');
  });

  it('fills in the fields an abbreviated ISO form leaves out', () => {
    expect(spiceUtcFromIso('2004-07-01T02:00')).toBe('2004-07-01 02:00:00 UTC');
    expect(spiceUtcFromIso('2004-07-01')).toBe('2004-07-01 00:00:00 UTC');
    expect(spiceUtcFromIso('2004-07-01Z')).toBe('2004-07-01 00:00:00 UTC');
  });

  it('carries fractional seconds across as text, to any depth', () => {
    expect(spiceUtcFromIso('2004-07-01T02:00:00.331Z')).toBe('2004-07-01 02:00:00.331 UTC');
    expect(spiceUtcFromIso('2004-07-01T02:00:00.123456789')).toBe(
      '2004-07-01 02:00:00.123456789 UTC',
    );
    // ISO-8601's comma decimal mark; CSPICE only reads a point.
    expect(spiceUtcFromIso('2004-07-01T02:00:00,5')).toBe('2004-07-01 02:00:00.5 UTC');
  });

  it('keeps a leap-second reading intact', () => {
    expect(spiceUtcFromIso('2016-12-31T23:59:60Z')).toBe('2016-12-31 23:59:60 UTC');
  });

  it('resolves a numeric offset to UTC, in every spelling', () => {
    expect(spiceUtcFromIso('2004-07-01T04:00:00+02:00')).toBe('2004-07-01 02:00:00 UTC');
    expect(spiceUtcFromIso('2004-07-01T04:00:00+0200')).toBe('2004-07-01 02:00:00 UTC');
    expect(spiceUtcFromIso('2004-07-01T04:00:00+02')).toBe('2004-07-01 02:00:00 UTC');
    expect(spiceUtcFromIso('2004-07-01T00:00:00-05:00')).toBe('2004-07-01 05:00:00 UTC');
    expect(spiceUtcFromIso('2004-07-01T05:45:00+05:45')).toBe('2004-07-01 00:00:00 UTC');
  });

  it('rolls the calendar when an offset crosses a boundary', () => {
    expect(spiceUtcFromIso('2004-02-29T23:30:00-01:00')).toBe('2004-03-01 00:30:00 UTC');
    expect(spiceUtcFromIso('2005-01-01T00:30:00+01:00')).toBe('2004-12-31 23:30:00 UTC');
    // The seconds field never reaches the shift, so no digit of it can round.
    expect(spiceUtcFromIso('2004-12-31T23:59:59.999999+00:30')).toBe(
      '2004-12-31 23:29:59.999999 UTC',
    );
  });

  it('trims surrounding whitespace, which the old strip choked on', () => {
    expect(spiceUtcFromIso('  2004-07-01T02:00:00Z  ')).toBe('2004-07-01 02:00:00 UTC');
  });

  it('keeps the ISO form for a leading-zero year, which the calendar form cannot read', () => {
    expect(spiceUtcFromIso('0999-07-01T02:00:00Z')).toBe('0999-07-01T02:00:00');
    expect(spiceUtcFromIso('0999-07-01T04:00:00+02:00')).toBe('0999-07-01T02:00:00');
  });

  it('passes every non-ISO form through untouched', () => {
    for (const s of [
      '2004 JUL 01 02:00:00',
      '2004-183 // 02:00:00',
      'JD 2453187.5',
      '1996-12-18 12:00:00.331 TDB',
      '2004-07-01T02:00:00 TDB',
      '2004-W27-4T02:00:00Z',
      'not a time at all',
      '',
    ]) {
      expect(spiceUtcFromIso(s), s).toBe(s);
    }
  });
});

describe('spiceUtcFromIso against CSPICE', () => {
  let spice: SpiceBindings;

  beforeAll(async () => {
    spice = await createSpiceBindings();
    spice.furnsh('naif0012.tls', fixtureBytes('naif0012.tls'));
  });

  it('resolves to the same ET as the bare ISO form CSPICE already took', () => {
    // The re-baseline question, answered directly: for every form the retired
    // Z-strip produced, normalisation lands on the identical double.
    for (const [iso, bare] of [
      ['2004-07-01T02:00:00Z', '2004-07-01T02:00:00'],
      ['2004-07-01T02:00:00', '2004-07-01T02:00:00'],
      ['2004-07-01T02:48:00Z', '2004-07-01T02:48:00'],
      ['2004-07-01T02:00:00.331Z', '2004-07-01T02:00:00.331'],
      ['2016-12-31T23:59:60Z', '2016-12-31T23:59:60'],
      ['1972-01-01T00:00:00Z', '1972-01-01T00:00:00'],
      ['2035-06-15T12:34:56.789Z', '2035-06-15T12:34:56.789'],
      ['1900-01-01T00:00:00Z', '1900-01-01T00:00:00'],
      ['2004-07-01', '2004-07-01'],
    ] as const) {
      expect(spice.str2et(spiceUtcFromIso(iso)), iso).toBe(spice.str2et(bare));
    }
  });

  it('holds over a sweep of epochs with fractional seconds', () => {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    for (let i = 0; i < 500; i++) {
      const ms = Date.UTC(1972, 0, 1) + Math.round((i / 500) * (Date.UTC(2035, 0, 1) - Date.UTC(1972, 0, 1)));
      const d = new Date(ms);
      const frac = i % 3 === 0 ? '' : `.${pad(i * 7919 % 1_000_000, 6)}`;
      const bare =
        `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
        `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}`;
      expect(spice.str2et(spiceUtcFromIso(`${bare}Z`)), bare).toBe(spice.str2et(bare));
    }
  });

  it('makes CSPICE accept the offset and stray-whitespace forms it used to reject', () => {
    const noon = spice.str2et('2004-07-01T12:00:00');
    for (const s of ['2004-07-01T14:00:00+02:00', '2004-07-01T07:00:00-05:00', ' 2004-07-01T12:00:00Z ']) {
      expect(() => spice.str2et(s), s).toThrow(SpiceError);
      expect(spice.str2et(spiceUtcFromIso(s)), s).toBe(noon);
    }
  });
});
