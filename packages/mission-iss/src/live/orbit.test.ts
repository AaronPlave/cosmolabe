import { describe, it, expect } from 'vitest';
import { CELESTRAK_ISS_URL, DEFAULT_ORBIT_MAX_AGE_MS, fetchCelestrakIss, orbitValidity, parseTle, tleEpochMs } from './orbit.js';

import { L1, L2 } from './__fixtures__/tle.js';
const meta = { source: 'test', sourceUrl: 'https://example.test/tle', retrievedAtMs: 0 };

describe('parseTle', () => {
  it('parses two lines or name plus two lines, with the epoch the line states (2026-11-05 20:28:36.809 UTC)', () => {
    const a = parseTle(`${L1}\n${L2}\n`, meta);
    const b = parseTle(`ISS (ZARYA)\r\n${L1}\r\n${L2}\r\n`, meta);
    expect(Math.abs(a.epochMs - Date.UTC(2026, 10, 5, 20, 28, 36, 809))).toBeLessThan(1);
    expect(b.name).toBe('ISS (ZARYA)');
    expect(a.line1).toBe(L1);
  });

  it('rejects bad checksums, other objects, missing lines and impossible epochs', () => {
    expect(() => parseTle(`${L1.slice(0, 68)}0\n${L2}`, meta)).toThrow(/checksum/);
    expect(() => parseTle(`${L1}\n${L2.slice(0, 68)}0`, meta)).toThrow(/checksum/);
    expect(() => parseTle(`${L1}\n${L2}`, meta, '99999')).toThrow(/not for NORAD/);
    expect(() => parseTle('not a tle', meta)).toThrow(/no TLE/);
    expect(() => parseTle(L1, meta)).toThrow(/no TLE/);
    expect(tleEpochMs(`${L1.slice(0, 18)}26400.00000000${L1.slice(32)}`)).toBeNaN();
  });
});

describe('orbitValidity', () => {
  const tle = parseTle(`${L1}\n${L2}`, meta);
  it('is current inside the window either side of the epoch, expired outside it, missing without a TLE', () => {
    expect(orbitValidity(tle, tle.epochMs + 3_600_000).state).toBe('current');
    expect(orbitValidity(tle, tle.epochMs - 3_600_000).state).toBe('current');
    expect(orbitValidity(tle, tle.epochMs + DEFAULT_ORBIT_MAX_AGE_MS + 1).state).toBe('expired');
    expect(orbitValidity(tle, tle.epochMs - DEFAULT_ORBIT_MAX_AGE_MS - 1).state).toBe('expired');
    expect(orbitValidity(undefined, 0).state).toBe('missing');
    expect(orbitValidity(tle, tle.epochMs, 1000).state).toBe('current');
    expect(orbitValidity(tle, tle.epochMs + 2000, 1000).state).toBe('expired');
  });
});

describe('fetchCelestrakIss', () => {
  it('uses the CelesTrak GP URL, stamps retrieval and source, and surfaces HTTP failure', async () => {
    let url = '';
    const ok = await fetchCelestrakIss(async (u) => { url = u; return { ok: true, status: 200, text: async () => `ISS (ZARYA)\n${L1}\n${L2}\n` }; }, () => 12345);
    expect(url).toBe(CELESTRAK_ISS_URL);
    expect(ok).toMatchObject({ retrievedAtMs: 12345, source: expect.stringContaining('CelesTrak') });
    await expect(fetchCelestrakIss(async () => ({ ok: false, status: 503, text: async () => '' }))).rejects.toThrow(/503/);
    await expect(fetchCelestrakIss(async () => ({ ok: true, status: 200, text: async () => 'Invalid query' }))).rejects.toThrow(/no TLE/);
  });
});
