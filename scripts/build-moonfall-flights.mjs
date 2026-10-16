#!/usr/bin/env node
/**
 * Generate the MoonFall catalog.
 *
 * JPL's MoonFall (launch 2028) flies 4 hoppers at the lunar south pole for one
 * lunar day; lunar night freezes the remaining fuel, and each hopper then runs
 * a survive-the-night payload at its final site. The flights here are authored,
 * not the mission's plan: hoppers exploring the Shackleton rim and PSR floor
 * over a 14-day window starting Dec 2028. No EDL — just Waypoints trajectories
 * showing what a coordinated multi-hopper sortie looks like in 3D.
 *
 *   - Polaris-A starts on the NW rim, sortie-dives into the PSR floor.
 *   - Polaris-B traverses the rim sampling regolith at peaks-of-eternal-light.
 *   - Polaris-C explores the inner crater wall on the south side.
 *   - Polaris-D does long-range hops connecting Shackleton to adjacent craters.
 *
 * Each hopper does 3 flights over ~14 days (rest periods are for thermal /
 * power margin).
 *
 * Authoring vs runtime: waypoints below specify (lat, lon, altM_above_terrain)
 * for human readability — "fly to lat X, lon Y, 80 m above the ground". The
 * build script samples the ground at each waypoint from the Moon terrain the
 * catalog draws — the cube-sphere product pinned in
 * scripts/data-hosting/datasets.json (#149), on its finest CPU grid, which is
 * the same lattice triangles the finest .glb tile renders — adds the authored
 * altM offset, and emits ABSOLUTE altitudes (km above the 1737.4 km lunar mean
 * radius) with `useAbsoluteAlt: true`. The renderer treats those waypoints as
 * fixed Cartesian positions — no runtime terrain-clamp pipeline involved — and a
 * landed hopper sits its altM above the drawn surface. Sampling a different
 * DEM (the LOLA 118 m global, before #149) left landed hoppers up to 17 m
 * inside or above the cube terrain.
 *
 * Sampled elevations are cached with the product revision in
 * scripts/data/moon-elevations-cube.json, so rebuilding needs the product only
 * when a waypoint or the pinned revision changes. scripts/data/moon-elevations.json
 * keeps the LOLA 118 m samples as control points for validate-cube-terrain.mjs.
 *
 * Output: apps/viewer/test-catalogs/moonfall-shackleton.json
 *
 * Run: node scripts/build-moonfall-flights.mjs [--grids DIR/cpu-grids.json | URL]
 *   (needs `npm run build`, and the pinned product's grids when the cache is stale;
 *   default: the dataset's localDir)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'apps', 'viewer', 'test-catalogs', 'moonfall-shackleton.json');
const CACHE_DIR = join(__dirname, 'data');
const CACHE_FILE = join(CACHE_DIR, 'moon-elevations-cube.json');
const ROOT = join(__dirname, '..');
const DATASETS = JSON.parse(readFileSync(join(__dirname, 'data-hosting', 'datasets.json'), 'utf8')).datasets;
const TERRAIN = DATASETS['cube-terrain/moon-terrain-cube'];
const IMAGERY = DATASETS['cube-imagery/moon-imagery-cube-wac-nac'];
const { values: opt } = parseArgs({ options: { grids: { type: 'string' } } });

const MISSION = {
  catalogName: 'MoonFall at Shackleton',
  // Mid-coordinated-first-burst — all 4 hoppers airborne. See per-hopper
  // flight epochs below; flights 1 of all 4 hoppers start at 10:00 UTC and
  // overlap until ~10:08.
  defaultTime: '2028-12-15T10:04:00Z',
  defaultViewpoint: 'Shackleton Overview',
};

// Each waypoint: t (seconds from flight epoch), lat (deg), lon (deg), altM (meters above terrain).
const hoppers = [
  {
    name: 'Polaris-A',
    color: [0.4, 0.85, 1.0],
    base: { lat: -89.55, lon: -45 },
    flights: [
      {
        epoch: '2028-12-15T10:00:00Z',
        label: 'PSR floor sample run',
        waypoints: [
          { t:   0, lat: -89.55, lon: -45, altM:   1 },  // takeoff
          { t:  25, lat: -89.55, lon: -45, altM:  80 },  // climb
          { t:  90, lat: -89.62, lon: -30, altM: 140 },  // cruise toward crater
          { t: 160, lat: -89.69, lon: -10, altM:  90 },  // descent into PSR
          { t: 200, lat: -89.71, lon:  -2, altM:   5 },  // touchdown for sample
          { t: 260, lat: -89.71, lon:  -2, altM:  90 },  // climb out
          { t: 330, lat: -89.62, lon: -30, altM: 140 },  // return cruise
          { t: 400, lat: -89.55, lon: -45, altM:  60 },  // approach
          { t: 430, lat: -89.55, lon: -45, altM:   1 },  // landing
        ],
      },
      {
        epoch: '2028-12-17T22:00:00Z',
        label: 'PSR transect — west half',
        waypoints: [
          { t:   0, lat: -89.55, lon: -45, altM:   1 },
          { t:  25, lat: -89.55, lon: -45, altM:  70 },
          { t: 110, lat: -89.65, lon: -35, altM: 110 },
          { t: 180, lat: -89.72, lon: -25, altM:  40 },  // low cruise over PSR floor
          { t: 240, lat: -89.78, lon: -15, altM:  40 },
          { t: 300, lat: -89.78, lon: -15, altM:   5 },  // touchdown
          { t: 360, lat: -89.78, lon: -15, altM:  70 },
          { t: 440, lat: -89.65, lon: -35, altM: 130 },
          { t: 510, lat: -89.55, lon: -45, altM:  60 },
          { t: 540, lat: -89.55, lon: -45, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-22T14:00:00Z',
        label: 'Ridge climb to rim peak',
        waypoints: [
          { t:   0, lat: -89.55, lon: -45, altM:   1 },
          { t:  30, lat: -89.55, lon: -45, altM:  90 },
          { t: 100, lat: -89.52, lon: -55, altM: 180 },  // climb to elevated rim
          { t: 170, lat: -89.50, lon: -65, altM: 240 },  // PEoL summit candidate
          { t: 230, lat: -89.50, lon: -65, altM:   5 },  // perch
          { t: 320, lat: -89.50, lon: -65, altM: 240 },
          { t: 390, lat: -89.52, lon: -55, altM: 180 },
          { t: 460, lat: -89.55, lon: -45, altM:  60 },
          { t: 490, lat: -89.55, lon: -45, altM:   1 },
        ],
      },
    ],
  },
  {
    name: 'Polaris-B',
    color: [1.0, 0.65, 0.3],
    base: { lat: -89.40, lon: 30 },
    flights: [
      {
        epoch: '2028-12-15T10:00:00Z',
        label: 'Rim traverse east',
        waypoints: [
          { t:   0, lat: -89.40, lon:  30, altM:   1 },
          { t:  25, lat: -89.40, lon:  30, altM:  80 },
          { t: 110, lat: -89.42, lon:  55, altM: 110 },
          { t: 200, lat: -89.45, lon:  85, altM: 110 },
          { t: 240, lat: -89.45, lon:  85, altM:   5 },
          { t: 310, lat: -89.45, lon:  85, altM:  90 },
          { t: 380, lat: -89.42, lon:  55, altM: 130 },
          { t: 460, lat: -89.40, lon:  30, altM:  60 },
          { t: 490, lat: -89.40, lon:  30, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-19T06:00:00Z',
        label: 'Sun-illuminated peak sampling',
        waypoints: [
          { t:   0, lat: -89.40, lon:  30, altM:   1 },
          { t:  30, lat: -89.40, lon:  30, altM: 100 },
          { t:  90, lat: -89.36, lon:  20, altM: 220 },  // toward peaks-of-eternal-light
          { t: 150, lat: -89.34, lon:  10, altM: 220 },
          { t: 190, lat: -89.34, lon:  10, altM:   5 },
          { t: 260, lat: -89.34, lon:  10, altM: 220 },
          { t: 330, lat: -89.38, lon:  25, altM: 160 },
          { t: 400, lat: -89.40, lon:  30, altM:  60 },
          { t: 430, lat: -89.40, lon:  30, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-26T11:00:00Z',
        label: 'Long hop to neighboring rim site',
        waypoints: [
          { t:   0, lat: -89.40, lon:  30, altM:   1 },
          { t:  30, lat: -89.40, lon:  30, altM: 100 },
          { t: 150, lat: -89.36, lon:  60, altM: 160 },
          { t: 280, lat: -89.32, lon:  95, altM: 200 },
          { t: 380, lat: -89.30, lon: 120, altM: 100 },
          { t: 420, lat: -89.30, lon: 120, altM:   1 },  // new landing site (one-way; rest of mission is data uplink)
        ],
      },
    ],
  },
  {
    name: 'Polaris-C',
    color: [0.85, 0.4, 1.0],
    base: { lat: -89.78, lon: 90 },
    flights: [
      {
        epoch: '2028-12-15T10:00:00Z',
        label: 'Crater inner-wall transect',
        waypoints: [
          { t:   0, lat: -89.78, lon:  90, altM:   1 },
          { t:  25, lat: -89.78, lon:  90, altM:  80 },
          { t: 100, lat: -89.75, lon:  75, altM: 110 },
          { t: 180, lat: -89.73, lon:  50, altM:  80 },
          { t: 240, lat: -89.73, lon:  50, altM:   5 },
          { t: 310, lat: -89.73, lon:  50, altM:  90 },
          { t: 390, lat: -89.75, lon:  75, altM: 130 },
          { t: 470, lat: -89.78, lon:  90, altM:  60 },
          { t: 500, lat: -89.78, lon:  90, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-20T15:00:00Z',
        label: 'PSR floor exploration',
        waypoints: [
          { t:   0, lat: -89.78, lon:  90, altM:   1 },
          { t:  25, lat: -89.78, lon:  90, altM:  70 },
          { t: 110, lat: -89.75, lon:  60, altM:  60 },  // low cruise PSR
          { t: 190, lat: -89.72, lon:  30, altM:  40 },
          { t: 240, lat: -89.72, lon:  30, altM:   5 },
          { t: 320, lat: -89.72, lon:  30, altM:  60 },
          { t: 400, lat: -89.75, lon:  60, altM:  90 },
          { t: 480, lat: -89.78, lon:  90, altM:  60 },
          { t: 510, lat: -89.78, lon:  90, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-25T02:00:00Z',
        label: 'Rim south-arc survey',
        waypoints: [
          { t:   0, lat: -89.78, lon:  90, altM:   1 },
          { t:  30, lat: -89.78, lon:  90, altM:  90 },
          { t: 130, lat: -89.80, lon: 130, altM: 130 },
          { t: 240, lat: -89.78, lon: 170, altM: 100 },
          { t: 280, lat: -89.78, lon: 170, altM:   5 },
          { t: 360, lat: -89.78, lon: 170, altM: 100 },
          { t: 470, lat: -89.80, lon: 130, altM: 150 },
          { t: 580, lat: -89.78, lon:  90, altM:  60 },
          { t: 610, lat: -89.78, lon:  90, altM:   1 },
        ],
      },
    ],
  },
  {
    name: 'Polaris-D',
    color: [0.4, 1.0, 0.5],
    base: { lat: -89.50, lon: -135 },
    flights: [
      {
        epoch: '2028-12-15T10:00:00Z',
        label: 'Connector hop to de Gerlache',
        waypoints: [
          { t:   0, lat: -89.50, lon: -135, altM:   1 },
          { t:  30, lat: -89.50, lon: -135, altM: 100 },
          { t: 160, lat: -89.40, lon: -150, altM: 250 },
          { t: 320, lat: -89.20, lon: -160, altM: 250 },  // toward de Gerlache
          { t: 380, lat: -89.10, lon: -160, altM:  40 },
          { t: 420, lat: -89.10, lon: -160, altM:   5 },
          { t: 490, lat: -89.10, lon: -160, altM:  80 },
          { t: 620, lat: -89.30, lon: -155, altM: 200 },
          { t: 750, lat: -89.50, lon: -135, altM:  60 },
          { t: 780, lat: -89.50, lon: -135, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-21T07:30:00Z',
        label: 'PSR oblique entry',
        waypoints: [
          { t:   0, lat: -89.50, lon: -135, altM:   1 },
          { t:  30, lat: -89.50, lon: -135, altM:  80 },
          { t: 120, lat: -89.60, lon: -120, altM:  60 },
          { t: 220, lat: -89.68, lon: -100, altM:  40 },
          { t: 270, lat: -89.68, lon: -100, altM:   5 },
          { t: 340, lat: -89.68, lon: -100, altM:  60 },
          { t: 440, lat: -89.60, lon: -120, altM: 100 },
          { t: 530, lat: -89.50, lon: -135, altM:  60 },
          { t: 560, lat: -89.50, lon: -135, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-27T18:00:00Z',
        label: 'Long traverse to Sverdrup',
        waypoints: [
          { t:   0, lat: -89.50, lon: -135, altM:   1 },
          { t:  30, lat: -89.50, lon: -135, altM: 120 },
          { t: 180, lat: -89.30, lon: -125, altM: 280 },
          { t: 350, lat: -88.85, lon: -110, altM: 280 },  // toward Sverdrup
          { t: 430, lat: -88.65, lon: -100, altM: 100 },
          { t: 480, lat: -88.65, lon: -100, altM:   5 },
          { t: 560, lat: -88.65, lon: -100, altM: 100 },
          { t: 720, lat: -89.15, lon: -120, altM: 250 },
          { t: 880, lat: -89.50, lon: -135, altM:  60 },
          { t: 910, lat: -89.50, lon: -135, altM:   1 },
        ],
      },
    ],
  },
];

// --- Terrain elevation sampling --------------------------------------------

function cacheKey(latDeg, lonDeg) {
  // 5 decimal places ≈ 30 cm at lunar surface — well below DEM sampling resolution
  return `${latDeg.toFixed(5)},${lonDeg.toFixed(5)}`;
}

function collectAllWaypointCoords() {
  const seen = new Set();
  const out = [];
  for (const h of hoppers) {
    for (const f of h.flights) {
      for (const w of f.waypoints) {
        const k = cacheKey(w.lat, w.lon);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ latDeg: w.lat, lonDeg: w.lon });
      }
    }
  }
  return out;
}

/** Ground (m above the 1737.4 km sphere) at every waypoint, on the pinned cube product's finest grid. */
async function ensureElevations() {
  const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
  const allCoords = collectAllWaypointCoords();
  if (cache.revision === TERRAIN.build && allCoords.every(c => cacheKey(c.latDeg, c.lonDeg) in cache.elevations)) {
    console.log(`Elevation cache hit (${allCoords.length} waypoint sites, ${TERRAIN.build}).`);
    return cache.elevations;
  }
  const dist = join(ROOT, 'packages/three/dist/surface/CubeSphereGrids.js');
  if (!existsSync(dist)) throw new Error('packages/three/dist is missing — run `npm run build` first');
  const { CubeSphereGridSource } = await import(pathToFileURL(dist).href);
  const grids = opt.grids ?? join(ROOT, TERRAIN.localDir, 'cpu-grids.json');
  const local = !/^https?:/.test(grids);
  const fetchFile = async (url) => new Response(readFileSync(new URL(url)));
  const source = await CubeSphereGridSource.fromUrl(local ? pathToFileURL(grids).href : grids, local ? { fetch: fetchFile } : {});
  if (source.manifest.source.version !== TERRAIN.build) {
    throw new Error(`${grids} is revision ${source.manifest.source.version}; datasets.json pins ${TERRAIN.build}`);
  }
  await source.ready;
  console.log(`Sampling ${allCoords.length} waypoint sites on ${TERRAIN.build}...`);
  const elevations = {};
  for (const { latDeg, lonDeg } of allCoords) {
    await source.request(latDeg, lonDeg);
    const c = source.coverage(latDeg, lonDeg), sample = source.sampler.sample(latDeg, lonDeg);
    if (c.state !== 'finest' || !sample) throw new Error(`no finest-level ground at ${latDeg}, ${lonDeg} (${c.state})`);
    elevations[cacheKey(latDeg, lonDeg)] = Math.round(sample.elevationKm * 1e6) / 1e3;
  }
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({ revision: TERRAIN.build, grids: 'finest cpu-grids lattice triangles (CubeSphereSampler.sample)', elevations }, null, 2) + '\n');
  console.log(`  wrote ${CACHE_FILE}`);
  return elevations;
}

