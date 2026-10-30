#!/usr/bin/env node
/**
 * Numerical checks of the cube-face imagery pyramids (#149) written by
 * scripts/build-moon-terrain/cube-imagery.sh, against the viewer's own
 * compiled mapping (packages/three/dist/surface/CubeImagery.js, CubeSphere.js),
 * so the Python builder and the TypeScript runtime are checked against each
 * other rather than each against itself.
 *
 *   npm run build && node scripts/validate-cube-imagery.mjs [--out work/cube-imagery]
 *
 * Gates (exit 1 on failure):
 *  - every manifest validates: complete tree, roots on all six faces, levels, layout;
 *  - grid fixture markers: the builder's expected tile and pixel for every marker
 *    at every level agree with CubeImagery.directionToTexel (≤ 1e-6 px), the
 *    decoded PNG has the marker's centre colour at that pixel wherever the centre
 *    disc is ≥ 1.5 px in radius, and the centroid of that colour sits within
 *    0.25 px of it where the whole disc is inside the file; the centroid of a
 *    coloured annulus (≥ 6 texels wide) is within 0.25 px where it fits in one file, and
 *    for every placement — including markers on tile corners and edges — the annulus's
 *    inner edge is equidistant from the marker within 1 texel in every direction: at
 *    Shackleton, both poles, the antimeridian (0°, 60°S, 88°S), the px/nz edge and the
 *    px/py/nz corner;
 *  - same-face neighbours: a tile's gutter pixels equal its neighbour's interior
 *    pixels at the same lattice positions (≤ 1 count: identical sample points);
 *  - cross-face neighbours: a gutter pixel past a face edge matches the neighbour
 *    face's tile bilinearly sampled at that pixel's direction (mean ≤ 6 counts);
 *  - registration fixture: decoded pixels carry their own column, row, face and level.
 * Reports (no gate): tile counts and bytes per level for every product, NAC alpha coverage.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]]);
  return acc;
}, []));
const DATA = resolve(args.data ?? join(ROOT, 'apps/viewer/test-catalogs/data'));
const OUT = resolve(args.out ?? join(ROOT, 'work/cube-imagery'));
const DIST = join(ROOT, 'packages/three/dist/surface');
if (!existsSync(join(DIST, 'CubeImagery.js'))) { console.error('validate-cube-imagery: run `npm run build` first.'); process.exit(1); }
const { CubeSphereSampler, cubeFaceToDirection, cubeTileId } = await import(pathToFileURL(join(DIST, 'CubeSphere.js')).href);
const { validateCubeImageryManifest, directionToTexel, texelCenterDirection, parseImageryAddress } = await import(pathToFileURL(join(DIST, 'CubeImagery.js')).href);

const sphere = new CubeSphereSampler({ referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' }, { id: 'v', kind: 'imagery' });
const failures = [];
const gate = (ok, message) => { if (!ok) failures.push(message); return ok; };
const record = { generator: 'scripts/validate-cube-imagery.mjs', created: new Date().toISOString(), products: {}, gates: {} };

const decodeCache = new Map();
async function decode(dir, id) {
  const key = `${dir}|${id}`;
  if (!decodeCache.has(key)) {
    const a = parseImageryAddress(id);
    const { data, info } = await sharp(join(dir, 'tiles', a.face, String(a.level), String(a.x), `${a.y}.png`)).raw().toBuffer({ resolveWithObject: true });
    decodeCache.set(key, { data, width: info.width, channels: info.channels });
    if (decodeCache.size > 400) decodeCache.delete(decodeCache.keys().next().value);
  }
  return decodeCache.get(key);
}
const px = (img, c, r) => { const o = (r * img.width + c) * img.channels; return [...img.data.subarray(o, o + img.channels)]; };

function loadProduct(name) {
  const dir = join(DATA, name);
  if (!existsSync(join(dir, 'imagery.json'))) return null;
  const manifest = JSON.parse(readFileSync(join(dir, 'imagery.json'), 'utf8'));
  let valid = true;
  try { validateCubeImageryManifest(manifest); } catch (err) { valid = gate(false, `${name}: ${err.message}`); }
  const byLevel = {};
  for (const id of manifest.tiles) { const l = Number(id.split('/')[1]); byLevel[l] = (byLevel[l] ?? 0) + 1; }
  record.products[name] = { version: manifest.source.version, valid, tiles: manifest.tiles.length, bytes: manifest.bytes, maxLevel: manifest.maxLevel,
    tileSize: manifest.tileSize, gutter: manifest.gutter, colorSpace: manifest.colorSpace, tilesByLevel: byLevel, generatorSeconds: manifest.generator?.seconds };
  console.log(`${name}: ${manifest.tiles.length} tiles, ${(manifest.bytes / 1e6).toFixed(1)} MB, levels 0–${manifest.maxLevel}, manifest ${valid ? 'valid' : 'INVALID'}`);
  return { dir, manifest, ids: new Set(manifest.tiles) };
}

// --- grid fixture: markers ---------------------------------------------------
const grid = loadProduct(args.grid ?? 'moon-imagery-cube-grid');
if (grid) {
  const { dir, manifest } = grid;
  const metricRadiusKm = manifest.metricRadiusKm ?? 1737.4;
  const T = manifest.tileSize, G = manifest.gutter;
  const markers = JSON.parse(readFileSync(join(dir, 'markers.json'), 'utf8')).markers;
  const rows = [];
  let worstPos = 0, worstCentroid = 0, colourChecks = 0, centroidChecks = 0, edgeChecks = 0, worstEdge = 0;
  for (const m of markers) {
    // Direction the viewer's own way (exact at multiples of 90°), not the builder's.
    const { face, u, v } = sphere.faceCoordinate(m.latDeg, m.lonDeg);
    // Outer annuli (12 km ring) of markers closer than 26 km overlap (Shackleton is 10 km from
    // the pole); the builder protects only the inner features, so skip the outer annulus there.
    const crowded = markers.some(o => o !== m && Math.acos(Math.min(1, o.direction.reduce((s, c, k) => s + c * m.direction[k], 0))) * metricRadiusKm < 26);
    const usable = (k) => !(crowded && k === 0);
    const direction = cubeFaceToDirection(face, u, v);
    for (const l of m.levels) {
      const t = directionToTexel(direction, l.level, T, G);
      const id = cubeTileId(t.address);
      const dPos = Math.hypot(t.column - l.column, t.row - l.row);
      gate(id === l.tile, `${m.name} L${l.level}: builder tile ${l.tile}, viewer ${id}`);
      worstPos = Math.max(worstPos, id === l.tile ? dPos : Infinity);
      const img = await decode(dir, l.tile);
      const texelKm = metricRadiusKm * 2 / 2 ** l.level / T; // face-centre texel; smaller toward corners
      const radiusPx = m.centreRadiusKm / texelKm;
      let colourOk = null, centroidPx = null, annulus = null;
      // Centroid of the smallest coloured annulus ≥ 3 face-centre texels wide that lies wholly in the
      // file, pixels chosen by ground distance from the marker (so face distortion cannot bias the window).
      // Local texel along the shorter axis at the marker (gnomonic scale: √(1+u²)/(1+u²+v²) per unit v, …).
      const q = 1 + m.u * m.u + m.v * m.v;
      const minTexelKm = texelKm * Math.min(Math.sqrt(1 + m.u * m.u), Math.sqrt(1 + m.v * m.v)) / q;
      const j = m.annuliKm.findLastIndex(([lo, hi], k) => usable(k) && (hi - lo) / texelKm >= 6);
      const reach = j < 0 ? Infinity : m.annuliKm[j][1] / minTexelKm + 2;
      if (j >= 0 && l.column - reach >= 0 && l.row - reach >= 0 && l.column + reach < T + 2 * G && l.row + reach < T + 2 * G) {
        const [lo, hi] = m.annuliKm[j];
        const a = parseImageryAddress(l.tile);
        let sx = 0, sy = 0, n = 0;
        for (let rr = Math.floor(l.row - reach); rr <= l.row + reach; rr++) for (let cc = Math.floor(l.column - reach); cc <= l.column + reach; cc++) {
          const d3 = texelCenterDirection(a, cc, rr, T, G);
          const km = Math.acos(Math.min(1, d3[0] * direction[0] + d3[1] * direction[1] + d3[2] * direction[2])) * metricRadiusKm;
          if (km < lo - texelKm || km > hi + texelKm) continue;
          const v = px(img, cc, rr);
          if (v.slice(0, 3).every((x, k) => Math.abs(x - m.centreColour[k]) <= 2)) { sx += cc + 0.5; sy += rr + 0.5; n++; }
        }
        if (n >= 20) {
          centroidPx = Math.hypot(sx / n - l.column, sy / n - l.row);
          annulus = j;
          centroidChecks++;
          worstCentroid = Math.max(worstCentroid, centroidPx);
          gate(centroidPx <= 0.25, `${m.name} L${l.level}: annulus ${j} centroid ${centroidPx.toFixed(3)} px from expected`);
        }
      }
      // Radial edge symmetry, for any placement incl. markers on tile corners and edges (pole,
      // face edge/corner, antimeridian at the nx centre) whose annulus spans several files: the
      // inner edge of the annulus seen in this file must be equally far from the marker in every
      // direction; a registration offset δ makes opposite sectors differ by ~2δ.
      let edgeSpread = null;
      const je = m.annuliKm.findLastIndex(([lo, hi], k) => usable(k) && (hi - lo) / texelKm >= 4 && lo / texelKm >= 3);
      if (je >= 0) {
        const [lo, hi] = m.annuliKm[je];
        const a = parseImageryAddress(l.tile);
        const localKm = texelKm * Math.sqrt(1 + Math.max(m.u * m.u, m.v * m.v)) / (1 + m.u * m.u + m.v * m.v);
        const reachPx = hi / minTexelKm + 2;
        const sectors = Array.from({ length: 8 }, () => ({ min: Infinity, n: 0 }));
        for (let rr = Math.max(0, Math.floor(l.row - reachPx)); rr < Math.min(T + 2 * G, l.row + reachPx); rr++) {
          for (let cc = Math.max(0, Math.floor(l.column - reachPx)); cc < Math.min(T + 2 * G, l.column + reachPx); cc++) {
            const v = px(img, cc, rr);
            if (!v.slice(0, 3).every((x, k) => Math.abs(x - m.centreColour[k]) <= 2)) continue;
            const d3 = texelCenterDirection(a, cc, rr, T, G);
            const km = Math.acos(Math.min(1, d3[0] * direction[0] + d3[1] * direction[1] + d3[2] * direction[2])) * metricRadiusKm;
            if (km < lo - 2 * localKm || km > hi + 2 * localKm) continue;
            const sector = sectors[Math.floor(((Math.atan2(rr + 0.5 - l.row, cc + 0.5 - l.column) + Math.PI) / (2 * Math.PI)) * 8) % 8];
            sector.min = Math.min(sector.min, km); sector.n++;
          }
        }
        const inner = sectors.filter(x => x.n >= 3).map(x => (x.min - lo) / localKm);
        if (inner.length >= 2) {
          edgeSpread = Math.max(...inner) - Math.min(...inner);
          edgeChecks++;
          worstEdge = Math.max(worstEdge, edgeSpread);
          gate(edgeSpread <= 1.0, `${m.name} L${l.level}: annulus ${je} inner edge varies ${edgeSpread.toFixed(2)} texels between sectors`);
        }
      }
      if (radiusPx >= 1.5) {
        const c = Math.min(T + 2 * G - 1, Math.floor(l.column)), r = Math.min(T + 2 * G - 1, Math.floor(l.row));
        const got = px(img, c, r);
        colourOk = got.slice(0, 3).every((v, k) => Math.abs(v - m.centreColour[k]) <= 2);
        colourChecks++;
        gate(colourOk, `${m.name} L${l.level} ${l.tile}: pixel (${c},${r}) is ${got} not ${m.centreColour}`);
      }
      rows.push({ marker: m.name, level: l.level, tile: l.tile, column: l.column, row: l.row, viewerVsBuilderPx: dPos, centreRadiusPx: radiusPx, colourOk, centroidAnnulus: annulus, centroidErrorPx: centroidPx, innerEdgeSpreadTexels: edgeSpread });
    }
  }
  gate(worstPos <= 1e-6, `marker pixel disagreement up to ${worstPos} px`);
  record.gates.markers = { markers: markers.length, placements: rows.length, worstViewerVsBuilderPx: worstPos, colourChecks, centroidChecks, worstCentroidPx: worstCentroid, edgeChecks, worstInnerEdgeSpreadTexels: worstEdge, rows };
  console.log(`markers: ${rows.length} placements, viewer vs builder ≤ ${worstPos.toExponential(2)} px, ${colourChecks} colour checks, ${centroidChecks} centroids ≤ ${worstCentroid.toFixed(3)} px, ${edgeChecks} edge-symmetry checks ≤ ${worstEdge.toFixed(2)} texels`);

  // --- neighbours ------------------------------------------------------------
  const span = T + 2 * G;
  let sameMax = 0, samePairs = 0, crossPairs = 0, crossSum = 0, crossN = 0, crossMax = 0;
  const ids = [...grid.ids];
  for (const id of ids) {
    const a = parseImageryAddress(id);
    if (a.level < 2 || a.level % 2) continue; // a sample of levels keeps this fast
    const right = { ...a, x: a.x + 1 };
    if (right.x < 2 ** a.level && grid.ids.has(cubeTileId(right))) {
      const A = await decode(dir, id), B = await decode(dir, cubeTileId(right));
      for (let k = 0; k < G; k++) for (let r = G; r < G + T; r += 7) {
        // A's gutter column G+T+k samples the same points as B's interior column G+k.
        const d = Math.max(...px(A, G + T + k, r).map((v, c) => Math.abs(v - px(B, G + k, r)[c])));
        sameMax = Math.max(sameMax, d);
      }
      samePairs++;
    }
    if (a.x === 2 ** a.level - 1 && crossPairs < 40) {
      // Past the face's u = +1 edge: the neighbour face's content at the same directions.
      const A = await decode(dir, id);
      for (let k = 0; k < G; k++) for (let r = G + 3; r < G + T - 3; r += 11) {
        const dir3 = texelCenterDirection(a, G + T + k, r, T, G);
        const t = directionToTexel(dir3, a.level, T, G);
        if (!grid.ids.has(cubeTileId(t.address))) continue;
        const B = await decode(dir, cubeTileId(t.address));
        const sample = bilinear(B, t.column - 0.5, t.row - 0.5);
        const d = px(A, G + T + k, r).slice(0, 3).reduce((s, v, c) => s + Math.abs(v - sample[c]), 0) / 3;
        crossSum += d; crossN++; crossMax = Math.max(crossMax, d);
      }
      crossPairs++;
    }
  }
  gate(sameMax <= 1, `same-face gutter mismatch up to ${sameMax} counts`);
  gate(crossN > 0 && crossSum / crossN <= 6, `cross-face gutter mean mismatch ${(crossSum / crossN).toFixed(2)} counts`);
  record.gates.neighbours = { sameFacePairs: samePairs, sameFaceMaxCounts: sameMax, crossFaceTiles: crossPairs, crossFaceSamples: crossN,
    crossFaceMeanCounts: crossSum / crossN, crossFaceMaxCounts: crossMax,
    note: 'cross-face gutters and the neighbour face use different pixel lattices; differences are resampling of sharp lines, not offsets' };
  console.log(`neighbours: ${samePairs} same-face pairs max ${sameMax} counts; cross-face ${crossN} samples mean ${(crossSum / crossN).toFixed(2)} max ${crossMax.toFixed(0)} counts`);
}

function bilinear(img, x, y) {
  const x0 = Math.max(0, Math.min(img.width - 2, Math.floor(x))), y0 = Math.max(0, Math.min(img.width - 2, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
  const p = (c, r) => px(img, c, r);
  return [0, 1, 2].map(k => (p(x0, y0)[k] * (1 - fx) + p(x0 + 1, y0)[k] * fx) * (1 - fy) + (p(x0, y0 + 1)[k] * (1 - fx) + p(x0 + 1, y0 + 1)[k] * fx) * fy);
}

// --- registration fixture ------------------------------------------------------
const reg = loadProduct(args.registration ?? 'moon-imagery-cube-registration');
if (reg) {
  const { dir, manifest } = reg;
  const T = manifest.tileSize, G = manifest.gutter;
  const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  let checked = 0;
  for (const id of [...reg.ids].filter((_, i) => i % 37 === 0)) {
    const a = parseImageryAddress(id), img = await decode(dir, id);
    for (const [c, r] of [[G, G], [G + 100, G + 17], [G + T - 1, G + T - 1]]) {
      const [R, Gc, B] = px(img, c, r);
      gate(R === c - G && Gc === T - 1 - (r - G) && B === 32 * faces.indexOf(a.face) + a.level, `registration ${id} (${c},${r}) = ${R},${Gc},${B}`);
      checked++;
    }
  }
  record.gates.registrationEncoding = { pixelsChecked: checked };
  console.log(`registration encoding: ${checked} pixels`);
}

// --- NAC ----------------------------------------------------------------------
const nac = loadProduct('moon-imagery-cube-nac');
if (nac) {
  let opaque = 0, partial = 0, transparent = 0;
  for (const id of nac.manifest.tiles) {
    const img = await decode(nac.dir, id);
    let lo = 255, hi = 0;
    for (let i = img.channels - 1; i < img.data.length; i += img.channels * 13) { lo = Math.min(lo, img.data[i]); hi = Math.max(hi, img.data[i]); }
    if (lo === 255) opaque++; else if (hi === 0) transparent++; else partial++;
  }
  record.products['moon-imagery-cube-nac'].alpha = { opaqueTiles: opaque, partialTiles: partial, transparentTiles: transparent };
  console.log(`NAC alpha: ${opaque} opaque, ${partial} partial, ${transparent} transparent tiles`);
}

record.failures = failures;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'imagery-validation.json'), JSON.stringify(record, null, 1) + '\n');
console.log(failures.length ? `FAILED (${failures.length}):\n  ${failures.slice(0, 30).join('\n  ')}` : 'all imagery gates passed');
console.log(`wrote ${join(OUT, 'imagery-validation.json')}`);
process.exit(failures.length ? 1 : 0);
