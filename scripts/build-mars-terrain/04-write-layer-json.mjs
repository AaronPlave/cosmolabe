#!/usr/bin/env node
/**
 * Write layer.json from the actual tile output.
 *
 * ctb-tile -l on a global 1 m/px composite VRT hangs trying to walk billions
 * of theoretical tile positions. Faster + more accurate: enumerate what was
 * actually written to disk and emit a quantized-mesh-1.0 layer.json with
 * `available` ranges matching the on-disk truth.
 *
 * Assumes a contiguous tile rectangle per zoom level (which both passes from
 * 03-tile.sh produce — Pass A is global, Pass B is a single Jezero bbox).
 * If you later run something that writes a disjoint pattern, this script
 * still records the bounding box per zoom, which is a superset — renderer
 * will hit some 404s in the holes.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TILE_DIR = join(__dirname, '..', '..', 'apps', 'viewer', 'test-catalogs', 'data', 'mars-terrain');

function numericDirs(path) {
  try {
    return readdirSync(path)
      .filter(name => /^\d+$/.test(name))
      .map(name => Number(name))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function scanZoom(z) {
  const xDirs = numericDirs(join(TILE_DIR, String(z)));
  if (xDirs.length === 0) return null;
  let startX = Infinity, endX = -Infinity, startY = Infinity, endY = -Infinity, count = 0;
  for (const x of xDirs) {
    const yDir = join(TILE_DIR, String(z), String(x));
    let yFiles;
    try {
      yFiles = readdirSync(yDir).filter(name => name.endsWith('.terrain'));
    } catch {
      continue;
    }
    if (yFiles.length === 0) continue;
    startX = Math.min(startX, x);
    endX = Math.max(endX, x);
    for (const file of yFiles) {
      const y = Number(file.replace(/\.terrain$/, ''));
      if (!Number.isFinite(y)) continue;
      startY = Math.min(startY, y);
      endY = Math.max(endY, y);
      count++;
    }
  }
  if (count === 0) return null;
  return { startX, startY, endX, endY, count };
}

const available = [];
let minzoom = Infinity, maxzoom = -Infinity, totalTiles = 0;

for (let z = 0; z <= 23; z++) {
  const range = scanZoom(z);
  if (!range) {
    available.push([]);
    continue;
  }
  available.push([{ startX: range.startX, startY: range.startY, endX: range.endX, endY: range.endY }]);
  minzoom = Math.min(minzoom, z);
  maxzoom = Math.max(maxzoom, z);
  totalTiles += range.count;
  console.log(`  z=${String(z).padStart(2)}: x∈[${range.startX}..${range.endX}], y∈[${range.startY}..${range.endY}]  (${range.count.toLocaleString()} tiles)`);
}

// Trim trailing empty zoom entries (Cesium accepts this).
while (available.length > 0 && available[available.length - 1].length === 0) {
  available.pop();
}

const layer = {
  tilejson: '2.1.0',
  name: 'Mars MOLA-HRSC + Jezero HiRISE',
  description:
    'Self-hosted MOLA-aligned Mars terrain. Global tier: USGS Mars MGS MOLA - MEX HRSC Blended DEM 200m. Jezero detail tier: USGS Mars 2020 TRN HiRISE 1m DTM mosaic (MOLAtopography DeltaGeoid).',
  version: '1.0.0',
  format: 'quantized-mesh-1.0',
  attribution: 'NASA/USGS MOLA, MEX HRSC, M2020 TRN HiRISE',
  schema: 'tms',
  tiles: ['{z}/{x}/{y}.terrain'],
  projection: 'EPSG:4326',
  bounds: [-180, -90, 180, 90],
  available,
  minzoom: minzoom === Infinity ? 0 : minzoom,
  maxzoom: maxzoom === -Infinity ? 0 : maxzoom,
};

const outPath = join(TILE_DIR, 'layer.json');
writeFileSync(outPath, JSON.stringify(layer, null, 2) + '\n');

console.log(`\nTotal: ${totalTiles.toLocaleString()} tiles across zoom levels ${layer.minzoom}-${layer.maxzoom}.`);
console.log(`Wrote: ${outPath}`);
