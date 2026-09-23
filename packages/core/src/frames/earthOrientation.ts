import type { RotationMatrix } from '../spice-injection.js';
import { deltaAtSeconds, J2000_UNIX_MS } from '../time.js';
import { mat3Mul, rotX, rotY, rotZ } from './mat3.js';

/**
 * Analytical Earth orientation for the SPICE-free frame path: IAU-1976
 * precession, IAU-1980 nutation (truncated) and IAU-1982 GMST. These are the
 * models TEME is defined against (Vallado et al., "Revisiting Spacetrack
 * Report #3", AIAA 2006-6753), so TLE output rotates into J2000 with the same
 * theory SGP4 assumed.
 *
 * Accuracy, measured in the frame tests:
 *  - Precession is the full IAU-1976 polynomial.
 *  - Nutation keeps the 20 largest IAU-1980 terms (every term ≥ 0.0046″). The
 *    dropped tail sums to well under 0.05″, which is ~1.5 m at LEO radius.
 *  - GMST takes UT1 ≈ UTC. |UT1−UTC| < 0.9 s, which is up to ~0.4 km of
 *    along-track displacement at the equatorial surface for ITRF. Where the
 *    binary Earth PCK is furnished, SPICE's ITRF93 replaces this path.
 *  - Polar motion is neglected (~10 m at the surface), so ITRF here is PEF.
 *
 * ET is treated as TT (|TDB−TT| < 2 ms), which is below every figure above.
 */

const ARCSEC = Math.PI / (180 * 3600);
const DEG = Math.PI / 180;
const SEC_PER_CENTURY = 36525 * 86400;

/** Julian centuries of TT past J2000. */
function centuriesTT(et: number): number {
  return et / SEC_PER_CENTURY;
}

/** Mean obliquity of the ecliptic of date, IAU-1976, radians. */
export function meanObliquity(et: number): number {
  const T = centuriesTT(et);
  return (84381.448 - 46.815 * T - 0.00059 * T * T + 0.001813 * T * T * T) * ARCSEC;
}

/** IAU-1976 precession: J2000 mean equator/equinox → mean of date (MOD). */
export function precessionMatrix(et: number): RotationMatrix {
  const T = centuriesTT(et);
  const T2 = T * T;
  const T3 = T2 * T;
  const zeta = (2306.2181 * T + 0.30188 * T2 + 0.017998 * T3) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T2 - 0.041833 * T3) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T2 + 0.018203 * T3) * ARCSEC;
  // r_MOD = R3(-z) R2(θ) R3(-ζ) r_J2000
  return mat3Mul(rotZ(-z), mat3Mul(rotY(theta), rotZ(-zeta)));
}

/**
 * The leading IAU-1980 nutation terms, in 0.0001″:
 * [D, M, M′, F, Ω, ψ sin coeff, ψ T-rate, ε cos coeff, ε T-rate].
 */
