#!/usr/bin/env node
/**
 * Log depth precision on a real GPU (#189). No viewer, kernels or data.
 *   npm run build && node scripts/log-depth-gpu.mjs [--gpu] [--angle metal|vulkan|d3d11|gl]
 * Default is SwiftShader (correctness only); --gpu uses the host GPU through ANGLE
 * and is the only mode whose timings mean anything.
 *
 * Occlusion: a red quad at distance d, then a green quad `gap` behind it, at the
 * renderer's scale (1e-6 scene units per km, far 1e6), into 16-bit, 24-bit and
 * 32-bit float depth attachments. Green at the centre means the farther quad won
 * a depth test it should lose. Variants: three's log depth, the patch, and the
 * patch's first version (per-fragment exp2/log2 of the far plane).
 * Cost: 64 full-screen quads 1–2 km away drawn back to front (every fragment
 * passes and writes depth) at 2048², GPU time per frame from timer queries.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const GPU = args.includes('--gpu');
const ANGLE = !GPU ? 'swiftshader' : args.includes('--angle') ? args[args.indexOf('--angle') + 1] : platform() === 'darwin' ? 'metal' : 'vulkan';
const launch = GPU ? ['--use-angle=' + ANGLE, '--ignore-gpu-blocklist', '--enable-gpu']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: launch });

const CASES = [ // [front km, gap km]
  [1, 0.1], [1, 0.001], [10, 0.01], [100, 0.1], [384_400, 10],
];

async function run(variant) {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && !/GL Driver Message/.test(m.text()))) errors.push(m.text()); });
  await page.route('http://depth.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="importmap">{"imports":{"three":"/three.module.js"}}</script>' });
    const local = path.startsWith('/three.') ? `../node_modules/three/build${path}` : `../packages/three/dist${path}`;
    return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL(local, import.meta.url), 'utf8') });
  });
  await page.goto('http://depth.test/');
  const result = await page.evaluate(async ({ variant, CASES }) => {
    const THREE = await import('three');
    if (variant === 'patch') {
      const { patchLogDepthPrecision } = await import('/LogDepth.js');
      if (!patchLogDepthPrecision()) throw new Error('patch not applied');
    } else if (variant === 'patch-v1') {
      THREE.ShaderChunk.logdepthbuf_vertex = THREE.ShaderChunk.logdepthbuf_vertex.replace('vFragDepth = 1.0 + gl_Position.w;', 'vFragDepth = 1.0 + 1e9 * gl_Position.w;');
      THREE.ShaderChunk.logdepthbuf_fragment = THREE.ShaderChunk.logdepthbuf_fragment.replace('log2( vFragDepth ) * logDepthBufFC * 0.5',
        'log2( vFragDepth ) / log2( 1.0 + 1e9 * ( exp2( 2.0 / logDepthBufFC ) - 1.0 ) )');
    }
    const renderer = new THREE.WebGLRenderer({ logarithmicDepthBuffer: true });
    renderer.setSize(256, 256);
    renderer.sortObjects = false; // draw in insertion order: front first, then the one behind
    const gl = renderer.getContext();
    const KM = 1e-6;
    const camera = new THREE.PerspectiveCamera(60, 1, 1e-14, 1e6);
    camera.updateMatrixWorld();
    const quad = (color, dKm) => {
      const s = 3 * dKm * KM; // wider than the view at that distance
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ color }));
      m.position.z = -dKm * KM;
      return m;
    };
    const formats = { 16: THREE.UnsignedShortType, 24: THREE.UnsignedIntType, '32F': THREE.FloatType };
    const occlusion = {};
    for (const [name, type] of Object.entries(formats)) {
      const target = new THREE.WebGLRenderTarget(64, 64, { depthBuffer: true, depthTexture: new THREE.DepthTexture(64, 64, type) });
      occlusion[name] = CASES.map(([d, gap]) => {
        const scene = new THREE.Scene();
        scene.add(quad(0xff0000, d), quad(0x00ff00, d + gap));
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        renderer.render(scene, camera);
        const px = new Uint8Array(4);
        renderer.readRenderTargetPixels(target, 32, 32, 1, 1, px);
        return { frontKm: d, gapKm: gap, nearerWins: px[0] > 127 && px[1] < 128, pixel: [...px.slice(0, 3)] };
      });
      target.dispose();
    }
    // Fragment cost: back to front, so every layer passes the depth test and writes.
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    let cost = null;
    if (ext) {
      const big = new THREE.WebGLRenderTarget(2048, 2048, { depthBuffer: true, depthTexture: new THREE.DepthTexture(2048, 2048, THREE.UnsignedIntType) });
      const scene = new THREE.Scene();
      for (let i = 63; i >= 0; i--) scene.add(quad(new THREE.Color().setHSL(i / 64, 0.5, 0.5), 1 + i / 64));
      renderer.setRenderTarget(big);
      const px = new Uint8Array(4);
      for (let i = 0; i < 10; i++) { renderer.clear(); renderer.render(scene, camera); }
      renderer.readRenderTargetPixels(big, 0, 0, 1, 1, px);
      const queries = [];
      gl.getParameter(ext.GPU_DISJOINT_EXT);
      for (let i = 0; i < 60; i++) {
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        renderer.clear(); renderer.render(scene, camera);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        renderer.readRenderTargetPixels(big, 0, 0, 1, 1, px);
        queries.push(q);
      }
      const ms = [];
      for (let tries = 0; tries < 200 && queries.length; tries++) {
        await new Promise(r => setTimeout(r, 10));
        while (queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
          ms.push(gl.getQueryParameter(queries[0], gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(queries.shift());
        }
      }
      ms.sort((a, b) => a - b);
      cost = { frames: ms.length, disjoint: !!gl.getParameter(ext.GPU_DISJOINT_EXT), medianMs: ms[ms.length >> 1], p10Ms: ms[Math.floor(ms.length * 0.1)], p90Ms: ms[Math.floor(ms.length * 0.9)],
        fragmentsPerFrame: 64 * 2048 * 2048 };
      big.dispose();
    }
    renderer.setRenderTarget(null);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return { variant, defaultFramebufferDepthBits: gl.getParameter(gl.DEPTH_BITS), renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      fragmentChunk: THREE.ShaderChunk.logdepthbuf_fragment.trim().split('\n').find(l => l.includes('gl_FragDepth')).trim(), occlusion, cost };
  }, { variant, CASES });
  await page.close();
  return { ...result, errors };
}

try {
  const results = {};
  // Interleaved twice, so the timing spread shows run-to-run noise.
  for (const _round of [0, 1]) for (const v of ['three', 'patch', 'patch-v1']) (results[v] ??= []).push(await run(v));
  const r0 = results.three[0];
  console.log(`${r0.renderer} (ANGLE ${ANGLE}); default framebuffer depth bits: ${r0.defaultFramebufferDepthBits}`);
  for (const v of Object.keys(results)) {
    const [a] = results[v];
    console.log(`\n${v}: ${a.fragmentChunk}`);
    for (const fmt of Object.keys(a.occlusion)) {
      console.log(`  ${fmt.padStart(3)}-bit  ` + a.occlusion[fmt].map(c => `${c.frontKm} km +${c.gapKm * 1000} m ${c.nearerWins ? 'ok' : 'FAIL'}`).join(' | '));
    }
    console.log('  cost: ' + results[v].map(x => x.cost ? `${x.cost.medianMs.toFixed(3)} ms median (p10 ${x.cost.p10Ms.toFixed(3)}, p90 ${x.cost.p90Ms.toFixed(3)}, ${x.cost.frames} frames)` : 'no timer queries').join('; '));
    for (const x of results[v]) assert.deepEqual(x.errors, [], `${v}: browser errors`);
  }
  const ok = (v, fmt) => results[v][0].occlusion[fmt].every(c => c.nearerWins);
  // The bug: `1.0 + w` in float32 steps ~120 m near the ground, whatever the attachment, so
  // three's log depth loses some sub-step gap (which one depends on where the ulps fall).
  for (const fmt of ['16', '24', '32F']) assert.ok(results.three[0].occlusion[fmt].some(c => !c.nearerWins), `three log depth resolved every case (${fmt}-bit)`);
  // The fix: every case, in 24-bit and 32-bit float depth. 16-bit is reported, not asserted.
  for (const fmt of ['24', '32F']) assert.ok(ok('patch', fmt), `patch failed a case in ${fmt}-bit depth`);
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
