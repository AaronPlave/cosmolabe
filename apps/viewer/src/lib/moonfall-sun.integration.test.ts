/**
 * The MoonFall sky at the lunar south pole.
 *
 * At the pole the Sun circles the horizon once per lunar day, within ~1.5° of
 * it, rising and sinking over the year with the Moon's tilt; Earth bobs ±6.8°
 * each month. Lighting and Earth visibility at Shackleton hinge on fractions of
 * a degree, so the catalog flies the real ephemeris and IAU_MOON, and the
 * SPICE-free fallback carries the Moon's periodic terms and a correct Earth
 * orbit (#149). Truth here is
 * CSPICE's spkpos in IAU_MOON.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogFromUrl, etFromCalendarString, Universe, type CatalogJson, type SpiceInstance } from '@cosmolabe/core';
import { createHeritageSpice } from '@cosmolabe/frames';

const CATALOG = new URL('../../test-catalogs/moonfall-shackleton.json', import.meta.url).href;
const readJson = async (url: string) => JSON.parse(readFileSync(new URL(url), 'utf8')) as CatalogJson;
const DEG = 180 / Math.PI;

/** Rotate `v` by the conjugate of the `[w, x, y, z]` quaternion `q`. */
function unrotate(q: readonly number[], v: readonly number[]): number[] {
  const [w, x, y, z] = [q[0], -q[1], -q[2], -q[3]];
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** Elevation above the south-pole horizon and azimuth (east longitude), degrees. */
const elAz = (v: readonly number[]) => [Math.asin(-v[2] / Math.hypot(...v)) * DEG, Math.atan2(v[1], v[0]) * DEG];

function seenFromMoon(u: Universe, target: string, et: number) {
  const t = u.absolutePositionOf(target, et), m = u.absolutePositionOf('Moon', et);
  return elAz(unrotate(u.bodyToWorldQuat('Moon', et)!, [t[0] - m[0], t[1] - m[1], t[2] - m[2]]));
}

describe('moonfall-shackleton.json: Sun and Earth over the south pole', () => {
  let spice: SpiceInstance;
  let json: CatalogJson[];
  let kernels: string[];
  // A year from the mission start, every 5 days: every season and azimuth.
  const t0 = etFromCalendarString('2028-12-15T10:04:00Z');
  const times = Array.from({ length: 74 }, (_, i) => t0 + i * 5 * 86400);

  beforeAll(async () => {
    const graph = await loadCatalogFromUrl(CATALOG, readJson);
    kernels = graph.kernels.map((k) => k.url.split('/').pop()!);
    json = graph.catalogs.map((c) => c.json);
    spice = await createHeritageSpice();
    for (const k of graph.kernels) {
      const buf = readFileSync(fileURLToPath(k.url));
      await spice.furnish({ type: 'buffer', data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, filename: k.url.split('/').pop()! });
    }
  });

  it('furnishes the ephemeris and the Moon orientation', () => {
    expect(kernels).toEqual(expect.arrayContaining(['naif0012.tls', 'pck00011.tpc', 'de440s.bsp']));
  });

  // With SPICE the scene is the ephemeris: what is left is light time and
  // aberration (spkpos uses LT+S). Without it, the Sun is right to the Moon's
  // offset from its Keplerian fallback orbit (≤0.15°); Earth, seen from the
  // Moon, is not checked there — that orbit is tens of degrees off by 2028.
  it.each([
    ['with SPICE', true, ['SUN', 'EARTH'], 0.01, 0.1],
    ['SPICE-free fallback', false, ['SUN'], 0.2, 0.2],
  ] as const)('%s', (_, withSpice, targets, elTol, azTol) => {
    const u = withSpice ? new Universe(spice) : new Universe();
    for (const j of json) u.loadCatalog(j);
    let maxEl = -Infinity, minEl = Infinity;
    for (const et of times) {
      for (const target of targets) {
        const [el, az] = seenFromMoon(u, target === 'SUN' ? 'Sun' : 'Earth', et);
        const [tel, taz] = elAz(spice.spkpos(target, et, 'IAU_MOON', 'LT+S', 'MOON').position);
        expect(Math.abs(el - tel), `${target} elevation @ ${et}`).toBeLessThan(elTol);
        expect(Math.abs(((az - taz + 540) % 360) - 180), `${target} azimuth @ ${et}`).toBeLessThan(azTol);
        if (target === 'SUN') { maxEl = Math.max(maxEl, el); minEl = Math.min(minEl, el); }
      }
    }
    // The season: the Sun rises ~1.5° above and sinks ~1.5° below the horizon.
    expect(maxEl).toBeGreaterThan(1.4);
    expect(minEl).toBeLessThan(-1.4);
  });
});
