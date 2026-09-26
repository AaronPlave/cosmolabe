/**
 * Canonical regression scenes. Each scene is a self-contained catalog + the
 * (small, bundled) kernels it needs, plus metadata describing which bodies have
 * an independent SPICE ground truth (for the oracle tests) and how they chain.
 *
 * `saturn-soi` is the marquee scene: Saturn (analytical Uniform rotation,
 * EquatorJ2000-sourced — the obliquity case), its rings, and J2000-frame moons.
 * It reproduces the cassini-soi.json demo that broke (moons tilted off the ring
 * plane) using only the bundled SOI SCPSE kernel — no large mission kernels.
 *
 * `analytical-no-spice` exercises the same EquatorJ2000→EclipticJ2000 orientation
 * composition with zero kernels, so the obliquity path is still covered even if
 * SPICE init is unavailable.
 */
import type { CatalogJson } from '../../catalog/CatalogLoader.js';
import { buildUniverseFromCatalog, type BuiltScene } from './buildUniverse.js';

/** A body with an independent SPICE ground truth for the oracle tests. */
export interface OracleBody {
  /** Catalog (and Universe) body name. */
  name: string;
  /** SPICE target name/id for spkpos. */
  spiceName: string;
  /** SPICE observer for the per-leg relative-position check (the body's center). */
  spiceCenter: string;
  /** Whether this body has an IAU pole in the loaded PCK for the orientation oracle. */
  hasPole?: boolean;
}

export interface SceneDef {
  name: string;
  catalog: CatalogJson;
  /** Kernel paths relative to packages/spice/test-kernels. Empty ⇒ SPICE-free. */
  kernels: string[];
  defaultTime: string;
  /** Bodies the SPICE oracle can independently verify. */
  oracleBodies: OracleBody[];
}

// ── saturn-soi ───────────────────────────────────────────────────────────────

/** Uniform rotation block copied verbatim from cassini-soi.json as it was before
 *  #118 moved that catalog to SPICE `Builtin` rotations. Kept here as a fixture
 *  of the analytical Uniform path the goldens pin. */
function uniform(period: string, inclination: number, ascendingNode: number, meridianAngle: number) {
  return { type: 'Uniform', period, inclination, ascendingNode, meridianAngle };
}

function moon(
  name: string,
  rotation: ReturnType<typeof uniform>,
  geometry: Record<string, unknown>,
) {
  return {
    name,
    class: 'moon',
    center: 'Saturn',
    trajectoryFrame: 'J2000',
    trajectory: { type: 'Builtin', name },
    rotationModel: rotation,
    geometry,
  };
}

const SATURN_SOI_CATALOG: CatalogJson = {
  name: 'Saturn SOI (regression scene)',
  // Drives CatalogLoader's SPICE-coverage probe epoch — must be inside the SOI
  // SCPSE kernel window, else Builtin moons fall back to analytical theory.
  defaultTime: '2004-07-01T02:48:00',
  items: [
    {
      name: 'Sun',
      class: 'star',
      trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
      geometry: { type: 'Globe', radius: 695000 },
    },
    {
      name: 'Saturn',
      class: 'planet',
      center: 'Sun',
      trajectory: { type: 'Builtin', name: 'Saturn' },
      rotationModel: uniform('10.656222221732387h', 6.463, 130.589, 38.9),
      geometry: { type: 'Globe', radii: [60268, 60268, 54364] },
      items: [
        {
          name: 'Saturn Rings',
          class: 'other',
          center: 'Saturn',
          geometry: { type: 'Rings', innerRadius: 74660, outerRadius: 140220 },
        },
        moon('Mimas', uniform('0.942421810174755d', 6.48, 130.66, 337.46), {
          type: 'Globe',
          radii: [209.1, 196.2, 191.4],
        }),
        moon('Enceladus', uniform('1.370218083712283d', 6.48, 130.66, 2.82), {
          type: 'Globe',
          radii: [256.3, 247.3, 244.6],
        }),
        moon('Tethys', uniform('1.887802560771137d', 6.48, 130.66, 10.45), {
          type: 'Globe',
          radii: [535.6, 528.2, 525.8],
        }),
        moon('Dione', uniform('2.736915552552733d', 6.48, 130.66, 357.0), {
          type: 'Globe',
          radius: 560,
        }),
        moon('Rhea', uniform('4.517502623458083d', 6.45, 140.38, 235.16), {
          type: 'Globe',
          radius: 764,
        }),
        moon('Titan', uniform('15.945447576488629d', 6.06, 126.41, 189.64), {
          type: 'Globe',
          radius: 2575,
        }),
        {
          name: 'Cassini',
          class: 'spacecraft',
          center: 'Saturn',
          trajectoryFrame: 'J2000',
          trajectory: { type: 'Spice', target: 'CASSINI', center: 'SATURN' },
        },
      ],
    },
  ],
} as CatalogJson;

