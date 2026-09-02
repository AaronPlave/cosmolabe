#!/usr/bin/env node
/**
 * Layer 4 — headless visual regression for the cosmolabe viewer.
 *
 * Drives the live viewer in headless Chromium (real shaders, software WebGL via
 * SwiftShader = deterministic across machines), seeks to a fixed epoch, applies
 * named catalog viewpoints, captures one synchronous frame each via the
 * `window.__cosmolabe` test hook (loader.ts, gated behind `?test=1`), and
 * pixel-diffs against committed golden PNGs. Catches render-only regressions the
 * numeric layers can't see — ring-plane tilt, triaxial-ellipsoid (oblateness)
 * scaling, texture/material orientation.
 *
 * Usage:
 *   npm --prefix apps/viewer run build           # once, so `vite preview` has a build
 *   npx playwright install chromium              # once, fetches the browser
 *   node scripts/visual-regression.mjs           # compare against goldens (fails on drift)
 *   UPDATE_VISUAL_GOLDENS=1 node scripts/visual-regression.mjs   # (re)write goldens
 *
 * Env:
 *   CL_VIEWER_URL   use an already-running server (e.g. http://localhost:4173) instead of spawning `vite preview`
 *   VR_THRESHOLD    pixelmatch per-pixel threshold (default 0.1)
 *   VR_MAX_DIFF     max fraction of differing pixels before failing (default 0.005 = 0.5%)
 *   VR_SETTLE_MS    wait after scene-ready before capture, for textures/tiles to stream (default 6000)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const GOLDEN_DIR = join(REPO, 'apps/viewer/test-screenshots/__goldens__');
const OUT_DIR = join(REPO, 'apps/viewer/test-screenshots');

const UPDATE = process.env.UPDATE_VISUAL_GOLDENS === '1';
const THRESHOLD = Number(process.env.VR_THRESHOLD ?? 0.1);
const MAX_DIFF_FRAC = Number(process.env.VR_MAX_DIFF ?? 0.005);
const SETTLE_MS = Number(process.env.VR_SETTLE_MS ?? 6000);
const VIEWPORT = { width: 1024, height: 768 };

/**
 * Scenes to capture. `catalog` is the viewer demo name (test-catalogs/<name>.json),
 * `viewpoints` are catalog-defined viewpoint names chosen to expose fragile
 * geometry. Ring Plane View is the marquee ring-tilt guard; the oblate Saturn
 * disk in SOI guards triaxial-ellipsoid scaling.
 */
const SCENES = [
  { catalog: 'cassini-soi', viewpoints: ['SOI (2004-07-01)', 'Ring Plane View'] },
  { catalog: 'earth-moon', viewpoints: [] }, // [] ⇒ default viewpoint
  // The OEM ingest demo. Worth a scene of its own for a reason the numeric
  // layers can't cover: the OEM body's file is fetched by the *viewer's*
  // pre-fetch pass (collectDataRefs) because CatalogLoader's resolveFile is
  // synchronous, and that pass only runs in the browser. If it ever stops
  // recognizing the OEM trajectory type, the body silently degrades to a fixed
  // point at Saturn's centre — a scene that still loads and looks nearly right.
  // Here that shows up as the cyan arc vanishing.
  { catalog: 'oem-ingest', viewpoints: [] },
];

async function loadPlaywright() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    console.error(
      '\n[visual-regression] Playwright not installed. Run:\n' +
        '  npm --prefix apps/viewer i -D playwright pixelmatch pngjs\n' +
        '  npx playwright install chromium\n',
    );
    process.exit(2);
  }
}

async function loadDiffers() {
  const pixelmatch = (await import('pixelmatch')).default;
  const { PNG } = await import('pngjs');
  return { pixelmatch, PNG };
}

function startPreview() {
  // `vite preview` serves the production build on a fixed port.
  const port = 4173;
  const child = spawn('npm', ['--prefix', 'apps/viewer', 'run', 'preview', '--', '--port', String(port), '--strictPort'], {
    cwd: REPO,
    stdio: 'pipe',
  });
  return { child, url: `http://localhost:${port}` };
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`viewer server did not come up at ${url}`);
}

function dataUrlToPng(PNG, dataUrl) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return PNG.sync.read(Buffer.from(b64, 'base64'));
}

async function main() {
  const chromium = await loadPlaywright();
  const { pixelmatch, PNG } = await loadDiffers();

  mkdirSync(GOLDEN_DIR, { recursive: true });

  let server = null;
  let baseUrl = process.env.CL_VIEWER_URL;
  if (!baseUrl) {
    server = startPreview();
    baseUrl = server.url;
    await waitForServer(baseUrl);
  }

  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'] });
  const failures = [];
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });

    for (const scene of SCENES) {
      console.log(`\n[scene] ${scene.catalog}`);
      await page.goto(`${baseUrl}/?catalog=${encodeURIComponent(scene.catalog)}&test=1`, { waitUntil: 'load' });
      // Wait for the capture hook + scene init, then a settle window for
      // async textures / terrain tiles to stream in.
      await page.waitForFunction(() => window.__cosmolabe?.ready === true, { timeout: 120000 });
      await page.waitForTimeout(SETTLE_MS);

      const viewpoints = scene.viewpoints.length ? scene.viewpoints : [null];
      for (const vp of viewpoints) {
        const label = `${scene.catalog}${vp ? `--${vp}` : ''}`.replace(/[^\w.-]+/g, '_');
        const dataUrl = await page.evaluate((name) => window.__cosmolabe.capture(name ?? undefined), vp);
        const actual = dataUrlToPng(PNG, dataUrl);
        const goldenPath = join(GOLDEN_DIR, `${label}.png`);

        if (UPDATE || !existsSync(goldenPath)) {
          writeFileSync(goldenPath, PNG.sync.write(actual));
          console.log(`  ${UPDATE ? 'wrote' : 'created'} golden ${label}.png`);
          continue;
        }

        const golden = PNG.sync.read(readFileSync(goldenPath));
        if (golden.width !== actual.width || golden.height !== actual.height) {
          failures.push(`${label}: size ${actual.width}x${actual.height} != golden ${golden.width}x${golden.height}`);
          continue;
        }
        const diff = new PNG({ width: golden.width, height: golden.height });
        const nDiff = pixelmatch(golden.data, actual.data, diff.data, golden.width, golden.height, { threshold: THRESHOLD });
        const frac = nDiff / (golden.width * golden.height);
        if (frac > MAX_DIFF_FRAC) {
          writeFileSync(join(OUT_DIR, `${label}-actual.png`), PNG.sync.write(actual));
          writeFileSync(join(OUT_DIR, `${label}-diff.png`), PNG.sync.write(diff));
          failures.push(`${label}: ${(frac * 100).toFixed(3)}% pixels differ (> ${(MAX_DIFF_FRAC * 100).toFixed(2)}%) — see ${label}-diff.png`);
        } else {
          console.log(`  ok ${label} (${(frac * 100).toFixed(3)}% diff)`);
        }
      }
    }
  } finally {
    await browser.close();
    server?.child.kill();
  }

  if (failures.length) {
    console.error('\n[visual-regression] FAILED:\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
  }
  console.log(`\n[visual-regression] ${UPDATE ? 'goldens updated' : 'all scenes match'}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
