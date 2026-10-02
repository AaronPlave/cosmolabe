#!/usr/bin/env node
/**
 * Small-area numerical terrain validation (issue #52).
 *
 * Fetches only the quantized-mesh tiles a report needs — a few dozen, not a
 * pyramid — decodes them with the same code the viewer's CPU sampler uses, and
 * reports:
 *
 *   - same-LOD shared-edge height error            (max / RMS / p95)
 *   - parent/child error at equivalent dyadic positions
 *   - regional registration of the detail layer against the canonical layer
 *     (mean / RMS / p95 / max, plus fitted offset and planar slopes)
 *   - residual blend/coverage boundary continuity  (curvature ratio)
 *   - mission control points: canonical / detail values, delta from the
 *     independently known elevation, and per-sample provenance
 *   - CPU sampling cost per tile against tile vertex count
 *
 * Run `npm run build` first: this imports the compiled, renderer-free
 * validation module from packages/three/dist.
 *
 *   node scripts/validate-terrain.mjs --list
 *   node scripts/validate-terrain.mjs --preset mars-jezero
 *   node scripts/validate-terrain.mjs --preset moon-shackleton --out moon.json
 *   node scripts/validate-terrain.mjs --preset mars-jezero-local   # after scripts/build-mars-terrain
 *
 * Any preset field can be overridden: --url, --offset-km, --bounds w,s,e,n,
 * --levels 13,14, --canonical-level 9, --boundary w,s,e,n|auto, --max-tiles N.
 * Thresholds (--max-edge-m, --max-parent-child-m, --max-control-delta-m) make
 * the exit status non-zero when exceeded, for use as a gate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'packages/three/dist/TerrainValidation.js');
if (!existsSync(DIST)) {
  console.error(`validate-terrain: ${DIST} is missing — run \`npm run build\` first.`);
  process.exit(2);
}
const V = await import(pathToFileURL(DIST).href);

const MARS_DATUM = {
  referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
  verticalDatum: 'ellipsoid',
  heightConvention: 'geodetic-normal',
};
const MOON_DATUM = {
  referenceShape: { kind: 'sphere', radiusKm: 1737.4 },
  verticalDatum: 'reference-sphere',
  heightConvention: 'radial',
};

/** Ingenuity landing sites from MMGIS: Flight 0 is the Wright Brothers Field deployment site. */
function ingenuityControlPoints() {
  const path = join(ROOT, 'apps/viewer/test-catalogs/data/ingenuity/m20_heli_waypoints.json');
  const { features } = JSON.parse(readFileSync(path, 'utf8'));
  return features.map(({ properties: p }) => ({
    id: `F${String(p.Flight).padStart(2, '0')} ${p.ToAirfld}`,
    latDeg: p.Lat,
    lonDeg: p.Lon,
    expectedElevationKm: p.Elev_Geoid / 1000,
    // The flight builder places this value as height above the IAU ellipsoid,
    // so the delta is the terrain-vs-trajectory mission alignment error.
    expectedDatum: 'MMGIS Elev_Geoid (m above MOLA areoid), placed by build-ingenuity-flights as IAU-ellipsoid height',
    source: 'apps/viewer/test-catalogs/data/ingenuity/m20_heli_waypoints.json',
  }));
}

/** MoonFall waypoints with LOLA 118 m elevations sampled by build-moonfall-flights. */
function moonfallControlPoints() {
  const path = join(ROOT, 'scripts/data/moon-elevations.json');
  return Object.entries(JSON.parse(readFileSync(path, 'utf8'))).map(([key, m]) => {
    const [lat, lon] = key.split(',').map(Number);
    return {
      id: `LOLA ${lat.toFixed(2)},${lon.toFixed(0)}`,
      latDeg: lat,
      lonDeg: lon,
      expectedElevationKm: m / 1000,
      expectedDatum: 'LOLA LDEM 118 m (m above the 1737.4 km sphere)',
      source: 'scripts/data/moon-elevations.json',
    };
  });
}

