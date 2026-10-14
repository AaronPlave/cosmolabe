#!/usr/bin/env node
/**
 * Numerical validation of the cube-sphere terrain experiment (issue #149).
 *
 * Reads a product written by `scripts/build-moon-terrain/cube.sh` straight from
 * disk — every emitted .glb and CPU height grid — and checks it with the same
 * compiled modules the viewer runs (CubeSphere.ts addressing, the CPU grid
 * source and its #148 ray surface):
 *
 *   gates (non-zero exit on failure)
 *   - six-face coverage: six face roots, complete global levels
 *   - REPLACE completeness: a refining tile has exactly its four children
 *   - subtree bounds: every vertex inside its content box, node box and all ancestors'
 *   - same-level shared vertices: identical CPU heights; positions/normals equal
 *     within float32 tile-offset precision, within a face, across faces and at corners
 *   - CPU grids match the emitted lattice vertices
 *   - pole / antimeridian / child-boundary ownership on the real product
 *
 *   measurements (reported, not gated: the point is to measure, not assume)
 *   - mixed-LOD cracks without skirts: gap between a tile's edge vertices and
 *     each coarser neighbour's edge line actually present across that edge
 *   - CPU bilinear samples vs the emitted triangles along the same radial ray
 *   - control points: MoonFall's LOLA 118 m waypoint elevations vs CPU samples
 *   - picking and camera clearance through the #148 port, against brute-force
 *     intersection with the emitted float32 triangles
 *
 * Run `npm run build` first (it imports packages/three/dist).
 *
 *   node scripts/validate-cube-terrain.mjs [--dir DIR] [--out DIR] [--seed N]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]]);
  return acc;
}, []));
const DIR = resolve(args.dir ?? join(ROOT, 'apps/viewer/test-catalogs/data/moon-terrain-cube'));
const OUT = resolve(args.out ?? join(ROOT, 'work/cube-terrain'));
const DIST = join(ROOT, 'packages/three/dist/surface');
if (!existsSync(join(DIST, 'CubeSphereGrids.js'))) {
  console.error('validate-cube-terrain: packages/three/dist is missing — run `npm run build` first.');
  process.exit(2);
}
const { cubeFaceToDirection, cubeTileAt, cubeTileId, CubeSphereSampler } = await import(pathToFileURL(join(DIST, 'CubeSphere.js')).href);
const { CubeSphereGridSource, CubeGridSurface } = await import(pathToFileURL(join(DIST, 'CubeSphereGrids.js')).href);
const { cameraPositionFromSurfacePick } = await import(pathToFileURL(join(DIST, 'SurfaceConsumers.js')).href);
const { requestSurfaceIntersection } = await import(pathToFileURL(join(DIST, 'PhysicalSurface.js')).href);

const t0 = performance.now();
const tileset = JSON.parse(readFileSync(join(DIR, 'tileset.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(DIR, 'cpu-grids.json'), 'utf8'));
const product = JSON.parse(readFileSync(join(DIR, 'terrain-product.json'), 'utf8'));
const G = manifest.grid.width;
const R_M = manifest.datum.referenceShape.radiusKm * 1000;
const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const failures = [];
const gate = (ok, message) => { if (!ok) failures.push(message); return ok; };

// Face bases from the compiled mapping itself, not a second copy: N = d(0,0),
// U = d(1,0)·√2 − N, V = d(0,1)·√2 − N (exact unit axes once rounded).
const BASES = Object.fromEntries(FACES.map((f) => {
  const n = cubeFaceToDirection(f, 0, 0).map(Math.round);
  const axis = (u, v) => cubeFaceToDirection(f, u, v).map((c, i) => Math.round(c * Math.SQRT2 - n[i]));
  return [f, [n, axis(1, 0), axis(0, 1)]];
}));
/** Exact body vector N + uU + vV, the builder's shared-vertex identity. */
const exactP = (f, u, v) => { const [n, a, b] = BASES[f]; return [0, 1, 2].map(i => n[i] + u * a[i] + v * b[i]); };
const keyOf = (p) => `${p[0]},${p[1]},${p[2]}`;
const dyadic = (k, level) => { const N = (G - 1) * 2 ** level; return (2 * k - N) / N; };
const norm = (p) => Math.hypot(p[0], p[1], p[2]);
const unit = (p) => { const l = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]); return [p[0] / l, p[1] / l, p[2] / l]; };

