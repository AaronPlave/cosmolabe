#!/usr/bin/env node
/**
 * Rewrite the `centerXYZ` field of every .terrain file so it carries the
 * Mars-correct ECEF position for that tile.
 *
 * Why this is needed: tumgis/ctb-quantized-mesh runs CTB with the default
 * (Earth WGS84) ellipsoid when computing tile bounding centers. The actual
 * vertex elevations and tile lat/lon coverage are independent of the
 * ellipsoid used at generation time, but `header.centerXYZ` ends up at
 * ~6.37 M m (Earth's radius) instead of ~3.4 M m (Mars's).
 *
 * That value matters because the QuantizedMeshLoader subtracts header.center
 * from every vertex to convert absolute Mars ECEF positions into tile-local
 * coords, then sets `mesh.position = header.center`. With an Earth-scale
 * subtract, the resulting tile-local vertex positions are ~3 M m in magnitude
 * (Mars-ECEF − Earth-center), where float32 precision is ~0.3 m. Adjacent
 * tiles' shared edges then disagree by ~0.3-0.5 m, producing the visible
 * "jitter as camera moves" and the imagery seams between tiles.
 *
 * Setting `header.center` to the true Mars-ECEF tile-center brings vertex
 * local positions down to ~tens of meters, where float32 precision is sub-
 * micron and adjacent tiles' edges agree exactly.
 *
 * Other header fields:
 *  - The plugin recomputes the bounding region from layer.json's region
 *    bounds, so `sphereCenter` / `sphereRadius` / `horizonOcclusion` are not
 *    used for vertex positioning. We update sphereCenter to match the new
 *    center (so any future code that does use it sees consistent values),
 *    keep sphereRadius (it's a magnitude, not a position), and zero out the
 *    horizonOcclusionPoint (harmless — the renderer recomputes it).
 *
 * Run from the repo root or this directory:
 *   node scripts/build-mars-terrain/05-fix-tile-centers.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TILE_DIR = join(__dirname, '..', '..', 'apps', 'viewer', 'test-catalogs', 'data', 'mars-terrain');

// IAU 2015 Mars ellipsoid (matches the renderer's ellipsoid radii for Mars).
const MARS_A = 3396190; // equatorial (m)
const MARS_B = 3376200; // polar (m)
const E2 = 1 - (MARS_B / MARS_A) ** 2;

function tileBounds(z, x, y) {
  // TMS geodetic: tileCountX = 2 * 2^z covers 360°; tileCountY = 2^z covers 180°.
  const wDeg = 360 / (2 ** (z + 1));
  const hDeg = 180 / (2 ** z);
  return {
    minLon: -180 + x * wDeg,
    maxLon: -180 + (x + 1) * wDeg,
    minLat: -90 + y * hDeg,
    maxLat: -90 + (y + 1) * hDeg,
  };
}

function geodeticToEcef(latDeg, lonDeg, h) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const N = MARS_A / Math.sqrt(1 - E2 * sl * sl);
  return [
    (N + h) * cl * Math.cos(lon),
    (N + h) * cl * Math.sin(lon),
    (N * (1 - E2) + h) * sl,
  ];
}

function processOne(z, x, y, path) {
  const gz = readFileSync(path);
  const buf = gunzipSync(gz);
  // Header layout (little-endian):
  //  [0..7]   centerX (f64)
  //  [8..15]  centerY (f64)
  //  [16..23] centerZ (f64)
  //  [24..27] minHeight (f32)
  //  [28..31] maxHeight (f32)
  //  [32..39] sphereCenterX (f64)
  //  [40..47] sphereCenterY (f64)
  //  [48..55] sphereCenterZ (f64)
  //  [56..63] sphereRadius (f64)
  //  [64..71] horizonOcclusionX (f64)
  //  [72..79] horizonOcclusionY (f64)
  //  [80..87] horizonOcclusionZ (f64)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const minH = view.getFloat32(24, true);
  const maxH = view.getFloat32(28, true);

  const { minLat, maxLat, minLon, maxLon } = tileBounds(z, x, y);
  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  const midH = (minH + maxH) / 2;
  const [cx, cy, cz] = geodeticToEcef(midLat, midLon, midH);

  // Patch in-place.
  view.setFloat64(0,  cx, true);
  view.setFloat64(8,  cy, true);
  view.setFloat64(16, cz, true);
  // Set sphereCenter to the same Mars-ECEF center for consistency. The plugin
  // doesn't use these for vertex positioning, but external code that reads
  // them (e.g. ours, for diagnostics) will see consistent values now.
  view.setFloat64(32, cx, true);
  view.setFloat64(40, cy, true);
  view.setFloat64(48, cz, true);
  // Leave sphereRadius (bytes 56-63) alone — it's a magnitude.
  // Zero out horizonOcclusionPoint (bytes 64-87) — the renderer doesn't trust
  // it for our case and the Earth-scale value left over from CTB is wrong.
  view.setFloat64(64, 0, true);
  view.setFloat64(72, 0, true);
  view.setFloat64(80, 0, true);

  writeFileSync(path, gzipSync(buf, { level: 9 }));
}

function walk(dir) {
  const files = [];
  for (const z of readdirSync(dir)) {
    const zPath = join(dir, z);
    if (!/^\d+$/.test(z)) continue;
    if (!statSync(zPath).isDirectory()) continue;
    for (const x of readdirSync(zPath)) {
      const xPath = join(zPath, x);
      if (!/^\d+$/.test(x)) continue;
      if (!statSync(xPath).isDirectory()) continue;
      for (const yFile of readdirSync(xPath)) {
        if (!yFile.endsWith('.terrain')) continue;
        const y = yFile.replace('.terrain', '');
        if (!/^\d+$/.test(y)) continue;
        files.push({ z: Number(z), x: Number(x), y: Number(y), path: join(xPath, yFile) });
      }
    }
  }
  return files;
}

const tiles = walk(TILE_DIR);
console.log(`Found ${tiles.length.toLocaleString()} .terrain files.`);
let processed = 0;
const startMs = Date.now();
for (const t of tiles) {
  processOne(t.z, t.x, t.y, t.path);
  processed++;
  if (processed % 50000 === 0) {
    const elapsed = (Date.now() - startMs) / 1000;
    const rate = processed / elapsed;
    const eta = (tiles.length - processed) / rate;
    console.log(`  ${processed.toLocaleString()} / ${tiles.length.toLocaleString()} (${rate.toFixed(0)}/s, ETA ${eta.toFixed(0)}s)`);
  }
}
console.log(`Done. Rewrote ${processed.toLocaleString()} tile headers.`);