const PRESETS = {
  'mars-jezero': {
    description: 'Mars Hub mars_v14 (as msl-dingo-gap.json configures it) at Jezero / Wright Brothers Field',
    url: 'https://marshub.s3.amazonaws.com/mars_v14/',
    offsetKm: 8.765,
    datum: MARS_DATUM,
    // A ~2 km box on Wright Brothers Field: 5×5 tiles at z14, their parents at z13.
    bounds: [77.44, 18.435, 77.462, 18.455],
    levels: [13, 14],
    canonicalLevel: 9,
    boundary: 'auto',
    boundaryLevel: 14,
    controlPoints: ingenuityControlPoints,
  },
  'mars-jezero-local': {
    description: 'The self-built pyramid from scripts/build-mars-terrain (ingenuity-jezero.json)',
    url: join(ROOT, 'apps/viewer/test-catalogs/data/mars-terrain/'),
    offsetKm: 0,
    datum: MARS_DATUM,
    bounds: [77.44, 18.435, 77.462, 18.455],
    levels: [13, 14],
    canonicalLevel: 9,
    boundary: 'auto',
    boundaryLevel: 14,
    controlPoints: ingenuityControlPoints,
  },
  'moon-shackleton': {
    description: 'Mars Hub moon_v14 (as moonfall-shackleton.json configures it) on the Shackleton rim',
    url: 'https://marshub.s3.amazonaws.com/moon_v14/',
    offsetKm: 0,
    datum: MOON_DATUM,
    // Geographic tiles are slivers this close to the pole: keep the box small.
    // moon_v14 stops at z9 this close to the pole.
    bounds: [-47, -89.6, -43, -89.5],
    levels: [8, 9],
    canonicalLevel: 7,
    boundary: null,
    boundaryLevel: 9,
    controlPoints: moonfallControlPoints,
  },
};

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

const nums = (s) => String(s).split(',').map(Number);
const m = (km, digits = 2) => (km == null || Number.isNaN(km) ? '—' : (km * 1000).toFixed(digits));
const statsRow = (label, s) => `| ${label} | ${s.count} | ${m(s.meanKm)} | ${m(s.rmsKm)} | ${m(s.p95AbsKm)} | ${m(s.maxAbsKm)} |`;
const STATS_HEAD = '| | n | mean (m) | RMS (m) | p95 \\|d\\| (m) | max \\|d\\| (m) |\n|---|---|---|---|---|---|';

