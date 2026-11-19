import type { Body } from '@cosmolabe/core';
import type { RendererPlugin } from '../RendererPlugin.js';
import type { RendererContext } from '../RendererContext.js';
import type { PluginUISlots, InfoSectionResult } from '../PluginUI.js';

/**
 * Stock plugin that provides:
 * - PluginInfoSection: orbital elements for the selected body (in the info panel)
 * - PluginOverlay: compact orbital summary for the tracked body (bottom-right HUD)
 *
 * Computes orbital elements from the body's state vector relative to its parent.
 */
export class OrbitalInfoPlugin implements RendererPlugin {
  readonly name = 'orbital-info';

  readonly ui: PluginUISlots = {
    infoSections: [
      {
        id: 'orbital-elements',
        label: 'Orbital Elements',
        order: 10,
        render: (body: Body, et: number, ctx: RendererContext): InfoSectionResult | null => {
          // Covers the body's own data and everything it is placed relative to.
          if (!ctx.universe.stateAvailability(body.name, et).position.available) return null;
          const elems = this.computeElements(body, et);
          if (!elems) return null;
          return {
            rows: [
              ...(elems.a != null ? [{ label: 'Semi-Major Axis', value: this.fmtDist(elems.a) }] : []),
              { label: 'Eccentricity', value: elems.ecc.toFixed(4) },
              { label: 'Inclination', value: `${elems.inc.toFixed(2)}`, unit: '\u00B0' },
              { label: 'Periapsis', value: this.fmtDist(elems.periapsis) },
              ...(elems.apoapsis != null ? [{ label: 'Apoapsis', value: this.fmtDist(elems.apoapsis) }] : []),
              ...(elems.period != null ? [{ label: 'Period', value: this.fmtPeriod(elems.period) }] : []),
            ],
          };
        },
      },
    ],
  };

  private computeElements(body: Body, et: number): OrbitalElements | null {
    if (!body.parentName) return null;
    const mu = this.getParentGM(body.parentName);
    if (!mu) return null;

    let state;
    try { state = body.stateAt(et); } catch { return null; }
    if (!state || ![...state.position, ...state.velocity].every(Number.isFinite)) return null;
    return conicElements(state.position, state.velocity, mu, body.parentName);
  }

  private getParentGM(parentName: string): number | null {
    // GM values in km³/s² for common bodies
    const GM: Record<string, number> = {
      'Sun': 132712440041.94,
      'SSB': 132712440041.94,
      'Mercury': 22031.86,
      'Venus': 324858.59,
      'Earth': 398600.44,
      'Moon': 4902.80,
      'Mars': 42828.37,
      'Jupiter': 126686531.9,
      'Saturn': 37931206.16,
      'Uranus': 5793951.3,
      'Neptune': 6835100.0,
      'Pluto': 869.6,
      'Ceres': 62.63,
    };
    return GM[parentName] ?? null;
  }

  private fmtDist(km: number): string {
    const abs = Math.abs(km);
    if (abs < 1) return `${(km * 1000).toFixed(0)} m`;
    if (abs < 1000) return `${km.toFixed(1)} km`;
    if (abs < 1e6) return `${(km / 1000).toFixed(1)}K km`;
    if (abs < 1e9) return `${(km / 1e6).toFixed(2)}M km`;
    return `${(km / 1.496e8).toFixed(3)} AU`;
  }

  private fmtPeriod(seconds: number): string {
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hr`;
    if (seconds < 86400 * 365.25) return `${(seconds / 86400).toFixed(1)} d`;
    return `${(seconds / (86400 * 365.25)).toFixed(2)} yr`;
  }
}

export interface OrbitalElements {
  a: number | null;   // semi-major axis (km), null for a parabola
  ecc: number;        // eccentricity
  inc: number;        // inclination (deg)
  period: number | null;  // orbital period (s), null for hyperbolic
  periapsis: number;  // periapsis distance (km)
  apoapsis: number | null; // apoapsis distance (km), null for hyperbolic
  r: number;          // current radius (km)
  v: number;          // current speed (km/s)
  parentName: string;
}

/**
 * Osculating elements of a two-body state, or null where they are undefined:
 * no motion, or motion along the radius (no orbital plane). Periapsis comes
 * from the semi-latus rectum, which stays finite through a parabola where the
 * semi-major axis does not.
 */
export function conicElements(
  position: readonly number[], velocity: readonly number[], mu: number, parentName: string,
): OrbitalElements | null {
  const [x, y, z] = position;
  const [vx, vy, vz] = velocity;
  const r = Math.hypot(x, y, z);
  const v = Math.hypot(vx, vy, vz);
  if (!(r > 0) || !(v > 0)) return null;

  const hx = y * vz - z * vy;
  const hy = z * vx - x * vz;
  const hz = x * vy - y * vx;
  const h = Math.hypot(hx, hy, hz);
  // Relative test: a rectilinear state has no plane, so no inclination or periapsis.
  if (!(h > 1e-12 * r * v)) return null;

  const inc = Math.acos(Math.max(-1, Math.min(1, hz / h))) * (180 / Math.PI);
  const ex = (vy * hz - vz * hy) / mu - x / r;
  const ey = (vz * hx - vx * hz) / mu - y / r;
  const ez = (vx * hy - vy * hx) / mu - z / r;
  const ecc = Math.hypot(ex, ey, ez);
  const p = (h * h) / mu;

  const parabolic = Math.abs(1 - ecc) < 1e-9;
  const a = parabolic ? null : p / (1 - ecc * ecc);
  const periapsis = p / (1 + ecc);
  const apoapsis = ecc < 1 && !parabolic ? p / (1 - ecc) : null;
  const period = a != null && a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : null;

  const out = { a, ecc, inc, period, periapsis, apoapsis, r, v, parentName };
  const finite = (n: number | null) => n == null || Number.isFinite(n);
  return [a, ecc, inc, period, periapsis, apoapsis].every(finite) ? out : null;
}
