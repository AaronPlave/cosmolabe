#!/usr/bin/env node
/**
 * Cross-LOD parent-edge synchronization for the Jezero tile pyramid.
 *
 * Problem this solves:
 *  CTB encodes each .terrain tile independently. When the renderer shows a
 *  z(N) tile next to a z(N+1) tile in the same frame, the z(N) tile has a
 *  STRAIGHT edge segment between its sparse vertices, while the z(N+1) tile
 *  is a denser polyline that follows the source DEM's bumps. Same lat/lon
 *  endpoints, but the vertical disagreement between the two polylines along
 *  the edge can reach tens of meters in mountainous terrain (Jezero crater
 *  rim). The QM spec doesn't require parent-child edges to match — Cesium's
 *  in-house encoder enforces it as a quality measure, CTB does not, and
 *  3d-tiles-renderer's QM plugin doesn't compensate at render time.
 *
 * What this script does:
 *  For each parent tile at zoom z in the Jezero region, decode it together
 *  with its 4 z+1 children. Replace the parent's edge vertices with the
 *  union of vertices found on the corresponding edges of the children
 *  (mapped from child u/v space into parent u/v space). Re-triangulate the
 *  parent mesh, re-quantize heights to the new (minH, maxH) range, and re-
 *  encode. After this pass, parent.east_edge_polyline == child.east_edges_
 *  polyline at every point, so the renderer's LOD transitions are crack-
 *  free without needing big skirts.
 *
 * Pyramid traversal: bottom-up. We sync z=14 from z=15 first, then z=13
 * from the already-synced z=14, etc. This propagates child polylines up
 * the pyramid, so a z=8 tile's edges trace the same polyline a z=15 child
 * does (subject to QM's half-pixel rounding at child midpoints).
 *
 * Order in 03-tile.sh: runs AFTER Pass B (z10-15 from composite) and Pass C
 * (layer.json), BEFORE Pass D (Mars-center fix). Pass D re-computes header
 * centerXYZ from the tile's lat/lon bbox + new minH/maxH — small drift is
 * absorbed there.
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import Delaunator from 'delaunator';
import { decodeTile, encodeTile, recomputeEdges, reorderTrianglesForHWM } from './qm-codec.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TILE_DIR = join(__dirname, '..', '..', 'apps', 'viewer', 'test-catalogs', 'data', 'mars-terrain');
// Global MOLA-HRSC source we sample to backfill boundary tiles where Pass B
// landed outside the bounded composite VRT and CTB dropped edge vertices.
const MOLA_VRT = join(__dirname, 'data', 'mola_hrsc_float32.vrt');
// HiRISE GeoTIFF reprojected to geographic (lat/lon). We probe this to detect
// which canonical edge positions have HiRISE coverage vs. MOLA-fallback —
// HiRISE coverage is irregular within its bbox, so a simple bbox check isn't
// enough. nodata = -32768.
const HIRISE_TIF = join(__dirname, 'data', 'hirise_geographic.tif');
const HIRISE_NODATA = -32768;

// Sync this range of parent zooms. Parents at z(N) get synced against
// children at z(N+1). z(MAX_PARENT_Z) syncs against z15 leaf tiles (which
// don't change). z(MIN_PARENT_Z) is the coarsest level we care about LOD
// transitions for — coarser than ~z5 isn't visible in close flight views.
const MAX_PARENT_Z = 14;
const MIN_PARENT_Z = 6;

function tilePath(z, x, y) {
  return join(TILE_DIR, String(z), String(x), `${y}.terrain`);
}

// TMS-geodetic tile-(u,v) → (lat, lon). z >= 0; u,v in [0, 32767]. y is
// south-up (y=0 at the south pole) consistent with how CTB writes our tiles.
function tileUVToLatLon(z, x, y, u, v) {
  const tileW = 360 / (2 * 2 ** z);
  const tileH = 180 / (2 ** z);
  return [
    -90 + y * tileH + (v / 32767) * tileH,
    -180 + x * tileW + (u / 32767) * tileW,
  ];
}

// Run gdallocationinfo against the global MOLA VRT for a batch of (lat, lon)
// points. Returns absolute heights (meters) or NaN for points where the
// raster has no valid sample (off-extent, polar wrap-around, etc.). One
// subprocess call per batch. Stdin syntax: "lon lat\nlon lat\n..." with
// `-geoloc`.
function sampleMolaBatch(latLonPairs) {
  if (latLonPairs.length === 0) return [];
  const stdin = latLonPairs.map(([lat, lon]) => `${lon} ${lat}`).join('\n');
  const result = spawnSync(
    'gdallocationinfo',
    ['-geoloc', '-valonly', MOLA_VRT],
    { input: stdin, encoding: 'utf8' }
  );
  // Don't fail the whole sync on a subprocess hiccup — just skip the batch.
  // The caller falls back to whatever edges already existed in the parent.
  if (result.error || result.status !== 0) return latLonPairs.map(() => NaN);
  const lines = result.stdout.split('\n');
  const out = [];
  for (let i = 0; i < latLonPairs.length; i++) {
    const raw = (lines[i] || '').trim();
    out.push(raw === '' ? NaN : parseFloat(raw));
  }
  return out;
}

// Like sampleMolaBatch but against the warped HiRISE GeoTIFF. Returns the
// raw stored value (which is -32768 for nodata pixels — we treat those as
// "no HiRISE coverage at this position"). Used to detect which canonical
// edge positions need MOLA-fallback resample.
function sampleHiriseBatch(latLonPairs) {
  if (latLonPairs.length === 0) return [];
  const stdin = latLonPairs.map(([lat, lon]) => `${lon} ${lat}`).join('\n');
  const result = spawnSync(
    'gdallocationinfo',
    ['-geoloc', '-valonly', HIRISE_TIF],
    { input: stdin, encoding: 'utf8' }
  );
  if (result.error || result.status !== 0) return latLonPairs.map(() => HIRISE_NODATA);
  const lines = result.stdout.split('\n');
  const out = [];
  for (let i = 0; i < latLonPairs.length; i++) {
    const raw = (lines[i] || '').trim();
    out.push(raw === '' ? HIRISE_NODATA : parseFloat(raw));
  }
  return out;
}

// Quick sanity check that sampling works before processing thousands of tiles.
{
  const probe = sampleMolaBatch([[18.4447, 77.4508]]);
  if (!probe.length || !Number.isFinite(probe[0])) {
    throw new Error('MOLA probe at Wright Brothers Field returned no value — check MOLA_VRT path and gdallocationinfo install.');
  }
  const hp = sampleHiriseBatch([[18.4447, 77.4508]]);
  if (!hp.length || !Number.isFinite(hp[0]) || hp[0] === HIRISE_NODATA) {
    throw new Error('HiRISE probe at Wright Brothers Field returned no value or nodata — check HIRISE_TIF path.');
  }
}

// For every edge, ensure there are vertices at 17 evenly-spaced positions
// along it — sampling MOLA wherever a slot is empty. A simple "edge has at
// least N vertices" check isn't enough: a child contribution can populate
// one half of an edge while the sibling child was skipped (corrupted maxH),
// leaving a large gap in the other half. The dedup-by-(u,v) protects us
// from creating duplicates where a vertex already happens to land on a
// sample slot. One batched gdallocationinfo call per parent.
const EDGE_FILL_SAMPLES = 17;
function fillSparseEdgesFromMola(z, x, y, points) {
  const requests = [];
  function planEdge(dir) {
    for (let i = 0; i < EDGE_FILL_SAMPLES; i++) {
      const t = i / (EDGE_FILL_SAMPLES - 1);
      let u, v;
      if (dir === 'west')  { u = 0;     v = Math.round(t * 32767); }
      else if (dir === 'east')  { u = 32767; v = Math.round(t * 32767); }
      else if (dir === 'south') { u = Math.round(t * 32767); v = 0; }
      else                       { u = Math.round(t * 32767); v = 32767; }
      if (points.some(p => p.u === u && p.v === v)) continue;
      const [lat, lon] = tileUVToLatLon(z, x, y, u, v);
      requests.push({ u, v, lat, lon });
    }
  }
  planEdge('west');
  planEdge('east');
  planEdge('south');
  planEdge('north');
  if (requests.length === 0) return points;
  const heights = sampleMolaBatch(requests.map(r => [r.lat, r.lon]));
  for (let i = 0; i < requests.length; i++) {
    if (!Number.isFinite(heights[i])) continue;
    points.push({ u: requests[i].u, v: requests[i].v, h: heights[i] });
  }
  return points;
}

function readTile(z, x, y) {
  const path = tilePath(z, x, y);
  if (!existsSync(path)) return null;
  return decodeTile(gunzipSync(readFileSync(path)));
}

function dequantizeH(qh, minH, maxH) {
  return minH + (qh / 32767) * (maxH - minH);
}

/**
 * Collect a child's edge vertices and project them into parent (u, v) space.
 * Returns array of { u, v, h } in parent space (h is absolute meters).
 */
