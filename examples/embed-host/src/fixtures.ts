/**
 * Deterministic, physically consistent spacecraft truth for the reference
 * host — computed here from closed-form orbits and attitude laws, with no
 * Cosmolabe code, so the viewer's answers can be checked against it.
 *
 * The two spacecraft deliberately differ in every convention a source can
 * declare, so a frame, unit, time-scale or quaternion mistake shows up as a
 * large, assertable error rather than a subtle one:
 *
 * | | SC-1 | SC-2 |
 * |---|---|---|
 * | orbit | circular LEO, i = 51.6° | elliptical HEO, e = 0.6 |
 * | frame | J2000 (Earth equator) | ECLIPJ2000 |
 * | units | km, km/s | m, m/s |
 * | time tags | UTC ISO strings | TDB seconds past J2000 |
 * | attitude | LVLH (X along-track, Z nadir) | spin about a fixed axis |
 * | quaternion | scalar-first, reference→body | scalar-last, body→reference |
 */
import { etFromCalendarString, type CatalogJson } from '@cosmolabe/viewer';

export const MU_EARTH = 398600.4418; // km³/s²
/** Scenario start (UTC) and its ET through the leap-second-exact pathway. */
export const T0_UTC = '2026-03-20T12:00:00Z';
export const T0 = etFromCalendarString(T0_UTC);
export const HOURS = 3600;

type V3 = [number, number, number];
type M3 = [number, number, number, number, number, number, number, number, number]; // row-major

const norm = (v: V3) => Math.hypot(v[0], v[1], v[2]);
const scale = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];
const unit = (v: V3) => scale(v, 1 / norm(v));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Rotation matrix whose columns are the body X, Y, Z axes in the reference frame (body → reference). */
const columns = (x: V3, y: V3, z: V3): M3 => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
const transpose = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Scalar-first unit quaternion q with v' = q v q* equal to M v. */
function quatOf(m: M3): [number, number, number, number] {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  return q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/** Rotate `v` by the scalar-first quaternion `q` (v' = q v q*). */
export function rotate(q: readonly number[], v: V3): V3 {
  const [w, x, y, z] = q;
  return [
    (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y - w * z) * v[1] + 2 * (x * z + w * y) * v[2],
    2 * (x * y + w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z - w * x) * v[2],
    2 * (x * z - w * y) * v[0] + 2 * (y * z + w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2],
  ];
}

/** Rotate `v` by the inverse of `q`: given q mapping reference→body coordinates, a body axis in the reference frame. */
export const bodyAxisInReference = (q: readonly number[], axis: V3): V3 => rotate([q[0], -q[1], -q[2], -q[3]], axis);

// ── SC-1: circular LEO in J2000 ──

const SC1 = { a: 6878, inc: (51.6 * Math.PI) / 180, raan: (40 * Math.PI) / 180, u0: 0 };
const SC1_N = Math.sqrt(MU_EARTH / SC1.a ** 3);

export function sc1State(et: number): { position: V3; velocity: V3 } {
  const u = SC1.u0 + SC1_N * (et - T0);
  const [cO, sO, ci, si, cu, su] = [Math.cos(SC1.raan), Math.sin(SC1.raan), Math.cos(SC1.inc), Math.sin(SC1.inc), Math.cos(u), Math.sin(u)];
  const position: V3 = [SC1.a * (cO * cu - sO * su * ci), SC1.a * (sO * cu + cO * su * ci), SC1.a * su * si];
  const k = SC1.a * SC1_N;
  const velocity: V3 = [k * (-cO * su - sO * cu * ci), k * (-sO * su + cO * cu * ci), k * cu * si];
  return { position, velocity };
}

/** LVLH: X along velocity, Z toward Earth (nadir), Y completing the triad. Reference→body, scalar-first. */
export function sc1Attitude(et: number): [number, number, number, number] {
  const { position, velocity } = sc1State(et);
  const z = unit(scale(position, -1));
  const x = unit(velocity);
  const y = cross(z, x);
  return quatOf(transpose(columns(x, y, z)));
}

// ── SC-2: elliptical orbit stated in ECLIPJ2000, spinning about a fixed axis ──

const SC2 = { a: 26600, e: 0.6, inc: (30 * Math.PI) / 180, raan: (100 * Math.PI) / 180, argp: (60 * Math.PI) / 180 };
/** Perigee passage, seconds after T0 — inside the data, so the fast pass is exercised. */
export const SC2_PERIGEE = 2 * 3600;
const SC2_N = Math.sqrt(MU_EARTH / SC2.a ** 3);
export const SC2_PERIOD = (2 * Math.PI) / SC2_N;

export function sc2State(et: number): { position: V3; velocity: V3 } {
  const M = SC2_N * (et - T0 - SC2_PERIGEE);
  let E = M;
  for (let k = 0; k < 50; k++) E -= (E - SC2.e * Math.sin(E) - M) / (1 - SC2.e * Math.cos(E));
  const b = SC2.a * Math.sqrt(1 - SC2.e ** 2);
  const pq: V3 = [SC2.a * (Math.cos(E) - SC2.e), b * Math.sin(E), 0];
  const edot = SC2_N / (1 - SC2.e * Math.cos(E));
  const vq: V3 = [-SC2.a * Math.sin(E) * edot, b * Math.cos(E) * edot, 0];
  const [cO, sO, ci, si, cw, sw] = [Math.cos(SC2.raan), Math.sin(SC2.raan), Math.cos(SC2.inc), Math.sin(SC2.inc), Math.cos(SC2.argp), Math.sin(SC2.argp)];
  const R: M3 = [
    cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si,
    sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si,
    sw * si, cw * si, ci,
  ];
  const apply = (v: V3): V3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
  return { position: apply(pq), velocity: apply(vq) };
}

/** The spin axis (body +Z), fixed in ECLIPJ2000. */
export const SC2_SPIN_AXIS: V3 = unit([0.3, -0.5, 0.81]);
const SPIN_RATE = (2 * Math.PI) / 180; // 2°/s
const B0x = unit(cross([0, 0, 1], SC2_SPIN_AXIS));
const B0y = cross(SC2_SPIN_AXIS, B0x);

/** Body→reference (ECLIPJ2000) quaternion, scalar-first. */
export function sc2BodyToReference(et: number): [number, number, number, number] {
  const th = SPIN_RATE * (et - T0);
  const x: V3 = [0, 1, 2].map((k) => Math.cos(th) * B0x[k] + Math.sin(th) * B0y[k]) as V3;
  const y = cross(SC2_SPIN_AXIS, x);
  return quatOf(columns(x, y, SC2_SPIN_AXIS));
}

// ── Coverage (seconds after T0) ──

export const COVERAGE = {
  sc1: { start: 0, end: 4 * HOURS, positionGap: [3600, 3900] as const, attitudeGap: [5400, 5700] as const, step: 20, spacing: 30 },
  sc2: { start: 0, end: 4 * HOURS, attitudeEnd: 2 * HOURS, positionStep: 60, positionSpacing: 90, attitudeStep: 10, attitudeSpacing: 15 },
};

/** The catalog the host shows: Sun, Earth, and two spacecraft bound to host sources. */
export function sceneCatalog(withSc2 = true): CatalogJson {
  const iso = new Date(Date.parse(T0_UTC) + 30 * 60_000).toISOString().replace('.000', '');
  const spacecraft = (name: string, source: string, color: number[]) => ({
    name, class: 'spacecraft', center: 'Earth',
    trajectory: { type: 'MissionState', source },
    rotationModel: { type: 'MissionState', source },
    geometry: { type: 'Mesh', source: 'spacecraft.gltf', size: 0.4 },
    trajectoryPlot: { duration: '1.5h', fade: 0.3, color },
    label: { color },
  });
  return {
    name: withSc2 ? 'Embed host fixture' : 'Embed host fixture (SC-1 only)',
    defaultTime: iso,
    defaultViewpoint: 'Earth orbit',
    // Catalog-owned, beside the host's: a host update must never touch it.
    activities: [{
      version: 1, id: 'catalog-campaign', name: 'Commissioning campaign', kind: 'phase', vehicle: 'SC-1', body: 'Earth', temporality: 'interval',
      timeSystem: 'UTC', start: T0_UTC, end: new Date(Date.parse(T0_UTC) + 4 * HOURS * 1000).toISOString().replace('.000', ''),
      provenance: { source: 'fixture catalog', version: '1', authority: 'authored', timing: 'bounded', limitations: 'Catalog-owned test record.' },
    }],
    items: [
      { name: 'Earth orbit', type: 'Viewpoint', center: 'Earth', distance: 90000, latitude: 35, longitude: 20 },
      { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, geometry: { type: 'Globe', radius: 695000 } },
      {
        name: 'Earth', class: 'planet', center: 'Sun',
        trajectory: { type: 'Keplerian', semiMajorAxis: '1.0au', eccentricity: 0.0167, inclination: 0, ascendingNode: 0, argumentOfPeriapsis: 102.937, meanAnomaly: 357.529, epoch: '2000-01-01T12:00:00Z' },
        rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0], inertialFrame: 'J2000' },
        geometry: { type: 'Globe', radius: 6378 },
        label: { color: [0.4, 0.6, 1.0] },
      },
      spacecraft('SC-1', 'sc1', [0.35, 0.85, 1]),
      ...(withSc2 ? [spacecraft('SC-2', 'sc2', [1, 0.7, 0.3])] : []),
    ] as CatalogJson['items'], // viewpoint items are catalog items the type does not spell out
  };
}

