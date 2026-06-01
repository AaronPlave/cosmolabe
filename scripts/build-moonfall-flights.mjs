#!/usr/bin/env node
/**
 * Generate the MoonFall synthetic-mission catalog.
 *
 * Mission: 4 lunar hoppers exploring Shackleton crater rim and PSR floor
 * over a 14-day mission window starting Dec 2028. No SPICE, no EDL — just
 * authored Waypoints trajectories showing what a coordinated multi-hopper
 * sortie looks like in 3D.
 *
 *   - Polaris-A starts on the NW rim, sortie-dives into the PSR floor.
 *   - Polaris-B traverses the rim sampling regolith at peaks-of-eternal-light.
 *   - Polaris-C explores the inner crater wall on the south side.
 *   - Polaris-D does long-range hops connecting Shackleton to adjacent craters.
 *
 * Each hopper does 3 flights over ~14 days (rest periods are for thermal /
 * power margin). Per-flight waypoints land at ~5 m altitude (above-terrain
 * clamp gets the rest).
 *
 * Output: apps/viewer/test-catalogs/moonfall-shackleton.json
 *
 * Run: node scripts/build-moonfall-flights.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'apps', 'viewer', 'test-catalogs', 'moonfall-shackleton.json');

// At the lunar pole, longitude wraps wildly while latitude advances slowly.
// We keep coordinates as plain lat/lon — the renderer handles the geometry.
// For human-readable design we just pick lat/lon for each waypoint directly;
// 0.01° of latitude ≈ 300 m, 0.1° of longitude at lat=-89.7° ≈ 530 m.

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

// --- Build catalog ---------------------------------------------------------

function isoAdd(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function flightArc(hopper, flight) {
  const last = flight.waypoints[flight.waypoints.length - 1];
  return {
    startTime: flight.epoch,
    endTime: isoAdd(flight.epoch, last.t),
    trajectory: {
      type: 'Waypoints',
      referenceRadius: 1737.4,
      epoch: flight.epoch,
      waypoints: flight.waypoints.map(w => ({
        t: w.t,
        lat: w.lat,
        lon: w.lon,
        alt: `${w.altM}m`,
      })),
    },
  };
}

function hopperItem(hopper) {
  // Between flights, the body sits at its last-flight-landing position. We
  // bridge each pair of arcs with a "rest" arc that uses a single-waypoint
  // FixedSpherical position at the landing site, sustained until the next
  // flight begins. Cheaper than authoring it via Waypoints (one point).
  const arcs = [];
  for (let i = 0; i < hopper.flights.length; i++) {
    const f = hopper.flights[i];
    arcs.push(flightArc(hopper, f));
    // Rest arc until next flight (if any). We hold position at the flight's
    // last waypoint by emitting a 2-point Waypoints trajectory.
    if (i < hopper.flights.length - 1) {
      const restStart = arcs[arcs.length - 1].endTime;
      const next = hopper.flights[i + 1];
      const lastWp = f.waypoints[f.waypoints.length - 1];
      arcs.push({
        startTime: restStart,
        endTime: next.epoch,
        trajectory: {
          type: 'Waypoints',
          referenceRadius: 1737.4,
          epoch: restStart,
          waypoints: [
            { t: 0, lat: lastWp.lat, lon: lastWp.lon, alt: `${lastWp.altM}m` },
            { t: (new Date(next.epoch).getTime() - new Date(restStart).getTime()) / 1000, lat: lastWp.lat, lon: lastWp.lon, alt: `${lastWp.altM}m` },
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
      surfaceLock: 'aboveTerrain',
      meshRotation: [0.7071, 0, 0, -0.7071],
      castShadow: true,
    },
    label: { color: hopper.color },
  };
}

const catalog = {
  name: MISSION.catalogName,
  defaultTime: MISSION.defaultTime,
  defaultViewpoint: MISSION.defaultViewpoint,
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
      trajectory: { type: 'Builtin', name: 'Earth' },
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
        terrain: {
          type: 'quantized-mesh',
          url: 'https://marshub.s3.amazonaws.com/moon_v14/',
          imagery: {
            url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
            levels: 8,
          },
        },
      },
      label: { color: [0.7, 0.7, 0.7] },
      items: hoppers.map(hopperItem),
    },
  ],
};

writeFileSync(OUT, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Wrote ${OUT}`);
console.log(`  ${hoppers.length} hoppers, ${hoppers.reduce((n, h) => n + h.flights.length, 0)} flights total`);
