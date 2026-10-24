#!/usr/bin/env node
/**
 * Preprocess NASA's MMGIS Ingenuity datasets into cosmolabe .xyzv trajectory
 * files (one per flight), suitable for InterpolatedStates.
 *
 * Inputs (both vendored from https://mars.nasa.gov/mmgis-maps/M20/Layers/json/):
 *   - m20_heli_flight_path.json  — 2D ground track per flight (LineString)
 *   - m20_heli_waypoints.json    — per-flight metadata: peak alt (Max_Alt_m),
 *                                  landing elevation above Mars geoid
 *                                  (Elev_Geoid), duration, from/to airfield
 *
 * Output:
 *   - apps/viewer/test-catalogs/data/ingenuity/flight_NN.xyzv
 *     One file per flight, "JD x y z vx vy vz" in km / km/s, body-fixed Mars
 *     (IAU_MARS). Catalog uses InterpolatedStates + trajectoryFrame: BodyFixed.
 *
 * Time (legacy interpretation, preserved):
 *   The existing builder treats SCLK_START / SCLK_END as J2000 TDB seconds.
 *   The independent clock conversion has not been established by #246; do not
 *   change source timing while resolving the coordinate/datum audit.
 *
 * Altitude profile (synthesized — MMGIS ground tracks are 2D):
 *   - Takeoff terrain: previous flight's landing Elev_Geoid (= this flight's
 *     `FromAirfld` elevation). Flight 1 uses Flight 0's "deployment" position.
 *   - Cruise: takeoff_terrain + Max_Alt_m above areoid (linearly interpolated
 *     toward landing terrain to handle endpoints at different elevations).
 *   - Linear climb / descent of 5 s each (capped at 30% of duration for
 *     short flights).
 *
 * Legacy reference-frame interpretation — not accepted for cube migration:
 *   This code feeds MMGIS source angles and Elev_Geoid into an ellipsoidal
 *   geodetic conversion without an areoid conversion. The original USGS source
 *   labels declare planetocentric latitude on a spherical map; the MMGIS map
 *   also declares equal radii. An IAU ellipsoid is not the MOLA areoid.
 *
 *   #246's read-only audit quantifies the coordinate alternatives, all 73
 *   controls, and the synthesized profile's clearance failures before any
 *   derived files are regenerated. See docs/validation/ingenuity-jezero/README.md.
 *   Retain this legacy calculation for baseline reproduction pending that gate;
 *   do not interpret its output as independently validated spacecraft placement.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'apps', 'viewer', 'test-catalogs', 'data', 'ingenuity');
const FLIGHT_PATH_PATH = join(DATA_DIR, 'm20_heli_flight_path.json');
const WAYPOINTS_PATH = join(DATA_DIR, 'm20_heli_waypoints.json');

// Legacy conversion parameters. These ellipsoid radii do not make MMGIS
// Elev_Geoid an ellipsoid-normal height or source-map latitude geodetic.
const MARS_IAU_EQUATORIAL_RADIUS_KM = 3396.19;
const MARS_IAU_POLAR_RADIUS_KM = 3376.20;

/**
 * Convert geodetic latitude and ellipsoid-normal height to Cartesian km.
 * The current MMGIS caller does not establish those source semantics; this
 * function reproduces the legacy files, not the proposed areoid-radial model.
 */
function geodeticToBodyFixed(latDeg, lonDeg, heightKm) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const a = MARS_IAU_EQUATORIAL_RADIUS_KM;
  const b = MARS_IAU_POLAR_RADIUS_KM;
  const e2 = 1 - (b / a) * (b / a);
  const N = a / Math.sqrt(1 - e2 * sl * sl);
  return [
    (N + heightKm) * cl * Math.cos(lon),
    (N + heightKm) * cl * Math.sin(lon),
    (N * (1 - e2) + heightKm) * sl,
  ];
}

const JD_J2000 = 2451545.0;

function altitudeAboveTakeoffM(t, totalS, peakM, climbS = 5, landS = 5) {
  const c = Math.min(climbS, totalS * 0.3);
  const l = Math.min(landS, totalS * 0.3);
  if (t <= c) return peakM * (t / c);
  if (t >= totalS - l) return peakM * Math.max(0, (totalS - t) / l);
  return peakM;
}