const NUTATION_1980: ReadonlyArray<readonly number[]> = [
  [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
  [-2, 0, 0, 2, 2, -13187, -1.6, 5736, -3.1],
  [0, 0, 0, 2, 2, -2274, -0.2, 977, -0.5],
  [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
  [0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
  [0, 0, 1, 0, 0, 712, 0.1, -7, 0],
  [-2, 1, 0, 2, 2, -517, 1.2, 224, -0.6],
  [0, 0, 0, 2, 1, -386, -0.4, 200, 0],
  [0, 0, 1, 2, 2, -301, 0, 129, -0.1],
  [-2, -1, 0, 2, 2, 217, -0.5, -95, 0.3],
  [-2, 0, 1, 0, 0, -158, 0, 0, 0],
  [-2, 0, 0, 2, 1, 129, 0.1, -70, 0],
  [0, 0, -1, 2, 2, 123, 0, -53, 0],
  [2, 0, 0, 0, 0, 63, 0, 0, 0],
  [0, 0, 1, 0, 1, 63, 0.1, -33, 0],
  [2, 0, -1, 2, 2, -59, 0, 26, 0],
  [0, 0, -1, 0, 1, -58, -0.1, 32, 0],
  [0, 0, 1, 2, 1, -51, 0, 27, 0],
  [-2, 0, 2, 0, 0, 48, 0, 0, 0],
  [0, 0, -2, 2, 1, 46, 0, -24, 0],
];

/** Nutation in longitude and obliquity (Δψ, Δε), radians. */
export function nutationAngles(et: number): { dpsi: number; deps: number } {
  const T = centuriesTT(et);
  const T2 = T * T;
  const T3 = T2 * T;
  // Delaunay arguments, degrees (Meeus ch. 22, the IAU-1980 series' own).
  const D = (297.85036 + 445267.11148 * T - 0.0019142 * T2 + T3 / 189474) * DEG;
  const M = (357.52772 + 35999.05034 * T - 0.0001603 * T2 - T3 / 300000) * DEG;
  const Mp = (134.96298 + 477198.867398 * T + 0.0086972 * T2 + T3 / 56250) * DEG;
  const F = (93.27191 + 483202.017538 * T - 0.0036825 * T2 + T3 / 327270) * DEG;
  const Om = (125.04452 - 1934.136261 * T + 0.0020708 * T2 + T3 / 450000) * DEG;
  let dpsi = 0;
  let deps = 0;
  for (const [d, m, mp, f, om, ps, pst, ec, ect] of NUTATION_1980) {
    const arg = d * D + m * M + mp * Mp + f * F + om * Om;
    dpsi += (ps + pst * T) * Math.sin(arg);
    deps += (ec + ect * T) * Math.cos(arg);
  }
  return { dpsi: dpsi * 1e-4 * ARCSEC, deps: deps * 1e-4 * ARCSEC };
}

/** IAU-1980 nutation: mean of date (MOD) → true of date (TOD). */
export function nutationMatrix(et: number): RotationMatrix {
  const eps = meanObliquity(et);
  const { dpsi, deps } = nutationAngles(et);
  // r_TOD = R1(-(ε+Δε)) R3(-Δψ) R1(ε) r_MOD
  return mat3Mul(rotX(-(eps + deps)), mat3Mul(rotZ(-dpsi), rotX(eps)));
}

/** Equation of the equinoxes as TEME uses it (Δψ cos ε̄, no kinematic terms). */
export function equationOfEquinoxes(et: number): number {
  return nutationAngles(et).dpsi * Math.cos(meanObliquity(et));
}

/** Greenwich mean sidereal time (IAU-1982), radians, with UT1 ≈ UTC. */
export function gmst(et: number): number {
  const deltaAt = deltaAtSeconds(J2000_UNIX_MS + et * 1000);
  // UTC = TT − 32.184 s − ΔAT; Julian centuries from 2000-01-01T12:00 UTC.
  const tu = (et - 32.184 - deltaAt) / SEC_PER_CENTURY;
  const seconds =
    67310.54841 + (876600 * 3600 + 8640184.812866) * tu + 0.093104 * tu * tu - 6.2e-6 * tu * tu * tu;
  const s = ((seconds % 86400) + 86400) % 86400;
  return (s / 86400) * 2 * Math.PI;
}

/** J2000 → MOD. */
export function j2000ToMod(et: number): RotationMatrix {
  return precessionMatrix(et);
}

/** J2000 → TOD. */
export function j2000ToTod(et: number): RotationMatrix {
  return mat3Mul(nutationMatrix(et), precessionMatrix(et));
}

/** J2000 → TEME: TOD rotated about the true pole by the equation of the equinoxes. */
export function j2000ToTeme(et: number): RotationMatrix {
  return mat3Mul(rotZ(equationOfEquinoxes(et)), j2000ToTod(et));
}

/** J2000 → Earth-fixed (PEF, standing in for ITRF): TEME rotated by GMST. */
export function j2000ToEarthFixed(et: number): RotationMatrix {
  return mat3Mul(rotZ(gmst(et)), j2000ToTeme(et));
}