// --- Build catalog ---------------------------------------------------------

function isoAdd(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function flightArc(flight, elevations) {
  const last = flight.waypoints[flight.waypoints.length - 1];
  return {
    startTime: flight.epoch,
    endTime: isoAdd(flight.epoch, last.t),
    trajectory: {
      type: 'Waypoints',
      referenceRadius: 1737.4,
      epoch: flight.epoch,
      // Absolute altitudes (km above 1737.4 km lunar mean). Pre-computed at
      // build time from the cube terrain's ground + authored altM above terrain.
      useAbsoluteAlt: true,
      waypoints: flight.waypoints.map(w => {
        const groundM = elevations[cacheKey(w.lat, w.lon)] ?? 0;
        const absAltKm = (groundM + w.altM) / 1000;
        return {
          t: w.t,
          lat: w.lat,
          lon: w.lon,
          alt: `${absAltKm.toFixed(6)}km`,
        };
      }),
    },
  };
}

function hopperItem(hopper, elevations) {
  // Between flights, the body sits at its last-flight-landing position. We
  // bridge each pair of arcs with a "rest" arc that uses a 2-point Waypoints
  // trajectory holding the landing site's (lat, lon, abs-alt) constant until
  // the next flight begins.
  const arcs = [];
  for (let i = 0; i < hopper.flights.length; i++) {
    const f = hopper.flights[i];
    arcs.push(flightArc(f, elevations));
    if (i < hopper.flights.length - 1) {
      const restStart = arcs[arcs.length - 1].endTime;
      const next = hopper.flights[i + 1];
      const lastWp = f.waypoints[f.waypoints.length - 1];
      const groundM = elevations[cacheKey(lastWp.lat, lastWp.lon)] ?? 0;
      const absAltKm = (groundM + lastWp.altM) / 1000;
      const altStr = `${absAltKm.toFixed(6)}km`;
      arcs.push({
        startTime: restStart,
        endTime: next.epoch,
        trajectory: {
          type: 'Waypoints',
          referenceRadius: 1737.4,
          epoch: restStart,
          useAbsoluteAlt: true,
          waypoints: [
            { t: 0, lat: lastWp.lat, lon: lastWp.lon, alt: altStr },
            { t: (new Date(next.epoch).getTime() - new Date(restStart).getTime()) / 1000, lat: lastWp.lat, lon: lastWp.lon, alt: altStr },
          ],
        },
      });
    }
  }
  return {
    name: hopper.name,
    class: 'spacecraft',
    trajectoryFrame: 'BodyFixed',
    arcs,
    rotationModel: { type: 'SurfaceUp' },
    geometry: {
      // Reusing the Ingenuity GLB as a stand-in hopper mesh. Swap for a
      // mission-specific drone model when available.
      type: 'Mesh',
      source: 'models/Ingenuity.glb',
      size: 0.0015,
      radii: [0.00075, 0.00075, 0.00075],
      // No surfaceLock — waypoints encode absolute altitudes (terrain + offset
      // baked at build time), so the renderer just plays them through. The
      // SurfaceUp rotation model still orients the mesh nose-up at its lat/lon.
      meshRotation: [0.7071, 0, 0, -0.7071],
      castShadow: true,
    },
    label: { color: hopper.color },
  };
}

const elevations = await ensureElevations();

const catalog = {
  name: MISSION.catalogName,
  defaultTime: MISSION.defaultTime,
  defaultViewpoint: MISSION.defaultViewpoint,
  // Real ephemeris and IAU_MOON (de440s, pck00011): where the Sun and Earth
  // sit in the polar sky — grazing sun, Earth dipping below the horizon — is
  // the point of a south-pole mission.
  require: ['base/naif.json'],
  items: [
    {
      name: 'Shackleton Overview',
      type: 'Viewpoint',
      center: 'Moon',
      distance: 60,
      latitude: -89.6,
      longitude: 0,
    },
    {
      name: 'Polaris-A Close-up',
      type: 'Viewpoint',
      center: 'Polaris-A',
      distance: 0.05,
      latitude: 25,
      longitude: 90,
    },
    {
      name: 'PSR Floor View',
      type: 'Viewpoint',
      center: 'Moon',
      distance: 20,
      latitude: -89.7,
      longitude: -10,
    },
    {
      name: 'Sun',
      class: 'star',
      trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
      geometry: { type: 'Globe', radius: 695000 },
      label: { color: [1.0, 0.9, 0.3] },
    },
    {
      name: 'Earth',
      class: 'planet',
      center: 'Sun',
      trajectory: { type: 'Builtin', name: 'Earth', visible: false },
      geometry: {
        type: 'Globe',
        radius: 6378,
        baseMap: 'textures/earth-5k.jpg',
        atmosphere: 'Earth',
      },
      label: { color: [0.4, 0.6, 1.0] },
    },
    {
      name: 'Moon',
      class: 'moon',
      center: 'Earth',
      trajectory: { type: 'Builtin', name: 'Moon' },
      rotationModel: { type: 'Builtin', name: 'IAU_MOON' },
      geometry: {
        type: 'Globe',
        radius: 1737.4,
        baseMap: 'textures/moon-16k.jpg',
        normalMap: 'textures/moon-normal-16k.jpg',
        displacementMap: 'textures/moon-displacement-2k.jpg',
        displacementScale: 20,
        displacementBias: -9,
        // Cube-sphere terrain, CPU grids and WAC + NAC imagery (#149). The data/
        // paths resolve to test-catalogs/data locally and are pinned to the
        // published builds in datasets.json by build-hosted-catalogs.mjs at deploy.
        // Rollback: the previous block (moon_v14 quantized-mesh + Trek WAC overlay)
        // is in docs/design/cube-sphere-experiment.md, "First migration".
        terrain: {
          type: '3dtiles',
          url: `${TERRAIN.catalogPrefix}tileset.json`,
          errorTarget: 2,
          fadeDurationMs: 0,
          datum: { verticalDatum: 'reference-sphere', heightConvention: 'radial' },
          sourceMetadata: {
            id: 'moon-lola-118m+south-pole-lola-10m-residual (scripts/build-moon-terrain/cube.sh)',
            kind: 'height-grid',
          },
          cubeSphere: {
            cpuGrids: `${TERRAIN.catalogPrefix}cpu-grids.json`,
            imagery: { url: `${IMAGERY.catalogPrefix}imagery.json` },
          },
        },
      },
      label: { color: [0.7, 0.7, 0.7] },
      items: hoppers.map(h => hopperItem(h, elevations)),
    },
  ],
};

writeFileSync(OUT, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Wrote ${OUT}`);
console.log(`  ${hoppers.length} hoppers, ${hoppers.reduce((n, h) => n + h.flights.length, 0)} flights total`);