const SATURN_SOI: SceneDef = {
  name: 'saturn-soi',
  catalog: SATURN_SOI_CATALOG,
  // SOI-week SCPSE kernel covers Saturn, all major moons, and Cassini for this epoch.
  kernels: ['naif0012.tls', 'pck00010.tpc', 'cassini/040629AP_SCPSE_04179_04185.bsp'],
  defaultTime: '2004-07-01T02:48:00',
  oracleBodies: [
    { name: 'Saturn', spiceName: 'SATURN', spiceCenter: 'SUN', hasPole: true },
    { name: 'Mimas', spiceName: 'MIMAS', spiceCenter: 'SATURN' },
    { name: 'Enceladus', spiceName: 'ENCELADUS', spiceCenter: 'SATURN' },
    { name: 'Tethys', spiceName: 'TETHYS', spiceCenter: 'SATURN' },
    { name: 'Dione', spiceName: 'DIONE', spiceCenter: 'SATURN' },
    { name: 'Rhea', spiceName: 'RHEA', spiceCenter: 'SATURN' },
    { name: 'Titan', spiceName: 'TITAN', spiceCenter: 'SATURN' },
    { name: 'Cassini', spiceName: 'CASSINI', spiceCenter: 'SATURN' },
  ],
};

// ── analytical-no-spice ───────────────────────────────────────────────────────

const ANALYTICAL_CATALOG: CatalogJson = {
  name: 'Analytical (SPICE-free regression scene)',
  defaultTime: '2004-07-01T02:48:00',
  items: [
    {
      name: 'Sun',
      class: 'star',
      trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
      geometry: { type: 'Globe', radius: 695000 },
    },
    {
      name: 'Earth',
      class: 'planet',
      center: 'Sun',
      // Keplerian elements referenced to ecliptic J2000 (scene frame).
      trajectory: {
        type: 'Keplerian',
        semiMajorAxis: 149597870.7, // 1 au in km
        eccentricity: 0.0167,
        inclination: 0.0,
        ascendingNode: -11.26064,
        argumentOfPeriapsis: 114.20783,
        meanAnomaly: 358.617,
      },
      // EquatorJ2000-sourced Uniform rotation → pole at (RA 0°, Dec 90°), the
      // true celestial pole, which the obliquity composition tilts 23.44° in
      // the ecliptic world frame (Earth's axial tilt).
      rotationModel: uniform('23.9344696h', 0.0, 90.0, 190.147),
      geometry: { type: 'Globe', radii: [6378.137, 6378.137, 6356.752] },
      items: [
        {
          name: 'Moon',
          class: 'moon',
          center: 'Earth',
          trajectory: {
            type: 'Keplerian',
            semiMajorAxis: 384400,
            eccentricity: 0.0549,
            inclination: 5.145,
            ascendingNode: 125.08,
            argumentOfPeriapsis: 318.15,
            meanAnomaly: 135.27,
            period: '27.321661 d',
          },
          geometry: { type: 'Globe', radius: 1737.4 },
        },
      ],
    },
  ],
} as CatalogJson;

const ANALYTICAL: SceneDef = {
  name: 'analytical-no-spice',
  catalog: ANALYTICAL_CATALOG,
  kernels: [],
  defaultTime: '2004-07-01T02:48:00',
  oracleBodies: [],
};

// ── registry ──────────────────────────────────────────────────────────────────

export const SCENES: Record<string, SceneDef> = {
  [SATURN_SOI.name]: SATURN_SOI,
  [ANALYTICAL.name]: ANALYTICAL,
};

/** Build a registered scene by name. */
export async function buildScene(name: string): Promise<BuiltScene> {
  const def = SCENES[name];
  if (!def) throw new Error(`Unknown regression scene: ${name}`);
  return buildUniverseFromCatalog({
    catalog: def.catalog,
    kernels: def.kernels,
    defaultTime: def.defaultTime,
  });
}
