/** Reproducible CPU benchmark of the actual generated catalog (no terrain changes).
 * npm run build && node scripts/benchmark-moonfall-trajectories.mjs [OUT.json]
 * Browser load/frame timings are recorded by test-moonfall-flights-visual.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Universe } from '../packages/core/dist/index.js';
import { TrajectoryCache } from '../packages/three/dist/TrajectoryCache.js';
import { lunarTestSpice } from './lib/lunar-test-spice.mjs';

const text = readFileSync(new URL('../apps/viewer/test-catalogs/moonfall-shackleton.json', import.meta.url), 'utf8');
const spice = await lunarTestSpice();
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
let universe;
const loads = [];
for (let i = 0; i < 9; i++) {
  const start = performance.now();
  universe = new Universe(spice); universe.loadCatalog(JSON.parse(text));
  loads.push(performance.now() - start);
}
const flights = ['A', 'B', 'C', 'D'].flatMap(letter => universe.getBody(`Polaris-${letter}`).trajectory.arcs.filter(a => a.showLine !== false));
let checksum = 0;
const sample = (arc, fraction) => {
  const t = arc.startTime + fraction * (arc.trajectory.endTime - arc.startTime);
  checksum += arc.trajectory.stateAt(t).position[0];
};
const rounds = 20000, timings = {};
for (const mode of ['playback', 'scrubbing']) {
  const trials = [];
  for (let trial = 0; trial < 7; trial++) {
    const start = performance.now();
    for (const arc of flights) for (let i = 0; i < rounds; i++) {
      sample(arc, mode === 'playback' ? i / rounds : ((i * 7919) % rounds) / rounds);
    }
    trials.push(performance.now() - start);
  }
  timings[`${mode}240kCallsMs`] = median(trials);
}
const caches = [];
for (let trial = 0; trial < 7; trial++) {
  const start = performance.now();
  let points = 0;
  for (const arc of flights) {
    // Same anchored native coordinates and sampling options as the renderer.
    const cache = TrajectoryCache.build(t => arc.trajectory.stateAt(t).position, arc.trajectory.startTime, arc.trajectory.endTime,
      { maxPoints: 100000, coarseInterval: 1, minInterval: .25,
        coverageWindows: [{ start: arc.trajectory.startTime, end: arc.trajectory.endTime }] });
    points += cache.count;
  }
  caches.push({ ms: performance.now() - start, points });
}
const report = { node: process.version, platform: `${process.platform}/${process.arch}`, catalogBytes: Buffer.byteLength(text),
  flights: flights.length, knots: flights.reduce((n, a) => n + a.trajectory.waypoints.length, 0),
  catalogParseAndLoadMedianMs: median(loads), ...timings, cacheBuildMedianMs: median(caches.map(c => c.ms)), cachePoints: caches[0].points, checksum };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