/** Tile fetcher for an http(s) base or a local directory, with an on-disk cache for remote tiles. */
function makeFetcher(base, cacheDir) {
  const remote = /^https?:\/\//.test(base);
  const stats = { requests: 0, cacheHits: 0, missing: 0, bytes: 0 };
  const decode = (buf) => {
    const b = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
    stats.bytes += b.byteLength;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const fetchPath = async (path) => {
    if (!remote) {
      const file = join(base, path.split('?')[0]);
      if (!existsSync(file)) { stats.missing++; return null; }
      return decode(readFileSync(file));
    }
    const cacheFile = join(cacheDir, encodeURIComponent(base), path.replace(/[?#].*$/, ''));
    if (existsSync(cacheFile)) { stats.cacheHits++; return decode(readFileSync(cacheFile)); }
    stats.requests++;
    const res = await fetch(new URL(path, base));
    if (res.status === 404 || res.status === 403) { stats.missing++; return null; }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, buf);
    return decode(buf);
  };
  const json = async (path) => {
    if (!remote) return JSON.parse(readFileSync(join(base, path), 'utf8'));
    const res = await fetch(new URL(path, base));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${new URL(path, base)}`);
    return res.json();
  };
  return { fetchPath, json, stats };
}

/**
 * A report's sample points aren't known until it runs. Run it once against a
 * recording layer, load the deepest tile (≤ maxLevel) under every point it
 * asked for, then hand back a real layer for the second, measured run.
 */
async function layerFor(tileset, id, maxLevel, run) {
  const points = [];
  run({ id, sample: (latDeg, lonDeg) => { points.push({ latDeg, lonDeg }); return null; } });
  return tileset.layerForPoints(id, points, maxLevel);
}

/** The layer.json availability rectangle at `level` containing `point`: the real regional source boundary. */
function autoBoundary(layer, level, point) {
  const span = 180 / 2 ** level;
  const x = Math.floor((point[0] + 180) / span), y = Math.floor((point[1] + 90) / span);
  const r = layer.available?.[level]?.find((q) => x >= q.startX && x <= q.endX && y >= q.startY && y <= q.endY);
  if (!r) return null;
  return { westDeg: -180 + r.startX * span, eastDeg: -180 + (r.endX + 1) * span, southDeg: -90 + r.startY * span, northDeg: -90 + (r.endY + 1) * span };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list || (!args.preset && !args.url)) {
    console.log('Presets:');
    for (const [name, p] of Object.entries(PRESETS)) console.log(`  ${name.padEnd(20)} ${p.description}`);
    if (!args.list) process.exitCode = 2;
    return;
  }
  const preset = args.preset ? PRESETS[args.preset] : {};
  if (args.preset && !preset) throw new Error(`unknown preset ${args.preset} (try --list)`);
  const cfg = {
    url: args.url ?? preset.url,
    offsetKm: args['offset-km'] != null ? Number(args['offset-km']) : (preset.offsetKm ?? 0),
    datum: preset.datum ?? (args.body === 'moon' ? MOON_DATUM : MARS_DATUM),
    bounds: args.bounds ? nums(args.bounds) : preset.bounds,
    levels: args.levels ? nums(args.levels) : preset.levels,
    canonicalLevel: args['canonical-level'] != null ? Number(args['canonical-level']) : (preset.canonicalLevel ?? 9),
    boundary: args.boundary ?? preset.boundary ?? null,
    boundaryLevel: args['boundary-level'] != null ? Number(args['boundary-level']) : preset.boundaryLevel,
    maxTiles: Number(args['max-tiles'] ?? 256),
    controlPoints: args['control-points']
      ? JSON.parse(readFileSync(resolve(args['control-points']), 'utf8'))
      : (preset.controlPoints?.() ?? []),
  };
  if (!cfg.url || !cfg.bounds || !cfg.levels) throw new Error('need --url, --bounds and --levels (or a --preset)');
  const base = /^https?:\/\//.test(cfg.url) ? cfg.url.replace(/\/?$/, '/') : resolve(cfg.url);
  if (!/^https?:\/\//.test(base) && !existsSync(join(base, 'layer.json'))) {
    throw new Error(`${base}/layer.json not found — build it first (see scripts/build-mars-terrain/README.md)`);
  }
  const cacheDir = args['cache-dir'] ?? join(tmpdir(), 'cosmolabe-terrain-cache');
  const io = makeFetcher(base, cacheDir);
  const layerJson = await io.json('layer.json');
  const tileset = new V.QuantizedMeshTileset({
    id: args.preset ?? 'tileset',
    layer: layerJson,
    heightOffsetKm: cfg.offsetKm,
    fetchTile: io.fetchPath,
    source: { id: cfg.url, kind: 'quantized-mesh', url: cfg.url },
  });
  const [w, s, e, n] = cfg.bounds;
  const bounds = { westDeg: w, southDeg: s, eastDeg: e, northDeg: n };
  const t0 = performance.now();

  // Seams and pyramid over the small region.
  const regionTiles = await tileset.loadRegion(bounds, cfg.levels, cfg.maxTiles);
  const seams = V.seamReport(regionTiles);
  const pyramid = V.pyramidReport(regionTiles);

  // Registration: deepest available detail vs the canonical (globally complete) level.
  const detailLevel = Math.max(...cfg.levels);
  const regRun = (ref, cand) => V.registrationReport(ref, cand, bounds, cfg.datum, { gridSize: 33 });
  const regCanonical = await layerFor(tileset, 'canonical', cfg.canonicalLevel, (l) => regRun(l, l));
  const regDetail = await layerFor(tileset, 'detail', detailLevel, (l) => regRun(l, l));
  const registration = regRun(regCanonical, regDetail);

  // Blend / coverage boundary continuity.
  let boundary = null;
  if (cfg.boundary) {
    const centre = [(w + e) / 2, (s + n) / 2];
    const box = cfg.boundary === 'auto'
      ? autoBoundary(layerJson, cfg.boundaryLevel, centre)
      : (([bw, bs, be, bn]) => ({ westDeg: bw, southDeg: bs, eastDeg: be, northDeg: bn }))(nums(cfg.boundary));
    if (box) {
      const opts = { transectsPerEdge: 2, spacingKm: 0.1, halfLengthKm: 1.5 };
      const run = (l) => V.boundaryContinuityReport(l, box, cfg.datum, opts);
      const composite = await layerFor(tileset, 'composite', tileset.maxLevel, run);
      boundary = { ...run(composite), boundarySource: cfg.boundary === 'auto' ? `layer.json availability at z${cfg.boundaryLevel}` : 'command line' };
    }
  }

  // Control points: canonical and deepest-detail value at every point.
  const cp = cfg.controlPoints;
  const cpLayers = cp.length
    ? [await tileset.layerForPoints('canonical', cp, cfg.canonicalLevel), await tileset.layerForPoints('detail', cp)]
    : [];
  const controlPoints = V.controlPointReport(cp, cpLayers);

  // Every tile this run decoded — region, canonical and control-point detail — for the widest vertex-count range.
  const samplingCost = V.samplingCostReport(tileset.loadedTiles().map((t) => t.tile), 2000);
  const elapsedS = (performance.now() - t0) / 1000;

  const report = {
    generatedAt: new Date().toISOString(),
    preset: args.preset ?? null,
    tileset: { url: cfg.url, heightOffsetKm: cfg.offsetKm, maxLevel: tileset.maxLevel, datum: cfg.datum },
    region: { bounds, levels: cfg.levels, tiles: regionTiles.length },
    seams, pyramid, registration, boundary, controlPoints, samplingCost,
    io: { ...io.stats, elapsedS },
  };

  if (args.out) writeFileSync(resolve(args.out), JSON.stringify(report, null, 2) + '\n');

  // ---- markdown summary ----
  const out = [];
  out.push(`# Terrain validation — ${args.preset ?? cfg.url}`, '');
  out.push(`Tileset \`${cfg.url}\` (max z${tileset.maxLevel}), height offset ${cfg.offsetKm} km. Region ${cfg.bounds.join(', ')} at z${cfg.levels.join('/')} — ${regionTiles.length} tiles.`, '');
  if (!regionTiles.length) {
    const deepest = tileset.deepestLevelAt((s + n) / 2, (w + e) / 2);
    out.push(`> **No tiles available in the region at z${cfg.levels.join('/')}** — the deepest level at its centre is z${deepest}. Seam and pyramid statistics below are empty.`, '');
  }
  out.push('## Seams and pyramid', '', STATS_HEAD);
  out.push(statsRow(`Same-LOD edges (${seams.edges})`, seams.overall));
  for (const l of seams.byLevel) out.push(statsRow(`&nbsp;&nbsp;z${l.level} (${l.comparisons})`, l.stats));
  out.push(statsRow(`Parent/child pairs (${pyramid.pairs})`, pyramid.overall));
  for (const l of pyramid.byLevel) out.push(statsRow(`&nbsp;&nbsp;child z${l.level} (${l.comparisons})`, l.stats));
  if (seams.worst[0]) out.push('', `Worst edge: ${seams.worst[0].a} ↔ ${seams.worst[0].b} (${m(seams.worst[0].stats.maxAbsKm)} m).`);
  out.push('', `## Registration: z≤${detailLevel} detail − z≤${cfg.canonicalLevel} canonical`, '', STATS_HEAD);
  out.push(statsRow('Raw difference', registration.difference));
  out.push(statsRow('After planar fit', registration.plane.residual));
  out.push('', `Fitted offset ${m(registration.plane.offsetKm)} m, slope east ${(registration.plane.slopeEast * 1000).toFixed(3)} m/km, north ${(registration.plane.slopeNorth * 1000).toFixed(3)} m/km (tilt ${registration.plane.tiltDeg.toFixed(4)}°). ${registration.missing} of ${registration.samples} grid points unanswered.`);
  if (boundary) {
    const b = boundary.boundary;
    out.push('', '## Coverage boundary continuity', '');
    out.push(`Boundary ${[b.westDeg, b.southDeg, b.eastDeg, b.northDeg].map((v) => v.toFixed(4)).join(', ')} (${boundary.boundarySource}); ${boundary.transects} transects at ${boundary.spacingKm * 1000} m spacing.`);
    out.push(`Curvature RMS at boundary ${m(boundary.boundaryCurvature.rmsKm)} m vs background ${m(boundary.backgroundCurvature.rmsKm)} m — **ratio ${boundary.ratio.toFixed(2)}** (≈1 continuous; ≫1 a hard source boundary).`);
  }
  if (cp.length) {
    out.push('', '## Control points', '', '| layer | answered | missing | mean Δ (m) | RMS Δ (m) | p95 \\|Δ\\| (m) | max \\|Δ\\| (m) |', '|---|---|---|---|---|---|---|');
    for (const [id, l] of Object.entries(controlPoints.byLayer)) {
      out.push(`| ${id} | ${l.sampled} | ${l.missing} | ${m(l.delta.meanKm)} | ${m(l.delta.rmsKm)} | ${m(l.delta.p95AbsKm)} | ${m(l.delta.maxAbsKm)} |`);
    }
    out.push('', `Δ = sampled − expected; expected datum: ${cp[0].expectedDatum ?? 'unstated'}.`, '');
    out.push('| point | lat | lon | expected (m) | canonical (m) | detail (m) | Δ detail (m) | detail tile |', '|---|---|---|---|---|---|---|---|');
    const shown = controlPoints.results.slice(0, Number(args['show-points'] ?? 12));
    for (const r of shown) {
      const c = r.values.canonical, d = r.values.detail;
      out.push(`| ${r.point.id} | ${r.point.latDeg.toFixed(5)} | ${r.point.lonDeg.toFixed(5)} | ${m(r.point.expectedElevationKm, 1)} | ${m(c.elevationKm, 1)} | ${m(d.elevationKm, 1)} | ${m(d.deltaKm, 1)} | ${d.tileId ?? '—'} |`);
    }
    if (controlPoints.results.length > shown.length) out.push('', `… ${controlPoints.results.length - shown.length} more in the JSON report.`);
  }
  if (samplingCost.length) {
    const lo = samplingCost[0], hi = samplingCost[samplingCost.length - 1];
    const micros = samplingCost.map((r) => r.microsPerSample).sort((a, b) => a - b);
    const median = micros[Math.floor(micros.length / 2)];
    out.push('', '## CPU sampling cost', '');
    out.push(`${samplingCost.length} tiles of ${lo.vertices}–${hi.vertices} vertices: ${micros[0].toFixed(2)}–${micros[micros.length - 1].toFixed(2)} µs/sample, median ${median.toFixed(2)}. Bounded per tile by triangle binning; no rendered geometry is touched.`);
  }
  out.push('', `_${io.stats.requests} tile requests, ${io.stats.cacheHits} cache hits, ${io.stats.missing} missing; ${(io.stats.bytes / 1024).toFixed(0)} KiB decoded; ${elapsedS.toFixed(1)} s._`);
  console.log(out.join('\n'));

  // ---- optional gates ----
  const failures = [];
  const gate = (flag, value, label) => {
    if (args[flag] == null) return;
    if (!(value * 1000 <= Number(args[flag]))) failures.push(`${label} ${m(value)} m exceeds --${flag} ${args[flag]}`);
  };
  gate('max-edge-m', seams.overall.maxAbsKm, 'same-LOD edge max');
  gate('max-parent-child-m', pyramid.overall.maxAbsKm, 'parent/child max');
  if (cp.length) gate('max-control-delta-m', controlPoints.byLayer.detail.delta.maxAbsKm, 'control-point detail max |Δ|');
  if (failures.length) {
    console.error(failures.map((f) => `FAIL: ${f}`).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`validate-terrain: ${err.message}`);
  process.exitCode = 2;
});
