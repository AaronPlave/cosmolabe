import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { WaypointTrajectory } from '../../packages/core/dist/index.js';
import { CubeSphereGridSource } from '../../packages/three/dist/surface/CubeSphereGrids.js';

export const RADIUS_KM = 1737.4;
export const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function trajectory(waypoints) {
  if (waypoints.some(w => typeof w.alt !== 'string' || !w.alt.endsWith('km') || !Number.isFinite(Number.parseFloat(w.alt)))) {
    throw Error('MoonFall absolute waypoint heights must be finite kilometres');
  }
  return new WaypointTrajectory(waypoints.map(w => ({ et: w.t, latDeg: w.lat, lonDeg: w.lon,
    altKm: Number.parseFloat(w.alt) })), RADIUS_KM, { useAbsoluteAlt: true });
}
export function coordinates(position) {
  return { lat: Math.atan2(position[2], Math.hypot(position[0], position[1])) * 180 / Math.PI,
    lon: Math.atan2(position[1], position[0]) * 180 / Math.PI };
}
export async function terrainSource(grids, revision) {
  const local = !/^https?:/.test(grids);
  const manifestUrl = local ? pathToFileURL(grids).href : grids;
  const base = new URL('.', manifestUrl).href;
  const inputs = new Map();
  const fetchInput = async url => {
    const response = local ? new Response(readFileSync(new URL(url))) : await fetch(url);
    if (!response.ok) return response;
    const bytes = await response.arrayBuffer();
    const key = new URL(url).href.slice(base.length);
    inputs.set(key, createHash('sha256').update(new Uint8Array(bytes)).digest('hex'));
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
  const source = await CubeSphereGridSource.fromUrl(manifestUrl,
    { fetch: fetchInput });
  if (source.manifest.source.version !== revision) throw Error(`Terrain revision mismatch: ${source.manifest.source.version} != ${revision}`);
  await source.ready;
  // Script-only evidence, independent of the source URL and filesystem root.
  source.clearanceInputs = inputs;
  return source;
}
export function terrainDigest(source) { return sha256([...source.clearanceInputs].sort(([a], [b]) => a.localeCompare(b))); }
export async function groundAt(source, lat, lon) {
  await source.request(lat, lon);
  const coverage = source.coverage(lat, lon), sample = source.sampler.sample(lat, lon);
  if (coverage.state !== 'finest' || !sample) throw Error(`Missing finest terrain at ${lat}, ${lon}`);
  return sample.elevationKm * 1000;
}

// A cubic's velocity lies in the convex hull of its quadratic Bezier velocity
// controls. This bounds travelled distance between samples, including loops
// and overshoots that an endpoint-distance subdivision would miss.
export function segmentSteps(path, a, b, maxDistanceM, maxTimeS) {
  const dt = b - a, start = path.stateAt(a), end = path.stateAt(b);
  const middle = start.position.map((v, k) => 3 * (end.position[k] - v) / dt - start.velocity[k] - end.velocity[k]);
  const speed = Math.max(Math.hypot(...start.velocity), Math.hypot(...end.velocity), Math.hypot(...middle));
  return Math.max(1, Math.ceil(dt / maxTimeS), Math.ceil(speed * dt * 1000 / maxDistanceM));
}

export async function validateFlight(waypoints, source, { maxDistanceM = 2, maxTimeS = .1 } = {}) {
  const path = trajectory(waypoints), segments = [];
  let samples = 0, minClearanceM = Infinity, maxClearanceM = -Infinity;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i].t, b = waypoints[i + 1].t;
    const steps = segmentSteps(path, a, b, maxDistanceM, maxTimeS);
    let minimum = Infinity, maximum = -Infinity, at = null;
    for (let j = 0; j <= steps; j++) {
      const t = a + (b - a) * j / steps, p = path.stateAt(t).position, { lat, lon } = coordinates(p);
      const groundM = await groundAt(source, lat, lon);
      const clearanceM = (Math.hypot(...p) - RADIUS_KM) * 1000 - groundM;
      if (clearanceM < minimum) { minimum = clearanceM; at = { t, lat, lon, groundM }; }
      maximum = Math.max(maximum, clearanceM); samples++;
    }
    segments.push({ segment: i, startS: a, endS: b, samples: steps + 1, minClearanceM: minimum, maxClearanceM: maximum, at });
    minClearanceM = Math.min(minClearanceM, minimum); maxClearanceM = Math.max(maxClearanceM, maximum);
  }
  return { samples, minClearanceM, maxClearanceM, segments };
}

/** Offline terrain-following authoring for this synthetic demo only. Preserve
 * the original Cartesian Hermite route's horizontal motion. Bake absolute
 * heights along it; smoothstep AGL prevents altitude overshoot at perches.
 * Runtime still uses the ordinary, unclamped Cartesian WaypointTrajectory.
 */
export async function bakeFlight(flight, elevations, source) {
  const authored = flight.waypoints;
  const original = authored.map(w => ({ t: w.t, lat: w.lat, lon: w.lon,
    alt: `${(elevations[`${w.lat.toFixed(5)},${w.lon.toFixed(5)}`] + w.altM) / 1000}km` }));
  const route = trajectory(original), points = [];
  for (let i = 0; i < authored.length - 1; i++) {
    const a = authored[i], b = authored[i + 1];
    const steps = segmentSteps(route, a.t, b.t, 50, 2);
    for (let j = 0; j < steps; j++) {
      const u = j / steps, t = a.t + (b.t - a.t) * u;
      const { lat, lon } = coordinates(route.stateAt(t).position);
      const clearance = a.altM + (b.altM - a.altM) * u * u * (3 - 2 * u);
      points.push({ t, lat, lon, groundM: await groundAt(source, lat, lon), clearance });
    }
  }
  const last = authored.at(-1);
  points.push({ t: last.t, lat: last.lat, lon: last.lon,
    groundM: await groundAt(source, last.lat, last.lon), clearance: last.altM });
  // A small look-ahead envelope rounds narrow relief while preserving all
  // authored sites. The vertical takeoff/landing stretches need no lift.
  return points.map((p, i) => {
    const nearby = points.slice(Math.max(0, i - 2), i + 3);
    const ground = i === 0 || i === points.length - 1 ? p.groundM : Math.max(...nearby.map(q => q.groundM));
    return { t: Number(p.t.toFixed(6)), lat: Number(p.lat.toFixed(10)), lon: Number(p.lon.toFixed(10)), alt: `${((ground + p.clearance) / 1000).toFixed(9)}km` };
  });
}
