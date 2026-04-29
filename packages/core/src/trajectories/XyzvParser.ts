import type { Vec3 } from '@cosmolabe/spice';
import type { StateRecord } from './InterpolatedStates.js';

const JD_J2000 = 2451545.0;

/**
 * Parses Cosmographia .xyzv trajectory files.
 *
 * Format: one record per line (comments starting with # are skipped):
 *   JD x y z vx vy vz
 * where position is in km and velocity in km/s.
 */
export function parseXyzv(text: string): StateRecord[] {
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  const records: StateRecord[] = [];

  for (const line of lines) {
    const parts = line.split(/\s+/).map(Number);
    if (parts.length < 7 || parts.some(isNaN)) continue;

    const [jd, x, y, z, vx, vy, vz] = parts;

    records.push({
      et: (jd - JD_J2000) * 86400,
      position: [x, y, z] as Vec3,
      velocity: [vx, vy, vz] as Vec3,
    });
  }

  return records;
}