function buildXyzv(pathFeature, takeoffElevGeoidM, landingElevGeoidM, maxAltM) {
  const flightNum = pathFeature.properties.Flight;
  const coords = pathFeature.geometry.coordinates;
  const etStart = pathFeature.properties.SCLK_START;
  const etEnd = pathFeature.properties.SCLK_END;
  const durationS = etEnd - etStart;
  const n = coords.length;

  // For each sample, ECEF position via standard geodetic-to-Cartesian, with
  // height = interpolated ground elevation (m above MOLA areoid) + altitude
  // profile (m above takeoff terrain).
  //
  // This profile is synthesized from endpoint scalar elevations and the
  // advertised peak, with uniform sample timing. It is not observed vertical
  // telemetry. The #246 audit measures its conditional clearance separately.
  const positions = new Array(n);
  const ets = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * durationS;
    const tFrac = t / durationS;
    const groundElevM = takeoffElevGeoidM + (landingElevGeoidM - takeoffElevGeoidM) * tFrac;
    const altAboveTakeoff_M = altitudeAboveTakeoffM(t, durationS, maxAltM);
    const [lon, lat] = coords[i];
    positions[i] = geodeticToBodyFixed(lat, lon, (groundElevM + altAboveTakeoff_M) / 1000);
    ets[i] = etStart + t;
  }

  const velocities = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(n - 1, i + 1);
    const dt = (ets[hi] - ets[lo]) || 1;
    velocities[i] = [
      (positions[hi][0] - positions[lo][0]) / dt,
      (positions[hi][1] - positions[lo][1]) / dt,
      (positions[hi][2] - positions[lo][2]) / dt,
    ];
  }

  const lines = [
    `# Ingenuity Flight ${flightNum} — peak ${maxAltM} m, duration ${durationS.toFixed(1)} s`,
    `# Body-fixed Mars (IAU_MARS). Position km, velocity km/s, time JD (TDB).`,
    `# Takeoff terrain: ${takeoffElevGeoidM.toFixed(2)} m above MOLA areoid; landing: ${landingElevGeoidM.toFixed(2)} m`,
    `# Datum: IAU 2015 Mars ellipsoid (a=${MARS_IAU_EQUATORIAL_RADIUS_KM}, b=${MARS_IAU_POLAR_RADIUS_KM}) + MMGIS Elev_Geoid`,
    `# Source: MMGIS m20_heli_flight_path.json + m20_heli_waypoints.json`,
  ];
  for (let i = 0; i < n; i++) {
    const jd = JD_J2000 + ets[i] / 86400;
    const [x, y, z] = positions[i];
    const [vx, vy, vz] = velocities[i];
    lines.push(`${jd.toFixed(9)} ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)} ${vx.toExponential(6)} ${vy.toExponential(6)} ${vz.toExponential(6)}`);
  }
  return { content: lines.join('\n') + '\n', samples: n, durationS, etStart, etEnd };
}

function main() {
  const pathGeo = JSON.parse(readFileSync(FLIGHT_PATH_PATH, 'utf-8'));
  const wpsGeo = JSON.parse(readFileSync(WAYPOINTS_PATH, 'utf-8'));
  const wpByFlight = new Map(wpsGeo.features.map(f => [f.properties.Flight, f.properties]));

  // Match path features to waypoints by SCLK time, not by Flight label —
  // MMGIS's path file has Flight 12/13 swapped (and possibly others). The
  // invariant is: path.SCLK_END = wp[Flight].SCLK_START (= when the flight ended,
  // the inter-flight rest period began). Tolerate small drift (< 1 s).
  function findPathFeature(wpStart) {
    return pathGeo.features.find(f => Math.abs(f.properties.SCLK_END - wpStart) < 1);
  }

  console.log(`Path features: ${pathGeo.features.length}, waypoint features: ${wpByFlight.size}`);
  console.log(`Datum: IAU 2015 Mars ellipsoid (a=${MARS_IAU_EQUATORIAL_RADIUS_KM} km, b=${MARS_IAU_POLAR_RADIUS_KM} km) + MMGIS Elev_Geoid (m above MOLA areoid).`);
  const index = [];

  for (let flightNum = 1; flightNum <= 72; flightNum++) {
    const wpF = wpByFlight.get(flightNum);
    const wpFprev = wpByFlight.get(flightNum - 1); // Flight 0 = pre-deployment position
    if (!wpF || !wpFprev) {
      console.warn(`  ⚠ Flight ${flightNum}: missing waypoint data, skipping`);
      continue;
    }
    const pathF = findPathFeature(wpF.SCLK_START);
    if (!pathF) {
      console.warn(`  ⚠ Flight ${flightNum}: no path feature matched (SCLK_START=${wpF.SCLK_START}), skipping`);
      continue;
    }
    if (pathF.properties.Flight !== flightNum) {
      console.log(`  ℹ Flight ${flightNum}: matched path-labeled Flight ${pathF.properties.Flight} by SCLK time`);
    }
    const takeoffElevGeoidM = wpFprev.Elev_Geoid; // previous landing = this takeoff
    const landingElevGeoidM = wpF.Elev_Geoid;
    const maxAltM = wpF.Max_Alt_m;

    const { content, samples, durationS, etStart, etEnd } = buildXyzv(
      pathF, takeoffElevGeoidM, landingElevGeoidM, maxAltM,
    );
    const fileName = `flight_${String(flightNum).padStart(2, '0')}.xyzv`;
    writeFileSync(join(DATA_DIR, fileName), content);
    index.push({ flight: flightNum, file: `data/ingenuity/${fileName}`, etStart, etEnd, durationS, peakAltM: maxAltM, fromAirfld: wpF.FromAirfld, toAirfld: wpF.ToAirfld });
    console.log(`  ✓ Flight ${String(flightNum).padStart(2)} ${samples.toString().padStart(4)} samples / ${durationS.toFixed(1).padStart(6)}s / ${maxAltM} m peak / ${wpF.FromAirfld} → ${wpF.ToAirfld}`);
  }

  // Write a single index so the catalog (or any other consumer) can iterate
  // all flights without re-parsing the source MMGIS files.
  writeFileSync(join(DATA_DIR, 'flights_index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`\nWrote ${index.length} flight files + flights_index.json to ${DATA_DIR}`);
}

main();
