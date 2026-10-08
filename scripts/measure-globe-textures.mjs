#!/usr/bin/env node
/**
 * Measure load cost of demo globe textures the way BodyMesh loads them (#122).
 *
 *   node scripts/measure-globe-textures.mjs [texture ...]   # names under apps/viewer/test-catalogs/textures
 *   SAMPLES=5 node scripts/measure-globe-textures.mjs ...     # samples per texture (default 3)
 *
 * Each sample runs in a fresh headless Chromium process, so allocator and
 * cache state from earlier textures can't leak into it; the table shows the
 * median of the samples. Per sample:
 *   - load: fetch+decode. JPG/PNG through THREE.TextureLoader (an
 *     HTMLImageElement, as BodyMesh.loadTexture does); DDS by fetch +
 *     DDSLoader.parse.
 *   - initTexture: the synchronous renderer.initTexture(tex) call alone, i.e.
 *     the main-thread time BodyMesh.loadGlobeTextures spends uploading each
 *     map eagerly. Chromium decodes an HTMLImageElement lazily, so most of a
 *     JPG's decode lands here, not in load.
 *   - GPU finish: a following gl.finish(), i.e. how long until the GPU (here
 *     SwiftShader) has actually consumed the upload. The app does not wait
 *     for this; it is reported separately so it isn't mistaken for a stall.
 *   - GPU bytes: computed from format and dimensions (RGBA8 + full mip chain
 *     for images; the DDS payload for compressed textures).
 *   - RSS delta: growth of that browser's processes across load + upload.
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
  'ceres.jpg', 'earth-5k.jpg', 'moon-4k.jpg', 'mars.dds', 'jupiter.jpg', 'saturn.jpg',
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
  const t2 = performance.now();
  gl.finish();
  const t3 = performance.now();
  return { loadMs: t1 - t0, initMs: t2 - t1, finishMs: t3 - t2, w: tex.image.width, h: tex.image.height };
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
const SAMPLES = Number(process.env.SAMPLES ?? 3);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

let maxTex;
async function sample(name) {
  // CHROMIUM_PATH overrides Playwright's bundled build (e.g. a preinstalled Chromium).
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'],
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.goto(base + '/');
    await page.waitForFunction(() => window.ready);
    maxTex ??= await page.evaluate(() => window.maxTextureSize);
    const before = chromiumRssMiB();
    const r = await page.evaluate((u) => window.measure(u), `/${TEXTURES}/${name}`);
    return { ...r, rss: chromiumRssMiB() - before };
  } finally {
    await browser.close();
  }
}

console.log(`median of ${SAMPLES} samples, each in a fresh browser`);
console.log('| texture | dims | file MiB | GPU MiB | load ms | initTexture ms | GPU finish ms | RSS Δ MiB |');
console.log('|---|---|--:|--:|--:|--:|--:|--:|');
for (const name of names) {
  const bytes = (await stat(join(ROOT, TEXTURES, name))).size;
  const runs = [];
  for (let i = 0; i < SAMPLES; i++) runs.push(await sample(name));
  const m = (k) => median(runs.map((r) => r[k])).toFixed(0);
  const { w, h } = runs[0];
  // RGBA8 + mips for images; DDS payload (minus the 128-byte header) for DXT.
  const gpu = name.endsWith('.dds') ? bytes - 128 : (w * h * 4 * 4) / 3;
  console.log(`| ${name} | ${w}×${h} | ${MiB(bytes)} | ${MiB(gpu)} | ${m('loadMs')} | ${m('initMs')} | ${m('finishMs')} | ${m('rss')} |`);
}
console.log(`\nmaxTextureSize (SwiftShader): ${maxTex}`);
server.close();
