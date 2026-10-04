/**
 * The scripted tour's scene, kernel-free: the Moon's near side must face
 * Earth, or every "near side / far side / look back at Earth" pose in the tour
 * shows the wrong hemisphere.
 *
 * Without SPICE the Moon flies a Keplerian orbit, which the IAU rotation
 * (built for the real ephemeris) does not match. The catalog instead keeps the
 * IAU pole but spins the Moon once per orbit of *that* Keplerian orbit, phased
 * so the prime meridian faces Earth at the tour's start. What remains is the
 * Moon's honest libration: ~6.5° in longitude from the eccentric orbit and
 * ~6.7° in latitude from the pole's tilt to the orbit — never more than ~10°.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CatalogLoader, composeBodyToWorldQuat, etFromCalendarString } from '@cosmolabe/core';

const json = JSON.parse(
  readFileSync(new URL('../../../test-catalogs/earth-moon-tour.json', import.meta.url), 'utf8'),
);
const moon = new CatalogLoader().load(json).bodies.find((b) => b.name === 'Moon')!;

/** Rotate `v` by the `[w, x, y, z]` quaternion `q`. */
function rotate(q: readonly number[], v: [number, number, number]): [number, number, number] {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

function angleDeg(a: number[], b: number[]): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (Math.acos(Math.max(-1, Math.min(1, dot / Math.hypot(...a) / Math.hypot(...b)))) * 180) / Math.PI;
}

describe('earth-moon-tour.json', () => {
  const tourStart = etFromCalendarString('2015-10-31T23:50:00Z');

  it.each([0, 1, 3, 7, 10, 14, 17, 21, 24, 27, 60, 365])('keeps the near side toward Earth %i days into the tour', (days) => {
    const et = tourStart + days * 86400;
    const q = composeBodyToWorldQuat(moon.rotationAt(et)!, moon.rotation!.sourceFrame);
    const primeMeridian = rotate(q, [1, 0, 0]);
    // The Moon's position is relative to Earth, in the ecliptic world frame.
    const p = moon.stateAt(et).position;
    const towardEarth = [-p[0], -p[1], -p[2]];
    expect(angleDeg(primeMeridian, towardEarth)).toBeLessThan(12);
  });
});
