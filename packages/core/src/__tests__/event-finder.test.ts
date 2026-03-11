import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Spice } from '@spicecraft/spice';
import { EventFinder } from '../geometry/EventFinder.js';

const KERNEL_DIR = join(__dirname, '../../../spice/test-kernels');

describe('EventFinder (SPICE integration)', () => {
  let spice: Spice;
  let finder: EventFinder;

  beforeAll(async () => {
    spice = await Spice.init();

    const lsk = readFileSync(join(KERNEL_DIR, 'naif0012.tls'));
    const pck = readFileSync(join(KERNEL_DIR, 'pck00010.tpc'));
    const spk = readFileSync(join(KERNEL_DIR, 'de425s.bsp'));

    await spice.furnish({ type: 'buffer', data: lsk.buffer, filename: 'naif0012.tls' });
    await spice.furnish({ type: 'buffer', data: pck.buffer, filename: 'pck00010.tpc' });
    await spice.furnish({ type: 'buffer', data: spk.buffer, filename: 'de425s.bsp' });

    finder = new EventFinder(spice);
  }, 30000);

  it('finds Earth-Moon distance minima (perigee)', () => {
    const et0 = spice.str2et('2024-01-01T00:00:00');
    const et1 = spice.str2et('2024-03-01T00:00:00');

    const perigees = finder.findDistanceExtrema('MOON', 'EARTH', 'periapsis', {
      searchWindow: { start: et0, end: et1 },
      stepSize: 86400,
    });

    // Moon's orbital period ~27.3 days → ~2 perigees in 2 months
    expect(perigees.length).toBeGreaterThanOrEqual(1);
    expect(perigees.length).toBeLessThanOrEqual(3);

    for (const w of perigees) {
      const midTime = (w.start + w.end) / 2;
      const { position } = spice.spkpos('MOON', midTime, 'J2000', 'NONE', 'EARTH');
      const dist = Math.sqrt(position[0] ** 2 + position[1] ** 2 + position[2] ** 2);
      // Perigee distance ~356,000-370,000 km
      expect(dist).toBeGreaterThan(350000);
      expect(dist).toBeLessThan(375000);
    }
  });

  it('finds Earth-Moon distance maxima (apogee)', () => {
    const et0 = spice.str2et('2024-01-01T00:00:00');
    const et1 = spice.str2et('2024-03-01T00:00:00');

    const apogees = finder.findDistanceExtrema('MOON', 'EARTH', 'apoapsis', {
      searchWindow: { start: et0, end: et1 },
      stepSize: 86400,
    });

    expect(apogees.length).toBeGreaterThanOrEqual(1);

    for (const w of apogees) {
      const midTime = (w.start + w.end) / 2;
      const { position } = spice.spkpos('MOON', midTime, 'J2000', 'NONE', 'EARTH');
      const dist = Math.sqrt(position[0] ** 2 + position[1] ** 2 + position[2] ** 2);
      // Apogee distance ~400,000-410,000 km
      expect(dist).toBeGreaterThan(395000);
      expect(dist).toBeLessThan(415000);
    }
  });

  it('finds new moons via gfsep (Sun-Moon angular separation minimum)', () => {
    const et0 = spice.str2et('2024-01-01T00:00:00');
    const et1 = spice.str2et('2024-04-01T00:00:00');
    const fiveDeg = 5 * Math.PI / 180;

    // gfsep needs non-empty frame strings even for POINT shapes
    const windows = spice.gfsep(
      'MOON', 'POINT', 'J2000', 'SUN', 'POINT', 'J2000',
      'NONE', 'EARTH', '<', fiveDeg, 0, 86400,
      [{ start: et0, end: et1 }],
    );

    // ~3 new moons in 3 months, all within 5 degrees of Sun
    expect(windows.length).toBeGreaterThanOrEqual(2);
    for (const w of windows) {
      expect(w.end).toBeGreaterThan(w.start);
    }
  });

  it('finds full moons via gfsep (Sun-Moon angular separation > 175 deg)', () => {
    const et0 = spice.str2et('2024-01-01T00:00:00');
    const et1 = spice.str2et('2024-04-01T00:00:00');
    const threshold = 175 * Math.PI / 180;

    const windows = spice.gfsep(
      'MOON', 'POINT', 'J2000', 'SUN', 'POINT', 'J2000',
      'NONE', 'EARTH', '>', threshold, 0, 86400,
      [{ start: et0, end: et1 }],
    );

    // ~3 full moons in 3 months
    expect(windows.length).toBeGreaterThanOrEqual(2);
    for (const w of windows) {
      expect(w.end).toBeGreaterThan(w.start);
    }
  });

  it('returns empty array when no events in search window', () => {
    const et0 = spice.str2et('2024-06-15T12:00:00');
    const et1 = spice.str2et('2024-06-15T12:01:00'); // 1 minute

    const result = finder.findDistanceExtrema('MOON', 'EARTH', 'periapsis', {
      searchWindow: { start: et0, end: et1 },
      stepSize: 60,
    });

    expect(result).toEqual([]);
  });

  it('gfoclt runs without error (SPICE cell construction verified)', () => {
    // Earth (ELLIPSOID) occulting Moon (POINT) as seen from Sun
    // de425s.bsp may not find eclipses (limited precision), but gfoclt must not crash
    const et0 = spice.str2et('2024-03-01T00:00:00');
    const et1 = spice.str2et('2024-04-01T00:00:00');

    const windows = spice.gfoclt(
      'ANY', 'EARTH', 'ELLIPSOID', 'IAU_EARTH',
      'MOON', 'POINT', '',
      'LT', 'SUN', 86400,
      [{ start: et0, end: et1 }],
    );

    // Result is a valid array (may be empty with this kernel)
    expect(windows).toBeInstanceOf(Array);
    for (const w of windows) {
      expect(w.end).toBeGreaterThan(w.start);
    }
  });
});
