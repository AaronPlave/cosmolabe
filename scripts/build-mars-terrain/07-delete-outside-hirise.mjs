#!/usr/bin/env node
/**
 * Delete Pass B z10-z15 tiles whose bounds are entirely outside the HiRISE
 * coverage footprint.
 *
 * Why:
 *  Pass B's bounded composite VRT is z9-aligned and padded for sampling
 *  safety, so it covers an area substantially larger than HiRISE's actual
 *  ~25 km Jezero footprint. Inside HiRISE coverage the composite samples
 *  HiRISE at 1 m/px and CTB produces sub-mm-consistent edges at every LOD
 *  (verified). OUTSIDE HiRISE coverage but still inside the Pass B bbox,
 *  the composite falls back to MOLA at 200 m/px and CTB encodes each tile
 *  by sampling at slightly different sub-pixel positions on either side
 *  of a shared edge — adjacent z15 tiles end up 3-4 m off, propagating to
 *  ~9 m at z11/z12. Visible as cracks. Inside HiRISE: no cracks because
 *  the 1 m source is fine enough that adjacent tiles hit the same pixel.
 *
 *  We don't actually lose anything by deleting the outside-HiRISE tiles:
 *  their data is upsampled MOLA, not real high-res detail. After deletion
 *  the renderer falls back to Pass A1's MOLA z9 (consistent globally,
 *  ~0.02 m same-LOD match) for those areas.
 *
 *  HiRISE bounds taken from gdalinfo on hirise_geographic.tif (the warped
 *  GeoTIFF Pass B reads via the composite VRT):
 *    lon 77.2229..77.5840°,  lat 18.3068..18.6693°
 */
import { readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TILE_DIR = join(__dirname, '..', '..', 'apps', 'viewer', 'test-catalogs', 'data', 'mars-terrain');

const HIRISE = { west: 77.2229, east: 77.5840, south: 18.3068, north: 18.6693 };
const MIN_Z = 10;
const MAX_Z = 15;

function tileBounds(z, x, y) {
  const tileW = 360 / (2 * 2 ** z);
  const tileH = 180 / (2 ** z);
  return {
    west: -180 + x * tileW,
    east: -180 + (x + 1) * tileW,
    south: -90 + y * tileH,
    north: -90 + (y + 1) * tileH,
  };
}

// Permissive: KEEP any tile whose bbox intersects HiRISE. Delete only tiles
// whose bbox is ENTIRELY outside HiRISE.
//
// Boundary-straddling tiles are kept because we explicitly rewrite their
// outside-HiRISE edges from canonical MOLA samples in 06-sync (see the
// `resampleBoundaryEdges` pre-pass). After that rewrite, adjacent boundary
// tiles see identical MOLA values at shared lat/lon positions → edges match
// by construction, no more 3-9 m sub-pixel-sampling cracks. This preserves
// HiRISE detail right up to the coverage boundary (previously we'd lose it
// to z9 fallback whenever a tile straddled the boundary at all).
function shouldDelete(b) {
  return b.east <= HIRISE.west || b.west >= HIRISE.east ||
         b.north <= HIRISE.south || b.south >= HIRISE.north;
}

let totalDeleted = 0, totalKept = 0;
for (let z = MIN_Z; z <= MAX_Z; z++) {
  const zDir = join(TILE_DIR, String(z));
  let xDirs;
  try { xDirs = readdirSync(zDir); } catch { continue; }
  let kept = 0, deleted = 0;
  for (const xName of xDirs) {
    if (!/^\d+$/.test(xName)) continue;
    const x = Number(xName);
    let yFiles;
    try { yFiles = readdirSync(join(zDir, xName)); } catch { continue; }
    for (const yFile of yFiles) {
      const m = yFile.match(/^(\d+)\.terrain$/);
      if (!m) continue;
      const y = Number(m[1]);
      const b = tileBounds(z, x, y);
      if (shouldDelete(b)) {
        unlinkSync(join(zDir, xName, yFile));
        deleted++;
      } else {
        kept++;
      }
    }
  }
  totalDeleted += deleted; totalKept += kept;
  console.log(`  z=${String(z).padStart(2)}: kept ${kept}, deleted ${deleted}`);
}
console.log(`\nDone. Deleted ${totalDeleted.toLocaleString()} outside-HiRISE tiles, kept ${totalKept.toLocaleString()} intersecting tiles.`);