function stats(values) {
  if (!values.length) return { n: 0 };
  const a = Float64Array.from(values, Math.abs).sort();
  let sq = 0; for (const v of values) sq += v * v;
  return { n: values.length, maxM: a[a.length - 1], rmsM: Math.sqrt(sq / values.length), p95M: a[Math.min(a.length - 1, Math.floor(0.95 * a.length))] };
}
const fmt = (s) => s.n ? `n=${s.n} max=${s.maxM.toFixed(3)} rms=${s.rmsM.toFixed(3)} p95=${s.p95M.toFixed(3)} m` : 'n=0';

function readGlb(path) {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const js = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const bin = 20 + jsonLen + 8;
  const view = (a) => new Float32Array(buf.buffer.slice(buf.byteOffset + bin + js.bufferViews[a].byteOffset,
    buf.byteOffset + bin + js.bufferViews[a].byteOffset + js.accessors[a].count * 12));
  const pos = view(0), nrm = view(1), t = js.nodes[0].translation;
  const n = js.accessors[0].count;
  // glTF Y-up (x, z, −y) back to body-fixed Z-up, translation added in float64.
  const P = new Float64Array(n * 3), Nr = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    P[i * 3] = pos[i * 3] + t[0]; P[i * 3 + 1] = -(pos[i * 3 + 2] + t[2]); P[i * 3 + 2] = pos[i * 3 + 1] + t[1];
    Nr[i * 3] = nrm[i * 3]; Nr[i * 3 + 1] = -nrm[i * 3 + 2]; Nr[i * 3 + 2] = nrm[i * 3 + 1];
  }
  return { P, N: Nr, vertices: n, indexCount: js.accessors[2].count };
}
const readGrid = (f, L, x, y) => {
  const b = readFileSync(join(DIR, 'heights', f, String(L), String(x), `${y}.f32`));
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

// ---------------------------------------------------------------------------
// 1. Tree: coverage, REPLACE completeness, subtree bounds, shared vertices.

const tiles = new Map(); // id → { face, L, x, y }
const levelMaps = new Map(); // L → Map(key → { P, N, h, faces:Set })
const shared = { sameFace: [], crossFace: [], corner: [], normalDeg: [], heightMismatch: 0 };
const boundsEscapes = [], gridMismatch = [], sharedEscapes = [], outOfRange = [];
let maxBoundsExcessM = 0;
const inside = (box, x, y, z) => Math.max(Math.abs(x - box[0]) - box[3], Math.abs(y - box[1]) - box[7], Math.abs(z - box[2]) - box[11]);

const root = tileset.root;
gate(!root.content && root.children?.length === 6 && root.geometricError >= 1e9, 'root must be content-less, always refine, and hold six face roots');
gate(root.refine === 'REPLACE', 'root must use REPLACE refinement');
const faceRoots = new Set();

function walk(node, ancestors) {
  const [f, Ls, xs, ys] = node.content.uri.replace(/\.glb$/, '').split('/');
  const L = Number(Ls), x = Number(xs), y = Number(ys);
  const id = cubeTileId({ face: f, level: L, x, y });
  if (L === 0) faceRoots.add(f);
  // Float32 offsets from the box centre: ~2⁻²⁴ of the largest offset per axis.
  const box = node.content.boundingVolume.box;
  const f32TolM = 1e-4 + 4 * 2 ** -24 * Math.max(box[3], box[7], box[11]);
  tiles.set(id, { face: f, level: L, L, x, y, f32TolM });
  const kids = node.children ?? [];
  if (kids.length) {
    const want = new Set([[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => cubeTileId({ face: f, level: L + 1, x: 2 * x + dx, y: 2 * y + dy })));
    const got = new Set(kids.map(k => k.content.uri.replace(/\.glb$/, '')));
    gate(kids.length === 4 && [...want].every(w => got.has(w)), `${id}: REPLACE parent must hold exactly its four children`);
  }
  const glb = readGlb(join(DIR, node.content.uri));
  gate(glb.vertices === G * G || product.mesh.skirts !== 'none', `${id}: unexpected vertex count ${glb.vertices}`);
  gate(glb.indexCount === (G - 1) * (G - 1) * 6 || product.mesh.skirts !== 'none', `${id}: unexpected index count`);
  const h = readGrid(f, L, x, y);
  for (const v of h) if (!(v / 1000 >= manifest.heightRangeKm[0] && v / 1000 <= manifest.heightRangeKm[1])) { outOfRange.push(`${id}: ${v} m`); break; }
  const boxes = [node.content.boundingVolume.box, node.boundingVolume.box, ...ancestors];
  let worst = -Infinity;
  for (let i = 0; i < glb.vertices; i++) for (const box of boxes) worst = Math.max(worst, inside(box, glb.P[i * 3], glb.P[i * 3 + 1], glb.P[i * 3 + 2]));
  maxBoundsExcessM = Math.max(maxBoundsExcessM, worst);
  if (worst > 1e-6) boundsEscapes.push(`${id} by ${worst.toFixed(4)} m`);
  let map = levelMaps.get(L);
  if (!map) levelMaps.set(L, map = new Map());
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const v = j * G + i;
    const P = [glb.P[v * 3], glb.P[v * 3 + 1], glb.P[v * 3 + 2]];
    const r = norm(P) - (R_M + h[v]);
    if (Math.abs(r) > f32TolM) gridMismatch.push(`${id}[${i},${j}] ${r.toFixed(3)} m`);
    if (i !== 0 && j !== 0 && i !== G - 1 && j !== G - 1) continue;
    const key = keyOf(exactP(f, dyadic((G - 1) * x + i, L), dyadic((G - 1) * y + j, L)));
    const Nv = [glb.N[v * 3], glb.N[v * 3 + 1], glb.N[v * 3 + 2]];
    const prior = map.get(key);
    if (!prior) { map.set(key, { P, N: Nv, h: h[v], faces: new Set([f]), tol: f32TolM }); continue; }
    const d = Math.hypot(P[0] - prior.P[0], P[1] - prior.P[1], P[2] - prior.P[2]);
    if (d > prior.tol + f32TolM) sharedEscapes.push(`${id}[${i},${j}] ${d.toFixed(4)} m`);
    prior.faces.add(f);
    (prior.faces.size === 3 ? shared.corner : prior.faces.size === 2 ? shared.crossFace : shared.sameFace).push(d);
    const cx = Nv[1] * prior.N[2] - Nv[2] * prior.N[1], cy = Nv[2] * prior.N[0] - Nv[0] * prior.N[2], cz = Nv[0] * prior.N[1] - Nv[1] * prior.N[0];
    shared.normalDeg.push(Math.atan2(Math.hypot(cx, cy, cz), Nv[0] * prior.N[0] + Nv[1] * prior.N[1] + Nv[2] * prior.N[2]) * 180 / Math.PI);
    if (h[v] !== prior.h) { shared.heightMismatch++; shared.heightMismatchAt ??= []; shared.heightMismatchAt.push({ id, i, j, key, h: h[v], other: prior.h, faces: [...prior.faces] }); }
  }
  for (const k of kids) walk(k, [...ancestors, node.boundingVolume.box]);
}
for (const face of root.children) walk(face, [root.boundingVolume.box]);

gate(faceRoots.size === 6, `six face roots expected, found ${[...faceRoots]}`);
const perLevel = {};
for (const t of tiles.values()) perLevel[t.L] = (perLevel[t.L] ?? 0) + 1;
for (let L = 0; L <= product.tiling.globalLevel; L++) gate(perLevel[L] === 6 * 4 ** L, `global level ${L} must have ${6 * 4 ** L} tiles, has ${perLevel[L]}`);
gate(manifest.tiles.length === tiles.size && manifest.tiles.every(([f, L, x, y]) => tiles.has(cubeTileId({ face: f, level: L, x, y }))),
  'cpu-grids.json must list exactly the tileset tiles');
gate(boundsEscapes.length === 0, `vertices escape bounding volumes: ${boundsEscapes.slice(0, 5).join('; ')}`);
gate(Array.isArray(manifest.heightRangeKm) && outOfRange.length === 0, `heightRangeKm ${JSON.stringify(manifest.heightRangeKm)} must enclose every grid: ${outOfRange.slice(0, 5).join('; ')}`);
gate(gridMismatch.length === 0, `CPU grids disagree with emitted vertices: ${gridMismatch.slice(0, 5).join('; ')}`);
gate(shared.heightMismatch === 0, `${shared.heightMismatch} shared vertices have different CPU heights: ${JSON.stringify(shared.heightMismatchAt?.slice(0, 3))}`);
gate(sharedEscapes.length === 0, `shared vertices differ beyond float32 tile-offset precision: ${sharedEscapes.slice(0, 5).join('; ')}`);
gate(shared.corner.length > 0 && shared.crossFace.length > 0, 'expected cross-face edge and corner vertices');
console.log(`tree: ${tiles.size} tiles, levels ${JSON.stringify(perLevel)} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
console.log(`shared vertices: same-face ${fmt(stats(shared.sameFace))}; cross-face ${fmt(stats(shared.crossFace))}; corners ${fmt(stats(shared.corner))}`);

// ---------------------------------------------------------------------------
// 2. Mixed-LOD cracks (no skirts): each tile edge on its parent's boundary
// against every coarser level that has a tile across that edge.

/** The tile across an edge of (f, L, x, y) at `level`, via the compiled addressing. */
function across(t, edge, level) {
  const N = 2 ** t.L;
  const mid = [(-1 + (2 * t.x + 1) / N), (-1 + (2 * t.y + 1) / N)];
  const step = 1e-9;
  const uv = edge === 'W' ? [-1 + 2 * t.x / N - step, mid[1]] : edge === 'E' ? [-1 + 2 * (t.x + 1) / N + step, mid[1]]
    : edge === 'S' ? [mid[0], -1 + 2 * t.y / N - step] : [mid[0], -1 + 2 * (t.y + 1) / N + step];
  const a = cubeTileAt(unit(exactP(t.face, uv[0], uv[1])), level);
  return cubeTileId(a);
}
const cracks = {}, crossFaceCracks = [], crackWorst = [];
for (const t of tiles.values()) {
  if (t.L === 0) continue;
  const glbEdges = [];
  // Edges on the parent's boundary only: inner edges always meet a sibling.
  if (t.x % 2 === 0) glbEdges.push('W'); else glbEdges.push('E');
  if (t.y % 2 === 0) glbEdges.push('S'); else glbEdges.push('N');
  const fine = levelMaps.get(t.L);
  for (const edge of glbEdges) {
    for (let M = t.L - 1; M >= 0; M--) {
      const nid = across(t, edge, M);
      // REPLACE never draws a tile beside its own ancestor; any other tile
      // across the line has it on its boundary, so its edge vertices are keyed.
      const ancestor = cubeTileId({ face: t.face, level: M, x: t.x >> (t.L - M), y: t.y >> (t.L - M) });
      if (!tiles.has(nid) || nid === ancestor) continue;
      const crossFace = !nid.startsWith(t.face + '/');
      const coarse = levelMaps.get(M);
      const scale = 2 ** (t.L - M);
      let worst = 0;
      for (let s = 0; s < G; s++) {
        const [ki, kj] = edge === 'W' ? [0, s] : edge === 'E' ? [G - 1, s] : edge === 'S' ? [s, 0] : [s, G - 1];
        const gi = (G - 1) * t.x + ki, gj = (G - 1) * t.y + kj; // fine global indices
        const fineKey = keyOf(exactP(t.face, dyadic(gi, t.L), dyadic(gj, t.L)));
        const P = fine.get(fineKey).P;
        // Coarse vertices bracketing this one along the edge (the same dyadic rationals).
        const along = edge === 'W' || edge === 'E' ? gj : gi;
        const lo = Math.floor(along / scale) * scale, hi = Math.ceil(along / scale) * scale;
        const at = (g) => {
          const [ii, jj] = edge === 'W' || edge === 'E' ? [gi, g] : [g, gj];
          return coarse.get(keyOf(exactP(t.face, dyadic(ii, t.L), dyadic(jj, t.L))))?.P;
        };
        const A = at(lo), B = at(hi);
        if (!A || !B) { failures.push(`${cubeTileId(t)} ${edge}: coarse edge vertex missing at level ${M}`); continue; }
        const w = hi === lo ? 0 : (along - lo) / (hi - lo);
        const Q = [A[0] + (B[0] - A[0]) * w, A[1] + (B[1] - A[1]) * w, A[2] + (B[2] - A[2]) * w];
        const d = Math.hypot(P[0] - Q[0], P[1] - Q[1], P[2] - Q[2]);
        (cracks[`${t.L}-${M}`] ??= []).push(d);
        if (crossFace) crossFaceCracks.push(d);
        worst = Math.max(worst, d);
      }
      crackWorst.push({ tile: cubeTileId(t), edge, against: nid, crossFace, maxM: worst });
    }
  }
}
crackWorst.sort((a, b) => b.maxM - a.maxM);
const crackByPair = Object.fromEntries(Object.entries(cracks).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([k, v]) => [k, stats(v)]));
const crackDelta1 = stats(Object.entries(cracks).filter(([k]) => { const [a, b] = k.split('-').map(Number); return a - b === 1; }).flatMap(([, v]) => v));
const crackDelta1ByLevel = Object.fromEntries(Object.entries(crackByPair).filter(([k]) => { const [a, b] = k.split('-').map(Number); return a - b === 1; }));
console.log(`cracks (Δlevel = 1): ${fmt(crackDelta1)}; across faces ${fmt(stats(crossFaceCracks))}`);
for (const [k, v] of Object.entries(crackDelta1ByLevel)) console.log(`  L${k.replace('-', '→L')}: ${fmt(v)}`);

// Parent/child heights at coincident dyadic positions (child − parent), the
// metric scripts/validate-terrain.mjs reports for the geographic pyramid.
const parentChild = {};
for (const t of tiles.values()) {
  if (t.L === 0) continue;
  const child = readGrid(t.face, t.L, t.x, t.y), parent = readGrid(t.face, t.L - 1, t.x >> 1, t.y >> 1);
  const ox = (t.x & 1) * (G - 1) / 2, oy = (t.y & 1) * (G - 1) / 2;
  const diffs = (parentChild[t.L] ??= []);
  for (let j = 0; j < G; j += 2) for (let i = 0; i < G; i += 2) diffs.push(child[j * G + i] - parent[(oy + j / 2) * G + ox + i / 2]);
}
const parentChildStats = Object.fromEntries(Object.entries(parentChild).map(([L, v]) => [L, stats(v)]));
console.log('parent/child (child − parent at shared dyadic positions):');
for (const [L, v] of Object.entries(parentChildStats)) console.log(`  L${L}: ${fmt(v)}`);

// ---------------------------------------------------------------------------
// 3. CPU bilinear samples vs the emitted triangles along the same radial ray.

let seed = Number(args.seed ?? 149) >>> 0;
const rand = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const datum = manifest.datum;
const cpuVsTri = {};
const PER_TILE = Number(args['samples-per-tile'] ?? 24);
for (const t of tiles.values()) {
  const glb = readGlb(join(DIR, t.face, String(t.L), String(t.x), `${t.y}.glb`));
  const h = readGrid(t.face, t.L, t.x, t.y);
  const sampler = new CubeSphereSampler(datum, manifest.source);
  sampler.addTile({ face: t.face, level: t.L, x: t.x, y: t.y, width: G, height: G, elevationsKm: Float64Array.from(h, v => v / 1000) });
  for (let s = 0; s < PER_TILE; s++) {
    const fi = rand() * (G - 1), fj = rand() * (G - 1);
    const u = -1 + 2 * (t.x + fi / (G - 1)) / 2 ** t.L, v = -1 + 2 * (t.y + fj / (G - 1)) / 2 ** t.L;
    const d = unit(exactP(t.face, u, v));
    const lat = Math.atan2(d[2], Math.hypot(d[0], d[1])) * 180 / Math.PI, lon = Math.atan2(d[1], d[0]) * 180 / Math.PI;
    const sample = sampler.sample(lat, lon);
    if (!gate(sample != null, `${cubeTileId(t)}: CPU sampler has no answer inside its own tile`)) continue;
    // The triangle whose (u, v) projection holds the point: gnomonic maps the
    // planar triangle's radial image to straight lines in (u, v).
    const i0 = Math.min(G - 2, Math.floor(fi)), j0 = Math.min(G - 2, Math.floor(fj));
    const a = j0 * G + i0, b = a + 1, c = a + G + 1, e = a + G;
    const [p, q, r] = fi - i0 >= fj - j0 ? [a, b, c] : [a, c, e];
    const V = (k) => [glb.P[k * 3], glb.P[k * 3 + 1], glb.P[k * 3 + 2]];
    const A = V(p), B = V(q), C = V(r);
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const tRay = (n[0] * A[0] + n[1] * A[1] + n[2] * A[2]) / (n[0] * d[0] + n[1] * d[1] + n[2] * d[2]);
    (cpuVsTri[t.L] ??= []).push(tRay - (R_M + sample.elevationKm * 1000));
  }
}
const cpuVsTriStats = Object.fromEntries(Object.entries(cpuVsTri).map(([L, v]) => [L, { ...stats(v), meanM: v.reduce((s, x) => s + x, 0) / v.length }]));
console.log('CPU bilinear − triangle (radial, m):');
for (const [L, s] of Object.entries(cpuVsTriStats)) console.log(`  L${L}: ${fmt(s)} mean=${s.meanM.toFixed(3)}`);

// ---------------------------------------------------------------------------
// 4. The viewer's CPU source on the real product: ownership, coverage, control points, picking.

const source = new CubeSphereGridSource(manifest, async (uri) => {
  const b = readFileSync(join(DIR, uri));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}, { residentLevel: 2, maxDetailTiles: 100000 });
await source.ready;
const ownership = [];
const own = (label, points) => {
  const results = points.map(([lat, lon]) => source.sampler.sample(lat, lon));
  const ids = new Set(results.map(r => r?.tileId)), hs = new Set(results.map(r => r?.elevationKm));
  const ok = results.every(Boolean) && ids.size === 1 && hs.size === 1;
  ownership.push({ label, points, tileId: [...ids][0], elevationKm: [...hs][0], ok });
  gate(ok, `${label}: equivalent coordinates answered differently (${[...ids].join(', ')})`);
};
const shackleton = [-89.67, 129.78];
const before = source.coverage(...shackleton);
gate(before.state === 'parent-fallback' && before.residentLevel === 2 && before.availableLevel === manifest.maxLevel,
  `Shackleton must start on the level-2 fallback, got ${JSON.stringify(before)}`);
for (const [lat, lon] of [shackleton, [-90, 0], [0, 180], [-45, 0], [-35.26438968, 45], [0, 0], [-60, -180]]) await source.request(lat, lon);
const after = source.coverage(...shackleton);
gate(after.state === 'finest' && after.residentLevel === manifest.maxLevel, `Shackleton must reach the finest level, got ${JSON.stringify(after)}`);
own('south pole, any longitude', [[-90, 0], [-90, 90], [-90, 137], [-90, 180], [-90, -180], [-90, -45], [-90, 360]]);
own('north pole, any longitude', [[90, 0], [90, 90], [90, -180], [90, 270]]);
own('antimeridian equator', [[0, 180], [0, -180], [0, 540], [0, -540]]);
own('antimeridian 60°S', [[-60, 180], [-60, -180]]);
own('prime meridian equator (px centre: child boundary at every level)', [[0, 0], [0, 360], [0, -360]]);
own('px/nz edge midpoint (selected detail)', [[-45, 0], [-45, 360]]);
// Exact child boundaries pick the upper child (floor convention) at the finest resident level.
const edgeOwner = source.sampler.sample(-45, 0);
const expected = cubeTileId(cubeTileAt(unit([1, 0, -1]), Number(edgeOwner.tileId.split('/')[1])));
gate(edgeOwner.tileId === expected, `px/nz edge must belong to ${expected}, got ${edgeOwner.tileId}`);
console.log(`ownership: ${ownership.map(o => `${o.label} → ${o.tileId}`).join('; ')}`);

const cps = Object.entries(JSON.parse(readFileSync(join(ROOT, 'scripts/data/moon-elevations.json'), 'utf8'))).map(([k, m]) => {
  const [lat, lon] = k.split(',').map(Number); return { lat, lon, lolaM: m };
});
for (const cp of cps) await source.request(cp.lat, cp.lon);
const controlRows = cps.map(cp => {
  const s = source.sampler.sample(cp.lat, cp.lon), c = source.coverage(cp.lat, cp.lon);
  return { latDeg: cp.lat, lonDeg: cp.lon, lola118M: cp.lolaM, cubeM: s.elevationKm * 1000, deltaM: s.elevationKm * 1000 - cp.lolaM, tileId: s.tileId, state: c.state };
});
const controlStats = stats(controlRows.map(r => r.deltaM));
gate(controlRows.every(r => r.state === 'finest'), 'every control point must be answered at its finest level');
console.log(`control points vs LOLA 118 m: ${fmt(controlStats)}`);

// Picking + clearance: rays at targets around Shackleton, the pole, the corner
// and the edge, 0–60° off nadir, against brute-force float32 triangle hits.
const surface = new CubeGridSurface(source, '301', 'IAU_MOON');
source.onChange = (id) => surface.invalidate(id);
const glbCache = new Map();
/** Nearest hit on the emitted float32 triangles of the hit tile and its same-level neighbours (a hit can sit on a shared edge). */
function bruteForce(ray, hit) {
  const level = Number(hit.tileId.split('/')[1]);
  const p = [hit.position.xKm, hit.position.yKm, hit.position.zKm], r = norm(p);
  const ids = new Set([hit.tileId]);
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const q = [p[0] / r + 1e-9 * dx, p[1] / r + 1e-9 * dy, p[2] / r + 1e-9 * dz];
    const id = cubeTileId(cubeTileAt(unit(q), level));
    if (tiles.has(id)) ids.add(id);
  }
  return Math.min(...[...ids].map(id => bruteForceTile(ray, id)));
}
function bruteForceTile(ray, tileId) {
  let glb = glbCache.get(tileId);
  if (!glb) { const [f, L, x, y] = tileId.split('/'); glbCache.set(tileId, glb = readGlb(join(DIR, f, L, x, `${y}.glb`))); }
  const o = [ray.origin.xKm * 1000, ray.origin.yKm * 1000, ray.origin.zKm * 1000], d = unit(ray.direction);
  let best = Infinity;
  for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) {
    const a = j * G + i;
    for (const [p, q, r] of [[a, a + 1, a + G + 1], [a, a + G + 1, a + G]]) {
      const A = [glb.P[p * 3], glb.P[p * 3 + 1], glb.P[p * 3 + 2]];
      const e1 = [glb.P[q * 3] - A[0], glb.P[q * 3 + 1] - A[1], glb.P[q * 3 + 2] - A[2]];
      const e2 = [glb.P[r * 3] - A[0], glb.P[r * 3 + 1] - A[1], glb.P[r * 3 + 2] - A[2]];
      const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
      if (Math.abs(det) < 1e-12) continue;
      const tv = [o[0] - A[0], o[1] - A[1], o[2] - A[2]];
      const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) / det;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
      const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) / det;
      if (v < -1e-6 || u + v > 1 + 1e-6) continue;
      const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det;
      if (t > 0 && t < best) best = t;
    }
  }
  return best;
}
const pickRows = [];
const PICKS_PER_SITE = Number(args['picks-per-site'] ?? 30);
const sites = [['shackleton', ...shackleton, 12], ['pole', -90, 0, 8], ['corner', -35.26438968, 45, 20], ['edge', -45, 0, 20]];
for (const [site, lat0, lon0, spreadKm] of sites) {
  for (let k = 0; k < PICKS_PER_SITE; k++) {
    // A surface target near the site, then a camera 2 km above it, tilted up to 60°.
    const brg = rand() * 2 * Math.PI, dist = rand() * spreadKm / 1737.4;
    const la = lat0 * Math.PI / 180, lo = lon0 * Math.PI / 180;
    const tLat = Math.asin(Math.sin(la) * Math.cos(dist) + Math.cos(la) * Math.sin(dist) * Math.cos(brg));
    const tLon = lo + Math.atan2(Math.sin(brg) * Math.sin(dist) * Math.cos(la), Math.cos(dist) - Math.sin(la) * Math.sin(tLat));
    const tDeg = [tLat * 180 / Math.PI, tLon * 180 / Math.PI];
    await source.request(...tDeg);
    const up = [Math.cos(tLat) * Math.cos(tLon), Math.cos(tLat) * Math.sin(tLon), Math.sin(tLat)];
    const h = source.sampler.sample(...tDeg).elevationKm;
    const target = up.map(c => c * (1737.4 + h));
    const tilt = rand() * Math.PI / 3, az = rand() * 2 * Math.PI;
    const east = unit([-up[1], up[0], 0].map((c, i) => (Math.abs(up[2]) > 0.999999 ? [1, 0, 0][i] : c)));
    const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
    const off = [0, 1, 2].map(i => up[i] * Math.cos(tilt) + Math.sin(tilt) * (east[i] * Math.cos(az) + north[i] * Math.sin(az)));
    const eye = target.map((c, i) => c + 2 * off[i]);
    const ray = { origin: { xKm: eye[0], yKm: eye[1], zKm: eye[2] }, direction: [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]], nearKm: 0, farKm: 10 };
    // The #148 async path: one ensure-coverage pass along the ray, then a requery.
    const hit = await requestSurfaceIntersection(surface, ray, { maxMeshErrorKm: 0.001 }, new AbortController().signal, surface);
    if (hit.kind !== 'hit') writeFileSync(join(OUT, `failed-ray-${site}-${k}.json`), JSON.stringify({ ray, target, tDeg }));
    if (!gate(hit.kind === 'hit', `${site} pick ${k}: ${hit.kind} ${hit.reason ?? ''} target ${tDeg.map(v => v.toFixed(5))} eye ${eye.map(v => v.toFixed(4))} coverage ${JSON.stringify(source.coverage(...tDeg))}`)) continue;
    const brute = bruteForce(ray, hit);
    const pickVsGlbM = Math.abs(brute - hit.distanceKm * 1000);
    if (!Number.isFinite(brute)) failures.push(`${site} pick ${k}: no float32 triangle hit in ${hit.tileId} at ${JSON.stringify(hit.position)} (CPU distance ${hit.distanceKm} km, triangle ${hit.triangleIndex})`);
    const cam = cameraPositionFromSurfacePick(hit, 0.05, true);
    const camR = norm([cam.xKm, cam.yKm, cam.zKm]);
    const camLat = Math.asin(cam.zKm / camR) * 180 / Math.PI, camLon = Math.atan2(cam.yKm, cam.xKm) * 180 / Math.PI;
    await source.request(camLat, camLon);
    const below = source.sampler.sample(camLat, camLon);
    const clearanceAboveSampleM = (camR - 1737.4 - below.elevationKm) * 1000;
    const back = await requestSurfaceIntersection(surface, { origin: cam, direction: [-hit.normal[0], -hit.normal[1], -hit.normal[2]], nearKm: 0, farKm: 1 },
      { maxMeshErrorKm: 0.001 }, new AbortController().signal, surface);
    const lineOfSightM = back.kind === 'hit' ? back.distanceKm * 1000 : null;
    pickRows.push({ site, tileId: hit.tileId, detail: hit.detail, pickVsGlbM, clearanceAboveSampleM, lineOfSightM, renderedNormalUp: hit.normal.reduce((s, c, i) => s + c * up[i], 0) });
  }
}
const pickStats = stats(pickRows.map(r => r.pickVsGlbM));
const losStats = stats(pickRows.map(r => r.lineOfSightM - 50));
const clearanceMin = Math.min(...pickRows.map(r => r.clearanceAboveSampleM));
gate(pickRows.every(r => r.detail === 'coarse'), 'partial-coverage hits must stay provisional (coarse)');
gate(pickStats.maxM < 0.05, `CPU picks must match the emitted triangles (max ${pickStats.maxM} m)`);
// Placement is gated; full clearance along the normal is measured: the #148
// consumer places a camera, it does not certify a swept volume, and nearby
// relief in a concave spot can come closer than the requested 50 m.
gate(clearanceMin > 0, `clearance camera below the CPU surface (${clearanceMin} m)`);
const fullClearance = pickRows.filter(r => r.lineOfSightM != null && Math.abs(r.lineOfSightM - 50) < 0.01).length;
console.log(`picking: ${pickRows.length} rays, CPU vs float32 triangles ${fmt(pickStats)}; clearance: ${fullClearance}/${pickRows.length} see their hit at 50 m, LOS error ${fmt(losStats)}; min height above CPU sample ${clearanceMin.toFixed(2)} m`);

// ---------------------------------------------------------------------------

const report = {
  generator: 'scripts/validate-cube-terrain.mjs',
  created: new Date().toISOString(),
  product: { dir: relative(ROOT, DIR), version: manifest.source.version, tileCount: tiles.size, tilesPerLevel: perLevel, bytes: product.bytes,
    generationSeconds: product.generationSeconds, workers: product.workers, skirts: product.mesh.skirts },
  structure: { faceRoots: [...faceRoots], replaceComplete: !failures.some(f => f.includes('REPLACE')), maxBoundsExcessM, boundsEscapes: boundsEscapes.length,
    cpuGridVsVertexMismatches: gridMismatch.length },
  sharedVertices: { tolerance: 'sum of both tiles\' float32 offset precision (1e-4 m + 4·2⁻²⁴·largest box half-extent)', sameFace: stats(shared.sameFace), crossFace: stats(shared.crossFace), corner: stats(shared.corner),
    normalDeg: stats(shared.normalDeg), cpuHeightMismatches: shared.heightMismatch },
  mixedLodCracksNoSkirts: { note: 'gap between a tile edge vertex and the straight edge of each coarser neighbour present across that edge (fine-coarse level pairs)',
    deltaLevel1: crackDelta1, deltaLevel1ByLevel: crackDelta1ByLevel, crossFace: stats(crossFaceCracks), byLevelPair: crackByPair, worstEdges: crackWorst.slice(0, 10) },
  parentChildHeights: { note: 'child − parent CPU heights at the parent\'s own lattice positions, by child level (as validate-terrain.mjs reports for the geographic pyramid)', byChildLevel: parentChildStats },
  cpuBilinearVsTriangles: { note: 'radial distance along the same geocentric ray: emitted float32 triangle − (datum + CPU bilinear height); positive = triangle above CPU sample',
    samplesPerTile: PER_TILE, byLevel: cpuVsTriStats },
  representationVsFusedField: product.representationErrorM,
  ownership: { shackletonBefore: before, shackletonAfter: after, cases: ownership },
  controlPoints: { reference: 'scripts/data/moon-elevations.json — LOLA LDEM 118 m nearest pixel (MoonFall waypoints)', stats: controlStats, rows: controlRows },
  picking: { rays: pickRows.length, cpuVsFloat32Triangles: pickStats, clearanceM: 0.05 * 1000, raysWithFullClearance: fullClearance, lineOfSightErrorM: losStats,
    minHeightAboveCpuSampleM: clearanceMin, rows: pickRows },
  sourceStats: source.stats,
  failures,
  seconds: (performance.now() - t0) / 1000,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`wrote ${join(OUT, 'validation.json')} (${report.seconds.toFixed(1)} s)`);
if (failures.length) {
  console.error(`\n${failures.length} gate failure(s):\n  ${failures.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log('all gates passed');