function projectChildEdge(child, edgeName, qx, qy) {
  const limit = 32767;
  const mask = edgeName === 'west' ? (i) => child.u[i] === 0
    : edgeName === 'east' ? (i) => child.u[i] === limit
    : edgeName === 'south' ? (i) => child.v[i] === 0
    : (i) => child.v[i] === limit;
  const out = [];
  for (let i = 0; i < child.vertexCount; i++) {
    if (!mask(i)) continue;
    // Project to parent space. SW/SE/NW/NE: qx ∈ {0,1}, qy ∈ {0,1}.
    // Parent u/v are integers in [0, 32767]. Rounding half-up handles the
    // half-pixel midpoint where SW.u=32767 and SE.u=0 both should land on
    // parent_u=16384.
    const pu = Math.round((child.u[i] + qx * 32767) / 2);
    const pv = Math.round((child.v[i] + qy * 32767) / 2);
    const absH = dequantizeH(child.h[i], child.header.minHeight, child.header.maxHeight);
    out.push({ u: pu, v: pv, h: absH });
  }
  return out;
}

function hasAnyChildAt(z, x, y) {
  for (let dx = 0; dx <= 1; dx++)
    for (let dy = 0; dy <= 1; dy++)
      if (existsSync(tilePath(z + 1, 2 * x + dx, 2 * y + dy))) return true;
  return false;
}

