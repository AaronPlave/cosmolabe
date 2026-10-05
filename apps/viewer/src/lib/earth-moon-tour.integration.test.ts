/**
 * The scripted tour's scene against the real base kernels.
 *
 * The tour's body-fixed poses ("the Moon's near side", "over the Moon's
 * shoulder at the Earth") only mean anything if the scene puts the Moon where
 * it was on 2015-10-31 and turns its near side to Earth. That is what de440s
 * and the IAU_MOON orientation in pck00011 give, by way of
 * `base/earth-system.json`; this holds the catalog to it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CatalogLoader,
  composeBodyToWorldQuat,
  etFromCalendarString,
  loadCatalogFromUrl,
  SpiceTrajectory,
  type Body,
  type CatalogJson,
} from '@cosmolabe/core';
import { createHeritageSpice } from '@cosmolabe/frames';

const TOUR = new URL('../../test-catalogs/earth-moon-tour.json', import.meta.url).href;
const readJson = async (url: string) => JSON.parse(readFileSync(new URL(url), 'utf8')) as CatalogJson;

/** Rotate `v` by the `[w, x, y, z]` quaternion `q`. */
function rotate(q: readonly number[], v: readonly number[]): number[] {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

function angleDeg(a: readonly number[], b: readonly number[]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.max(-1, Math.min(1, dot / Math.hypot(...a) / Math.hypot(...b)))) * 180) / Math.PI;
}

describe('earth-moon-tour.json on the base kernels', () => {
  const tourStart = etFromCalendarString('2015-10-31T23:50:00Z');
  let bodies: Body[];
  let kernels: string[];

  beforeAll(async () => {
    const graph = await loadCatalogFromUrl(TOUR, readJson);
    kernels = graph.kernels.map((k) => k.url.split('/').pop()!);
    const spice = await createHeritageSpice();
    for (const k of graph.kernels) {
      const buf = readFileSync(fileURLToPath(k.url));
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      await spice.furnish({ type: 'buffer', data, filename: k.url.split('/').pop()! });
    }
    const loader = new CatalogLoader(spice);
    bodies = graph.catalogs.flatMap(({ json }) => loader.load(json).bodies);
  });

  it('furnishes the base library kernels', () => {
    expect(kernels).toEqual(expect.arrayContaining(['naif0012.tls', 'pck00011.tpc', 'de440s.bsp']));
  });

  // The real Moon librates by up to ~7.9° in longitude and ~6.7° in latitude,
  // ~10.4° together; anything near 180° is the far side, which is what a
  // rotation that does not match the orbit used to show.
  it.each([0, 7, 14, 21])('turns the near side to Earth %i days into the tour', (days) => {
    const et = tourStart + days * 86400;
    const moon = bodies.find((b) => b.name === 'Moon')!;
    const q = composeBodyToWorldQuat(moon.rotationAt(et)!, moon.rotation!.sourceFrame, undefined, et);
    const primeMeridian = rotate(q, [1, 0, 0]);
    const p = moon.stateAt(et).position; // relative to Earth, world frame
    expect(angleDeg(primeMeridian, [-p[0], -p[1], -p[2]])).toBeLessThan(12);
  });

  // The ephemeris, not a fallback: without de440s the loader quietly drops to a
  // Keplerian orbit, and the tour's date stops meaning anything.
  it('flies Earth and the Moon on the SPICE ephemeris', () => {
    for (const name of ['Earth', 'Moon']) {
      expect(bodies.find((b) => b.name === name)!.trajectory).toBeInstanceOf(SpiceTrajectory);
    }
  });
});
