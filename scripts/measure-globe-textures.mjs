#!/usr/bin/env node
/**
 * Measure load cost of demo globe textures the way BodyMesh loads them (#122).
 *
 *   node scripts/measure-globe-textures.mjs [texture ...]   # names under apps/viewer/test-catalogs/textures
 *
 * For each texture, in a fresh headless Chromium page:
 *   - fetch+decode: JPG/PNG through THREE.TextureLoader (an HTMLImageElement,
 *     as BodyMesh.loadTexture does); DDS by fetch + DDSLoader.parse.
 *   - upload: renderer.initTexture(tex) followed by gl.finish(), i.e. the
 *     main-thread block BodyMesh.loadGlobeTextures takes eagerly. For an
 *     HTMLImageElement Chromium decodes lazily, so most of the image decode
 *     lands here, not in the load step.
 *   - GPU bytes: computed from format and dimensions (RGBA8 + full mip chain
 *     for images; the DDS payload for compressed textures).
 *   - RSS delta: growth of all Chromium processes across load + upload.
 *
 * Chromium runs SwiftShader (software GL), as scripts/visual-regression.mjs
 * does, so absolute upload times are a CPU-bound upper bound rather than a
 * desktop-GPU figure; compare textures against each other, not against a
 * frame budget. Requires `git lfs pull` (DDS and 16k maps are LFS objects).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const TEXTURES = 'apps/viewer/test-catalogs/textures';
const DEFAULTS = [
  'ceres.jpg', 'earth-8k.jpg', 'moon-4k.jpg', 'mars.dds', 'jupiter.jpg', 'saturn.jpg',
  'pluto.jpg', 'charon.jpg', 'moon-normal-16k.jpg', 'moon-16k.jpg',
];
const names = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const body = path === '' ? PAGE : await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path) || '.html'] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const PAGE = `<!doctype html><script type="importmap">{"imports":{
  "three":"/node_modules/three/build/three.module.js",
  "three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
const renderer = new THREE.WebGLRenderer();
window.maxTextureSize = renderer.capabilities.maxTextureSize;
window.measure = async (url) => {
  const gl = renderer.getContext();
  const t0 = performance.now();
  let tex;
  if (url.endsWith('.dds')) {
    const d = new DDSLoader().parse(await (await fetch(url)).arrayBuffer(), false);
    tex = new THREE.CompressedTexture(d.mipmaps, d.width, d.height, d.format);
    tex.minFilter = d.mipmaps.length === 1 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
  } else {
    tex = await new THREE.TextureLoader().loadAsync(url);
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  const t1 = performance.now();
  renderer.initTexture(tex);
  gl.finish();
  const t2 = performance.now();
  return { loadMs: t1 - t0, uploadMs: t2 - t1, w: tex.image.width, h: tex.image.height };
};
window.ready = true;
</script>`;

/** Sum RSS (MiB) of every process below this one: Playwright's Chromium and
 *  its renderer/GPU children all descend from this Node process. */
function chromiumRssMiB() {
  const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  const rows = ps.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const tree = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; }
  }
  tree.delete(process.pid);
  return rows.filter(([pid]) => tree.has(pid)).reduce((s, [, , rss]) => s + rss, 0) / 1024;
}

const MiB = (b) => (b / 2 ** 20).toFixed(1);
// CHROMIUM_PATH overrides Playwright's bundled build (e.g. a preinstalled Chromium).
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'],
  executablePath: process.env.CHROMIUM_PATH || undefined,
});

console.log('| texture | dims | file MiB | GPU MiB | load ms | upload ms | RSS Δ MiB |');
console.log('|---|---|--:|--:|--:|--:|--:|');
let maxTex;
for (const name of names) {
  const file = join(ROOT, TEXTURES, name);
  const bytes = (await stat(file)).size;
  const page = await browser.newPage();
  await page.goto(base + '/');
  await page.waitForFunction(() => window.ready);
  maxTex ??= await page.evaluate(() => window.maxTextureSize);
  const before = chromiumRssMiB();
  const r = await page.evaluate((u) => window.measure(u), `/${TEXTURES}/${name}`);
  const after = chromiumRssMiB();
  await page.close();
  // RGBA8 + mips for images; DDS payload (minus the 128-byte header) for DXT.
  const gpu = name.endsWith('.dds') ? bytes - 128 : (r.w * r.h * 4 * 4) / 3;
  console.log(`| ${name} | ${r.w}×${r.h} | ${MiB(bytes)} | ${MiB(gpu)} | ${r.loadMs.toFixed(0)} | ${r.uploadMs.toFixed(0)} | ${(after - before).toFixed(0)} |`);
}
console.log(`\nmaxTextureSize (SwiftShader): ${maxTex}`);
await browser.close();
server.close();