/** Host mission activities, as an ops tool would supply them. */
export function missionPlan() {
  const utc = (s: number) => new Date(Date.parse(T0_UTC) + s * 1000).toISOString().replace('.000', '');
  const provenance = { source: 'embed-host fixture plan', version: '1', authority: 'authored' as const, timing: 'exact' as const, limitations: 'Synthetic test plan.' };
  return [
    { version: 1 as const, id: 'sc1-downlink-1', name: 'Downlink pass', kind: 'other' as const, vehicle: 'SC-1', body: 'Earth', temporality: 'interval' as const, timeSystem: 'UTC' as const, start: utc(600), end: utc(1500), provenance },
    { version: 1 as const, id: 'sc1-trim-1', name: 'Orbit trim', kind: 'other' as const, vehicle: 'SC-1', body: 'Earth', temporality: 'instant' as const, timeSystem: 'UTC' as const, start: utc(4500), end: utc(4500), provenance },
    { version: 1 as const, id: 'sc2-perigee-1', name: 'Perigee pass', kind: 'phase' as const, vehicle: 'SC-2', body: 'Earth', temporality: 'interval' as const, timeSystem: 'ET' as const, start: T0 + SC2_PERIGEE - 900, end: T0 + SC2_PERIGEE + 900, provenance },
    { version: 1 as const, id: 'sc2-imaging-1', name: 'Imaging window', kind: 'other' as const, vehicle: 'SC-2', body: 'Earth', temporality: 'interval' as const, timeSystem: 'ET' as const, start: T0 + 2400, end: T0 + 3300, provenance },
  ];
}