function syncParent(z, x, y) {
  const parent = readTile(z, x, y);
  if (!parent) return null;

  // Collect children. TMS-geodetic y south-up: SW=(2x,2y), SE=(2x+1,2y),
  // NW=(2x,2y+1), NE=(2x+1,2y+1).
  const quads = [
    { name: 'SW', x: 2 * x,     y: 2 * y,     qx: 0, qy: 0 },
    { name: 'SE', x: 2 * x + 1, y: 2 * y,     qx: 1, qy: 0 },
    { name: 'NW', x: 2 * x,     y: 2 * y + 1, qx: 0, qy: 1 },
    { name: 'NE', x: 2 * x + 1, y: 2 * y + 1, qx: 1, qy: 1 },
  ];
  const children = quads.map(q => ({ ...q, tile: readTile(z + 1, q.x, q.y) }));
  // If no children exist, parent has no LOD-transition concerns to sync.
  if (!children.some(c => c.tile)) return null;

  // For each parent edge, we only rewrite it if the neighbor tile (also a
  // parent at this z) is being synced too. If the neighbor has no children
  // at z+1, it stays untouched — and we must leave THIS parent's edge in
  // the corresponding direction unchanged, or else the same-LOD edge match
  // with the un-synced neighbor breaks (visible cracks at the sync-area
  // boundary).
  const syncW = hasAnyChildAt(z, x - 1, y);
  const syncE = hasAnyChildAt(z, x + 1, y);
  const syncS = hasAnyChildAt(z, x, y - 1);
  const syncN = hasAnyChildAt(z, x, y + 1);

  // Collect edge vertices from children, projected to parent space.
  // Parent west edge: SW.west + NW.west. East: SE.east + NE.east. South:
  // SW.south + SE.south. North: NW.north + NE.north.
  const edgeContribs = [];
  const pickChild = (qx, qy) => children.find(c => c.qx === qx && c.qy === qy);
  let anyChildSkipped = false;
  function addFrom(qx, qy, edge) {
    const c = pickChild(qx, qy);
    // Skip corrupted children — their decoded heights are wrong (scaled
    // against the bogus maxH=0). Letting their values into the parent would
    // re-poison the parent's quantization. fillSparseEdgesFromMola will
    // backfill any edges that come out under-populated as a result.
    if (c?.tile && c.tile.header.maxHeight !== 0) {
      edgeContribs.push(...projectChildEdge(c.tile, edge, c.qx, c.qy));
    } else if (c?.tile) {
      anyChildSkipped = true;
    }
  }
  if (syncW) { addFrom(0, 0, 'west'); addFrom(0, 1, 'west'); }
  if (syncE) { addFrom(1, 0, 'east'); addFrom(1, 1, 'east'); }
  if (syncS) { addFrom(0, 0, 'south'); addFrom(1, 0, 'south'); }
  if (syncN) { addFrom(0, 1, 'north'); addFrom(1, 1, 'north'); }

  // Also project each kept child's INNER edges (the edges adjacent to its
  // siblings inside the parent) — these land on the parent's mid-lines
  // (u=16384 and v=16384). When the renderer can refine into only SOME of
  // the parent's children (partial children, common at the HiRISE-coverage
  // boundary where strict deletion left a single child kept), it splits the
  // parent's mesh into quadrants for the missing children. Without
  // mid-line vertices, the parent's interior interpolation diverges from
  // the kept child's outer edge — visible as a crack at the LOD-transition
  // boundary INSIDE the parent. Adding the kept child's inner-edge polyline
  // as vertices forces the parent's interpolation to pass through those
  // points, so the rendered split quadrants meet the kept real child
  // cleanly.
  for (const c of children) {
    if (!c.tile || c.tile.header.maxHeight === 0) continue;
    // SW (qx=0, qy=0): east edge (parent mid-u), north edge (parent mid-v).
    // SE (qx=1, qy=0): west edge (parent mid-u), north edge (parent mid-v).
    // NW (qx=0, qy=1): east edge (parent mid-u), south edge (parent mid-v).
    // NE (qx=1, qy=1): west edge (parent mid-u), south edge (parent mid-v).
    const innerHoriz = c.qx === 0 ? 'east' : 'west';
    const innerVert  = c.qy === 0 ? 'north' : 'south';
    edgeContribs.push(...projectChildEdge(c.tile, innerHoriz, c.qx, c.qy));
    edgeContribs.push(...projectChildEdge(c.tile, innerVert,  c.qx, c.qy));
  }

  // For each un-synced edge, carry the parent's own original edge vertices
  // through. They're our same-LOD-matching guarantee with the un-synced
  // neighbor. Skip this on corrupted-header tiles — their decoded heights
  // are wrong; fillSparseEdgesFromMola will pull MOLA samples for those
  // edges below.
  const headerCorrupted2 = parent.header.maxHeight === 0;
  if (!headerCorrupted2) {
    for (let i = 0; i < parent.vertexCount; i++) {
      const u = parent.u[i], v = parent.v[i];
      const onWest = u === 0, onEast = u === 32767, onSouth = v === 0, onNorth = v === 32767;
      if (!(onWest || onEast || onSouth || onNorth)) continue;
      const keepEdge = (onWest && !syncW) || (onEast && !syncE) || (onSouth && !syncS) || (onNorth && !syncN);
      if (!keepEdge) continue;
      const absH = dequantizeH(parent.h[i], parent.header.minHeight, parent.header.maxHeight);
      edgeContribs.push({ u, v, h: absH });
    }
  }

  // Deduplicate at shared positions (corners, midpoints where two siblings
  // contribute, or where a kept parent edge meets a child-derived edge at a
  // corner). Average heights at the same (parent_u, parent_v).
  const edgeMap = new Map();
  for (const e of edgeContribs) {
    const key = `${e.u},${e.v}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.h = (existing.h * existing.n + e.h) / (existing.n + 1);
      existing.n++;
    } else {
      edgeMap.set(key, { u: e.u, v: e.v, h: e.h, n: 1 });
    }
  }

  // Collect parent's interior vertices (not on any edge). Their heights stay
  // as parent already had them — UNLESS the parent's header is corrupted
  // (CTB's "maxH=0" giveaway for tiles whose source sampling hit nodata).
  // Bad headers mean every decoded height is scaled against a wrong range,
  // and the interior comes out tens or hundreds of meters too high. In that
  // case we throw away the interior and resample MOLA on a regular grid
  // instead. (CTB-correct tiles always have negative maxH at Jezero since
  // the crater floor is well below the Mars geoid — maxH==0 is a CTB
  // initialization sentinel that survived because no source pixel ever
  // exceeded 0 m.)
  const headerCorrupted = parent.header.maxHeight === 0;
  let interior = [];
  if (headerCorrupted) {
    // Regular 9×9 interior grid, sampled fresh from MOLA. Skips the perimeter
    // (i,j ∈ {0, 8}) because those slots are owned by the edge supply.
    const GRID = 9;
    const requests = [];
    for (let i = 1; i < GRID - 1; i++) {
      for (let j = 1; j < GRID - 1; j++) {
        const u = Math.round((i / (GRID - 1)) * 32767);
        const v = Math.round((j / (GRID - 1)) * 32767);
        const [lat, lon] = tileUVToLatLon(z, x, y, u, v);
        requests.push({ u, v, lat, lon });
      }
    }
    const heights = sampleMolaBatch(requests.map(r => [r.lat, r.lon]));
    for (let i = 0; i < requests.length; i++) {
      if (!Number.isFinite(heights[i])) continue;
      interior.push({ u: requests[i].u, v: requests[i].v, h: heights[i] });
    }
  } else {
    for (let i = 0; i < parent.vertexCount; i++) {
      const u = parent.u[i], v = parent.v[i];
      if (u !== 0 && u !== 32767 && v !== 0 && v !== 32767) {
        interior.push({ u, v, h: dequantizeH(parent.h[i], parent.header.minHeight, parent.header.maxHeight) });
      }
    }
  }

  // Union: interior + new edges. The edge map has been deduped already.
  // Drop any "interior" vertex that happens to coincide with an edge vertex
  // (shouldn't happen by construction but cheap to guard against).
  const allPoints = [...interior, ...edgeMap.values()];

  // Backfill any edge that ended up with too few vertices — happens on
  // tiles at Pass B's bounded-VRT boundary where CTB dropped edge samples
  // (the rim tiles tried to sample slightly outside the VRT extent and got
  // nodata). Sample MOLA globally at those positions and inject as edge
  // vertices. Since neighbor tiles (Pass A1 or other Pass B boundary tiles)
  // sample the same MOLA source at the same lat/lon, edges agree by
  // construction. No more mesh holes, no more multi-meter cross-LOD cliff
  // at the Jezero bbox boundary. We skip this for "clean" interior tiles
  // where the parent is fine AND every child contributed normally — those
  // tiles already have dense, consistent edges from the child polylines
  // and a gdallocationinfo subprocess per tile would 50x the runtime.
  const needsFill = headerCorrupted || anyChildSkipped;
  if (needsFill) fillSparseEdgesFromMola(z, x, y, allPoints);

  // Re-triangulate over (u, v).
  const coords = new Float64Array(allPoints.length * 2);
  for (let i = 0; i < allPoints.length; i++) {
    coords[2 * i] = allPoints[i].u;
    coords[2 * i + 1] = allPoints[i].v;
  }
  let tri;
  try {
    tri = new Delaunator(coords);
  } catch (err) {
    console.warn(`  z=${z} (${x},${y}): triangulation failed (${err.message}); leaving parent untouched`);
    return null;
  }
  // delaunator omits collinear / coincident points from its triangulation.
  // If the resulting triangle set leaves any vertex unused, reorderTri...
  // will reflect that via its remap.

  // delaunator emits triangles CW relative to our (u, v) convention — its
  // notion of CCW assumes y-down (screen) space, but our v-axis goes north-
  // up. CTB-written tiles are CCW (so the renderer's lit-side normals point
  // outward from the planet). Reverse winding here by swapping indices 1,2
  // of each triangle.
  const flipped = new Uint32Array(tri.triangles.length);
  for (let i = 0; i < tri.triangles.length; i += 3) {
    flipped[i] = tri.triangles[i];
    flipped[i + 1] = tri.triangles[i + 2];
    flipped[i + 2] = tri.triangles[i + 1];
  }
  // Reorder triangles for HWM. This compacts vertices to only those used.
  const reordered = reorderTrianglesForHWM(flipped);
  const newVertCount = reordered.vertexCount;
  const newU = new Uint16Array(newVertCount);
  const newV = new Uint16Array(newVertCount);
  const absH = new Float64Array(newVertCount);
  for (let i = 0; i < allPoints.length; i++) {
    const j = reordered.remap[i];
    if (j === -1) continue;
    newU[j] = allPoints[i].u;
    newV[j] = allPoints[i].v;
    absH[j] = allPoints[i].h;
  }

  // Quantize heights to new (minH, maxH).
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < newVertCount; i++) { if (absH[i] < minH) minH = absH[i]; if (absH[i] > maxH) maxH = absH[i]; }
  const range = maxH - minH;
  const newH = new Uint16Array(newVertCount);
  for (let i = 0; i < newVertCount; i++) {
    newH[i] = range === 0 ? 0 : Math.round(((absH[i] - minH) / range) * 32767);
  }

  // Recompute edge indices from new u/v.
  const edges = recomputeEdges(newU, newV);

  // Re-encode. Strip extensions — generated normals come back from the
  // renderer-side `generateNormals` path; availability lives in layer.json.
  const newTile = {
    header: { ...parent.header, minHeight: minH, maxHeight: maxH },
    u: newU, v: newV, h: newH,
    triangles: reordered.triangles,
    westIndices: edges.westIndices,
    southIndices: edges.southIndices,
    eastIndices: edges.eastIndices,
    northIndices: edges.northIndices,
    extensions: [],
  };
  return newTile;
}

/**
 * Boundary leaf resampling. For each z=15 tile, probe HiRISE at 17 evenly-
 * spaced canonical positions along each edge. Any edge with at least one
 * HiRISE-nodata position is a "boundary edge" — its CTB-original vertices
 * get dropped and replaced with canonical samples sourced from HiRISE where
 * HiRISE has coverage, and from MOLA where it doesn't. Adjacent tiles see
 * the identical canonical positions sampling the identical sources →
 * matching edges by construction.
 *
 * Why probe HiRISE directly (not just bbox-check): HiRISE coverage is
 * irregular within its declared bbox — there are large MOLA-fallback regions
 * inside the bbox at the same lat/lon where composite.vrt returns MOLA. The
 * earlier bbox-based classification missed these and left CTB's inconsistent
 * encoding in place, producing visible cracks at interior-tile/boundary-tile
 * junctions inside the bbox.
 *
 * Edges that are entirely HiRISE-covered keep their CTB-original encoding —
 * CTB samples HiRISE at 1 m/px which is fine enough to be sub-mm consistent
 * across adjacent tiles even with CTB's per-tile sampling.
 *
 * Only z=15 needs this — z=10..z=14 parents inherit canonical edges through
 * child projection in the parent sync loop below.
 */
function resampleBoundaryEdges(z, x, y) {
  const tile = readTile(z, x, y);
  if (!tile) return null;
  const headerCorrupted = tile.header.maxHeight === 0;

  // Plan canonical positions on ALL 4 edges. Probe HiRISE; classify each edge
  // as "boundary" if any of its 17 canonical positions is HiRISE-nodata.
  const EDGE_SAMPLES = 17;
  const allRequests = [];
  for (const dir of ['west', 'east', 'south', 'north']) {
    for (let i = 0; i < EDGE_SAMPLES; i++) {
      const t = i / (EDGE_SAMPLES - 1);
      let u, v;
      if (dir === 'west')       { u = 0;     v = Math.round(t * 32767); }
      else if (dir === 'east')  { u = 32767; v = Math.round(t * 32767); }
      else if (dir === 'south') { u = Math.round(t * 32767); v = 0; }
      else                       { u = Math.round(t * 32767); v = 32767; }
      const [lat, lon] = tileUVToLatLon(z, x, y, u, v);
      allRequests.push({ u, v, lat, lon, dir });
    }
  }
  const hiriseProbe = sampleHiriseBatch(allRequests.map(r => [r.lat, r.lon]));
  const edges = { west: false, east: false, south: false, north: false };
  for (let i = 0; i < allRequests.length; i++) {
    // Treat nodata (-32768), failed-fetch NaN, and absurd values as MOLA-fallback.
    const v = hiriseProbe[i];
    const isFallback = !Number.isFinite(v) || v === HIRISE_NODATA || v < -10000;
    if (isFallback) edges[allRequests[i].dir] = true;
  }
  // Header-corrupted tiles always get rebuilt (interior + edges from MOLA);
  // otherwise, if no boundary edges detected, the tile is fully HiRISE-covered
  // at its boundary → nothing to do.
  if (!headerCorrupted && !edges.west && !edges.east && !edges.south && !edges.north) {
    return null;
  }

  // For each boundary edge: place canonical samples at all 17 positions. Use
  // HiRISE values where HiRISE has data, MOLA values otherwise. Adjacent
  // tiles classify the same lat/lon positions identically and pull from the
  // same sources → values match across the shared edge by construction.
  const canonicalEdgeMap = new Map();
  const molaFallbackReqs = [];
  for (let i = 0; i < allRequests.length; i++) {
    const r = allRequests[i];
    if (!edges[r.dir]) continue; // non-boundary edge: keep CTB
    const hv = hiriseProbe[i];
    const isFallback = !Number.isFinite(hv) || hv === HIRISE_NODATA || hv < -10000;
    if (isFallback) {
      molaFallbackReqs.push(r);
    } else {
      const key = `${r.u},${r.v}`;
      if (!canonicalEdgeMap.has(key)) {
        canonicalEdgeMap.set(key, { u: r.u, v: r.v, h: hv });
      }
    }
  }
  if (molaFallbackReqs.length > 0) {
    const molaH = sampleMolaBatch(molaFallbackReqs.map(r => [r.lat, r.lon]));
    for (let i = 0; i < molaFallbackReqs.length; i++) {
      if (!Number.isFinite(molaH[i])) continue;
      const r = molaFallbackReqs[i];
      const key = `${r.u},${r.v}`;
      if (!canonicalEdgeMap.has(key)) {
        canonicalEdgeMap.set(key, { u: r.u, v: r.v, h: molaH[i] });
      }
    }
  }
  if (canonicalEdgeMap.size === 0 && !headerCorrupted) return null;

  // Collect kept points:
  //  - Interior vertices: keep (or rebuild from MOLA if header corrupted)
  //  - Non-boundary edge vertices: keep
  //  - Boundary edge vertices with lat/lon INSIDE HiRISE: keep (CTB-HiRISE wins)
  //  - Boundary edge vertices with lat/lon OUTSIDE HiRISE: drop (canonical wins)
  const keptPoints = [];
  if (headerCorrupted) {
    const GRID = 9;
    const interiorReq = [];
    for (let i = 1; i < GRID - 1; i++) {
      for (let j = 1; j < GRID - 1; j++) {
        const u = Math.round((i / (GRID - 1)) * 32767);
        const v = Math.round((j / (GRID - 1)) * 32767);
        const [lat, lon] = tileUVToLatLon(z, x, y, u, v);
        interiorReq.push({ u, v, lat, lon });
      }
    }
    const ih = sampleMolaBatch(interiorReq.map(r => [r.lat, r.lon]));
    for (let i = 0; i < interiorReq.length; i++) {
      if (Number.isFinite(ih[i])) keptPoints.push({ u: interiorReq[i].u, v: interiorReq[i].v, h: ih[i] });
    }
  } else {
    // Drop CTB edge vertices on boundary edges (their slots are reclaimed by
    // canonical samples); keep interior and non-boundary edge vertices.
    for (let i = 0; i < tile.vertexCount; i++) {
      const u = tile.u[i], v = tile.v[i];
      const onWest = u === 0, onEast = u === 32767, onSouth = v === 0, onNorth = v === 32767;
      const onBoundaryEdge =
        (onWest && edges.west) ||
        (onEast && edges.east) ||
        (onSouth && edges.south) ||
        (onNorth && edges.north);
      if (onBoundaryEdge) continue;
      const absH = dequantizeH(tile.h[i], tile.header.minHeight, tile.header.maxHeight);
      keptPoints.push({ u, v, h: absH });
    }
  }

  // Final point set: kept (filter any colliding with canonical positions) + canonical
  const allPoints = [
    ...keptPoints.filter(p => !canonicalEdgeMap.has(`${p.u},${p.v}`)),
    ...canonicalEdgeMap.values(),
  ];

  // Re-triangulate over (u, v).
  const coords = new Float64Array(allPoints.length * 2);
  for (let i = 0; i < allPoints.length; i++) {
    coords[2 * i] = allPoints[i].u;
    coords[2 * i + 1] = allPoints[i].v;
  }
  let tri;
  try {
    tri = new Delaunator(coords);
  } catch (err) {
    console.warn(`  z=${z} (${x},${y}): leaf-boundary triangulation failed (${err.message}); leaving untouched`);
    return null;
  }
  // delaunator emits CW relative to our y-north-up convention. Flip winding.
  const flipped = new Uint32Array(tri.triangles.length);
  for (let i = 0; i < tri.triangles.length; i += 3) {
    flipped[i] = tri.triangles[i];
    flipped[i + 1] = tri.triangles[i + 2];
    flipped[i + 2] = tri.triangles[i + 1];
  }
  const reordered = reorderTrianglesForHWM(flipped);
  const newVertCount = reordered.vertexCount;
  const newU = new Uint16Array(newVertCount);
  const newV = new Uint16Array(newVertCount);
  const absH = new Float64Array(newVertCount);
  for (let i = 0; i < allPoints.length; i++) {
    const j = reordered.remap[i];
    if (j === -1) continue;
    newU[j] = allPoints[i].u;
    newV[j] = allPoints[i].v;
    absH[j] = allPoints[i].h;
  }
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < newVertCount; i++) { if (absH[i] < minH) minH = absH[i]; if (absH[i] > maxH) maxH = absH[i]; }
  const range = maxH - minH;
  const newH = new Uint16Array(newVertCount);
  for (let i = 0; i < newVertCount; i++) {
    newH[i] = range === 0 ? 0 : Math.round(((absH[i] - minH) / range) * 32767);
  }
  const newEdges = recomputeEdges(newU, newV);
  return {
    header: { ...tile.header, minHeight: minH, maxHeight: maxH },
    u: newU, v: newV, h: newH,
    triangles: reordered.triangles,
    westIndices: newEdges.westIndices,
    southIndices: newEdges.southIndices,
    eastIndices: newEdges.eastIndices,
    northIndices: newEdges.northIndices,
    extensions: [],
  };
}

// Walk the on-disk tile tree at a given zoom and yield (x, y) of every
// existing tile. Cheaper than iterating a theoretical bbox of millions of
// positions and existsSync-checking each one.
function* tilesAtZoom(z) {
  let zDir;
  try { zDir = readdirSync(join(TILE_DIR, String(z))); } catch { return; }
  for (const xName of zDir) {
    if (!/^\d+$/.test(xName)) continue;
    const x = Number(xName);
    let yFiles;
    try { yFiles = readdirSync(join(TILE_DIR, String(z), xName)); } catch { continue; }
    for (const yFile of yFiles) {
      const m = yFile.match(/^(\d+)\.terrain$/);
      if (!m) continue;
      yield { x, y: Number(m[1]) };
    }
  }
}

let totalSynced = 0, totalSkipped = 0;
const startMs = Date.now();

// Leaf-boundary pre-pass at z=10..z=15: every kept tile gets its boundary
// edges (HiRISE-probe detected) rewritten from canonical samples. This makes
// adjacent same-zoom tiles agree at shared edges by construction (both probe
// the same lat/lons against the same HiRISE/MOLA sources, get the same
// values). Without this, CTB's per-tile sampling of MOLA-fallback regions
// inside the Pass B bbox produces 3-9 m mismatches between adjacent tiles.
//
// Why every zoom level (not just z=15): the parent sync loop below
// inherits canonical edges through child projection (z14 from z15, etc.),
// but ONLY for "synced" edges — edges where the same-zoom neighbor has
// children. At the southern edge of HiRISE coverage, 07-delete removed
// z+1 children that were entirely outside HiRISE bbox; this leaves parent
// tiles with un-synced edges that preserve the parent's CURRENT vertices
// instead of pulling from children. Pre-passing at the parent's own zoom
// level ensures those "current vertices" are canonical-resampled, not the
// CTB-inconsistent originals. Cascades cleanly up the pyramid.
{
  const overallStart = Date.now();
  let grandPass = 0, grandSkip = 0;
  for (let z = 15; z >= 10; z--) {
    const zStart = Date.now();
    let pass = 0, skip = 0, count = 0;
    for (const { x, y } of tilesAtZoom(z)) {
      count++;
      const result = resampleBoundaryEdges(z, x, y);
      if (result == null) { skip++; continue; }
      writeFileSync(tilePath(z, x, y), gzipSync(encodeTile(result), { level: 9 }));
      pass++;
    }
    const zElapsed = (Date.now() - zStart) / 1000;
    console.log(`  z=${String(z).padStart(2)} leaf-boundary: ${count} tiles seen → resampled ${pass}, interior-only ${skip}  (${zElapsed.toFixed(1)}s)`);
    grandPass += pass; grandSkip += skip;
  }
  const allElapsed = (Date.now() - overallStart) / 1000;
  console.log(`  leaf-boundary total: resampled ${grandPass.toLocaleString()}, interior-only ${grandSkip.toLocaleString()}  (${allElapsed.toFixed(1)}s)`);
  totalSynced += grandPass; totalSkipped += grandSkip;
}

// Bottom-up: sync z=MAX_PARENT_Z first (children = z=MAX_PARENT_Z+1 leaves),
// then z=MAX_PARENT_Z-1 (children = already-synced z=MAX_PARENT_Z), etc.
// This now runs over the ENTIRE on-disk pyramid, not just the Jezero
// extent — Pass A1 wrote MOLA z0-z9 globally, and adjacent same-LOD MOLA
// tiles have small (~0.02m) cross-LOD mismatches that show as thin
// rasterization-style cracks at low sun angles even far from Jezero.
// Syncing every parent against its children turns those into matched
// polylines globally.
for (let z = MAX_PARENT_Z; z >= MIN_PARENT_Z; z--) {
  let pass = 0, skip = 0, count = 0;
  const zStart = Date.now();
  for (const { x, y } of tilesAtZoom(z)) {
    count++;
    const result = syncParent(z, x, y);
    if (result == null) { skip++; continue; }
    writeFileSync(tilePath(z, x, y), gzipSync(encodeTile(result), { level: 9 }));
    pass++;
  }
  totalSynced += pass; totalSkipped += skip;
  const zElapsed = (Date.now() - zStart) / 1000;
  console.log(`  z=${String(z).padStart(2)}: ${count} tiles seen → synced ${pass}, skipped ${skip}  (${zElapsed.toFixed(1)}s)`);
}

const elapsed = (Date.now() - startMs) / 1000;
console.log(`\nDone. Synced ${totalSynced.toLocaleString()} parent tiles (${totalSkipped.toLocaleString()} skipped, ${elapsed.toFixed(1)}s).`);
