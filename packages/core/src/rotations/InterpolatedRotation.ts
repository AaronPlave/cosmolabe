import type { Quaternion, RotationModel } from './RotationModel.js';

/**
 * Interpolated rotation model. SLERP between time-tagged quaternion records.
 *
 * Cosmographia .q file format (ASCII):
 *   Lines starting with '#' are comments.
 *   Data records: JulianDate w x y z
 *   (one record per line, TDB Julian dates, quaternion [w,x,y,z])
 *
 * Times are clamped to the range of available records.
 */
export interface OrientationRecord {
  /** Ephemeris time (seconds past J2000 TDB) */
  et: number;
  /** Orientation quaternion [w, x, y, z] */
  q: Quaternion;
}

export class InterpolatedRotation implements RotationModel {
  private readonly records: OrientationRecord[];

  constructor(records: OrientationRecord[]) {
    // Sort by time (should already be sorted, but be safe)
    this.records = [...records].sort((a, b) => a.et - b.et);
  }

  rotationAt(et: number): Quaternion {
    if (this.records.length === 0) return [1, 0, 0, 0];
    if (this.records.length === 1 || et <= this.records[0].et) {
      return [...this.records[0].q] as Quaternion;
    }
    if (et >= this.records[this.records.length - 1].et) {
      return [...this.records[this.records.length - 1].q] as Quaternion;
    }

    // Binary search for the bracketing interval
    let lo = 0;
    let hi = this.records.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (this.records[mid].et <= et) lo = mid;
      else hi = mid;
    }

    const r0 = this.records[lo];
    const r1 = this.records[hi];
    const t = (et - r0.et) / (r1.et - r0.et);

    return slerp(r0.q, r1.q, t);
  }
}

/**
 * Parse a Cosmographia .q file (ASCII quaternion orientation data).
 * Format: lines of "JulianDate w x y z", '#' comments.
 * JD 2451545.0 = J2000.0 epoch.
 */
export function parseQFile(text: string): OrientationRecord[] {
  const records: OrientationRecord[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;

    const jd = parseFloat(parts[0]);
    const w = parseFloat(parts[1]);
    const x = parseFloat(parts[2]);
    const y = parseFloat(parts[3]);
    const z = parseFloat(parts[4]);

    if (isNaN(jd) || isNaN(w) || isNaN(x) || isNaN(y) || isNaN(z)) continue;

    // Convert JD to ET (seconds past J2000 TDB)
    const et = (jd - 2451545.0) * 86400;
    records.push({ et, q: [w, x, y, z] });
  }
  return records;
}

/** Spherical linear interpolation between two unit quaternions. */
function slerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  // Ensure shortest path (dot product positive)
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bSign = dot < 0 ? -1 : 1;
  dot = Math.abs(dot);

  let s0: number, s1: number;
  if (dot > 0.9995) {
    // Nearly identical — linear interpolation to avoid division by zero
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sinTheta;
    s1 = Math.sin(t * theta) / sinTheta;
  }

  s1 *= bSign;
  return [
    s0 * a[0] + s1 * b[0],
    s0 * a[1] + s1 * b[1],
    s0 * a[2] + s1 * b[2],
    s0 * a[3] + s1 * b[3],
  ];
}
