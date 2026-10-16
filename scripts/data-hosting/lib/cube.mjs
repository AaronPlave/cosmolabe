// Cube-sphere terrain (3D Tiles .glb + CPU height grids) and cube-face imagery
// products for the publisher (#149). Validation runs before anything uploads;
// the manifests record the product revision the viewer checks at runtime.
import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const MAGIC = { glb: [0x67, 0x6c, 0x54, 0x46], png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] };
export const hasMagic = (bytes, kind) => MAGIC[kind].every((b, i) => bytes[i] === b);
const isRelative = (u) => typeof u === 'string' && !/^[a-z]+:|^\//i.test(u) && !u.split('/').includes('..');
const fill = (template, [face, level, x, y]) => template.replace('{face}', face).replace('{level}', level).replace('{x}', x).replace('{y}', y);

function head(path, n = 4) {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(n); readSync(fd, b, 0, n, 0); return b; } finally { closeSync(fd); }
}

function readJson(entries, srcDir, path, what) {
  if (!entries.some((e) => e.path === path)) throw new Error(`${what} source has no ${path}`);
  return JSON.parse(readFileSync(join(srcDir, path), 'utf8'));
}

/** Shallowest, a middle and the deepest path of `paths` (`<face>/<level>/…` somewhere in each). */
function spread(paths) {
  const level = (p) => Number(/(?:^|\/)(?:px|nx|py|ny|pz|nz)\/(\d+)\//.exec(p)?.[1] ?? 0);
  const s = [...paths].sort((a, b) => level(a) - level(b) || (a < b ? -1 : 1));
  return [...new Set([s[0], s[Math.floor(s.length / 2)], s.at(-1)])].filter(Boolean);
}

function contentUris(tileset) {
  const uris = [];
  const walk = (n) => { if (n.content?.uri) uris.push(n.content.uri); for (const c of n.children ?? []) walk(c); };
  walk(tileset.root);
  return uris;
}

/**
 * A cube-sphere terrain build: tileset.json, every .glb it references, cpu-grids.json
 * and every height grid it lists, all one product revision (tileset
 * `asset.tilesetVersion` = grids `source.version` = terrain-product `source.version`).
 */
export function validateCubeTerrain(entries, srcDir) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const tileset = readJson(entries, srcDir, 'tileset.json', 'cube terrain');
  const grids = readJson(entries, srcDir, 'cpu-grids.json', 'cube terrain');
  const product = readJson(entries, srcDir, 'terrain-product.json', 'cube terrain');
  if (grids.format !== 'cosmolabe-cube-height-grid-1') throw new Error(`cpu-grids.json format is ${JSON.stringify(grids.format)}`);
  const revision = grids.source?.version;
  if (!revision || tileset.asset?.tilesetVersion !== revision || product.source?.version !== revision) {
    throw new Error(`product revision mismatch: tileset ${tileset.asset?.tilesetVersion}, cpu-grids ${revision}, terrain-product ${product.source?.version}; geometry and CPU grids must come from one build`);
  }
  const uris = contentUris(tileset);
  const bad = uris.find((u) => !isRelative(u));
  if (bad) throw new Error(`tileset content uri ${bad} must be relative so the build is relocatable`);
  const missing = uris.find((u) => !byPath.has(u));
  if (missing) throw new Error(`tileset references ${missing}, which is not in the build`);
  if (!isRelative(grids.grid?.uri)) throw new Error('cpu-grids.json grid uri must be a relative template');
  const gridBytes = grids.grid.width * grids.grid.height * 4;
  for (const t of grids.tiles) {
    const p = fill(grids.grid.uri, t);
    if (byPath.get(p)?.size !== gridBytes) throw new Error(`height grid ${p} is ${byPath.has(p) ? `${byPath.get(p).size} bytes, expected ${gridBytes}` : 'missing'}`);
  }
  if (uris.length !== grids.tiles.length) throw new Error(`${uris.length} geometry tiles but ${grids.tiles.length} CPU grids`);
  for (const p of spread(uris)) if (!hasMagic(head(join(srcDir, p)), 'glb')) throw new Error(`${p} is not a binary glTF`);
}

export function cubeTerrainManifest({ dataset, build, entries, inventorySha256, srcDir, gitCommit, now = new Date() }) {
  const grids = JSON.parse(readFileSync(join(srcDir, 'cpu-grids.json'), 'utf8'));
  const product = JSON.parse(readFileSync(join(srcDir, 'terrain-product.json'), 'utf8'));
  const glbs = contentUris(JSON.parse(readFileSync(join(srcDir, 'tileset.json'), 'utf8')));
  const samples = spread(glbs);
  return {
    version: 1,
    kind: 'cube-terrain',
    name: dataset.name,
    build,
    revision: grids.source.version,
    createdAt: now.toISOString(),
    publisher: { tool: 'scripts/publish-data.mjs', gitCommit },
    fileCount: entries.length,
    tileCount: glbs.length,
    totalBytes: entries.reduce((s, e) => s + e.size, 0),
    gridBytes: grids.grid.width * grids.grid.height * 4,
    inventory: { key: 'inventory.jsonl.gz', sha256: inventorySha256, entries: entries.length },
    // A .glb and the CPU grid of the same tile, at three depths.
    sampleTiles: samples,
    sampleGrids: samples.map((p) => fill(grids.grid.uri, p.replace(/\.glb$/, '').split('/'))),
    product: { generator: product.generator, created: product.created, source: product.source, datum: product.datum,
      levels: { global: product.tiling?.globalLevel, max: product.tiling?.maxLevel }, mesh: product.mesh?.simplification },
  };
}

/** A cube-face imagery pyramid: imagery.json and every tile it lists, in its declared encoding. */
export function validateCubeImagery(entries, srcDir) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const m = readJson(entries, srcDir, 'imagery.json', 'cube imagery');
  if (m.format !== 'cosmolabe-cube-imagery-1') throw new Error(`imagery.json format is ${JSON.stringify(m.format)}`);
  if (!m.source?.version) throw new Error('imagery.json has no source.version');
  if (!isRelative(m.uri)) throw new Error('imagery.json uri must be a relative template');
  if (!MAGIC[m.encoding]) throw new Error(`unsupported imagery encoding ${m.encoding}`);
  const paths = m.tiles.map((id) => fill(m.uri, id.split('/')));
  const missing = paths.find((p) => !byPath.has(p));
  if (missing) throw new Error(`imagery.json lists ${missing}, which is not in the build`);
  for (const p of spread(paths)) if (!hasMagic(head(join(srcDir, p)), m.encoding)) throw new Error(`${p} is not ${m.encoding}`);
}

export function cubeImageryManifest({ dataset, build, entries, inventorySha256, srcDir, gitCommit, now = new Date() }) {
  const m = JSON.parse(readFileSync(join(srcDir, 'imagery.json'), 'utf8'));
  return {
    version: 1,
    kind: 'cube-imagery',
    name: dataset.name,
    build,
    revision: m.source.version,
    createdAt: now.toISOString(),
    publisher: { tool: 'scripts/publish-data.mjs', gitCommit },
    fileCount: entries.length,
    tileCount: m.tiles.length,
    totalBytes: entries.reduce((s, e) => s + e.size, 0),
    encoding: m.encoding,
    inventory: { key: 'inventory.jsonl.gz', sha256: inventorySha256, entries: entries.length },
    sampleTiles: spread(m.tiles.map((id) => fill(m.uri, id.split('/')))),
    source: m.source,
  };
}
