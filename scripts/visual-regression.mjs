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
 * NOT run in CI (`.github/workflows/ci.yml`), deliberately: it needs a browser,
 * a full package + viewer build, and the scenes' LFS-backed SPICE kernels. So
 * this gate has exactly the authority of whoever last ran it by hand. If that
 * changes, delete this paragraph.
 *
 * Usage:
 *   npx playwright install chromium              # once, fetches the browser
 *   node scripts/visual-regression.mjs           # builds, then compares (fails on drift)
 *
 * The build is part of the run. A production viewer build resolves
 * `@cosmolabe/*` to each package's `dist/` (the `exports` map only points at
 * `src` under the `development` condition), so a stale `packages/<pkg>/dist` makes
 * this gate quietly photograph library code that is not the code under test —
 * which is how the two cassini-soi goldens came to encode a frame no version of
 * this codebase produces. `vitest` does not share the hazard; it resolves `src`.
 *
 * Env:
 *   CL_VIEWER_URL             use an already-running server instead of building + spawning `vite preview`
 *   VR_SKIP_BUILD=1           trust the existing build (fast iteration only — see above)
 *   UPDATE_VISUAL_GOLDENS=1   rewrite goldens that already exist
 *   CREATE_VISUAL_GOLDENS=1   write goldens that do not exist yet (separate flag on purpose:
 *                             a renamed scene or viewpoint must not self-baseline)
 *   VR_THRESHOLD              pixelmatch per-pixel threshold (default 0.1)
 *   VR_MAX_DIFF               max fraction of differing pixels before failing (default 0.005 = 0.5%)
 *   VR_SETTLE_MS              wait after scene-ready before capture, for textures/tiles to stream (default 6000)
 *   VR_INK_LEVEL              luminance above which a pixel counts as drawn, 0-255 (default 24)
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const VIEWER = join(REPO, 'apps/viewer');
const GOLDEN_DIR = join(VIEWER, 'test-screenshots/__goldens__');
const OUT_DIR = join(VIEWER, 'test-screenshots');
const DIST_HTML = join(VIEWER, 'dist/index.html');

const UPDATE = process.env.UPDATE_VISUAL_GOLDENS === '1';
const CREATE = process.env.CREATE_VISUAL_GOLDENS === '1';
const THRESHOLD = Number(process.env.VR_THRESHOLD ?? 0.1);
const MAX_DIFF_FRAC = Number(process.env.VR_MAX_DIFF ?? 0.005);
const SETTLE_MS = Number(process.env.VR_SETTLE_MS ?? 6000);
const INK_LEVEL = Number(process.env.VR_INK_LEVEL ?? 24);
const VIEWPORT = { width: 1024, height: 768 };
const PORT = 4173;

/**
 * Scenes to capture. `catalog` is the viewer demo name (test-catalogs/<name>.json),
 * `viewpoints` are catalog-defined viewpoint names chosen to expose fragile
 * geometry. Ring Plane View is the marquee ring-tilt guard; the oblate Saturn
 * disk in SOI guards triaxial-ellipsoid scaling.
 */
const SCENES = [
  { catalog: 'cassini-soi', viewpoints: ['SOI (2004-07-01)', 'Ring Plane View'] },
  // Earth + Moon is the SPICE-free scene: both bodies are Keplerian and no
  // kernel is furnished, so it is the visual counterpart to core's
  // `analytical-no-spice` fingerprint. Its `defaultTime` is deliberately far
  // from the elements' own J2000 epoch, because at epoch == J2000 the
  // propagation is the identity and the scene could not see an epoch bug at
  // all; 24 years out, the lit hemisphere and the terminator both depend on
  // where the epoch math puts Earth.
  //
  // Only the close view is captured. The catalog's wide 'Lunar Orbit'
  // viewpoint gets both bodies in frame, which is what the scene's name
  // promises, but measured it draws 0.34% ink against a 0.50% budget — less
  // than the budget, so no change to it could ever fail. That is the same
  // defect the scene's original golden had (0.14% ink, 99.86% black), and
  // adding a second powerless capture would not fix it.
  { catalog: 'earth-moon', viewpoints: ['Earth Close'] },
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

/** Run a command to completion, failing the whole gate if it does. */
function run(label, cmd, args, env) {
  console.log(`[visual-regression] ${label}: ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit', env: { ...process.env, ...env } });
  if (res.status !== 0) {
    console.error(`\n[visual-regression] ${label} failed (exit ${res.status}). Nothing was compared.`);
    process.exit(2);
  }
}

/**
 * Build the packages and then the viewer.
 *
 * Both halves matter. `apps/viewer`'s `build` is only `vite build`, and a
 * production build reads `@cosmolabe/*` from each package's `dist/` — so
 * skipping the `tsc --build` leaves the bundle carrying whatever those `dist`
 * directories last happened to hold. The viewer is built with `VITE_BASE`
 * cleared so the emitted asset paths are root-relative and match the
 * `vite preview` this script spawns; a Pages build (`VITE_BASE=/cosmolabe/`)
 * hard-codes `/cosmolabe/assets/...`, which preview answers with the SPA
 * fallback `index.html` — a 200 with `Content-Type: text/html` where the
 * browser wanted a module script, so the app never boots at all.
 */
function buildEverything() {
  run('build packages', 'npm', ['run', 'build'], {});
  run('build viewer', 'npm', ['--prefix', 'apps/viewer', 'run', 'build'], { VITE_BASE: '' });
}

/**
 * The base path `dist/index.html` was built for, read back off its own asset
 * URLs. `vite preview` computes its base from `VITE_BASE` independently of
 * whatever the committed build used, so the two can disagree silently; passing
 * this back in as `VITE_BASE` keeps them consistent no matter who built `dist`.
 */
function distBase() {
  if (!existsSync(DIST_HTML)) {
    console.error(
      `\n[visual-regression] No build at ${DIST_HTML}.\n` +
        '  Run without VR_SKIP_BUILD, or build by hand:\n' +
        '    npm run build && npm --prefix apps/viewer run build\n',
    );
    process.exit(2);
  }
  const html = readFileSync(DIST_HTML, 'utf8');
  const m = html.match(/(?:src|href)="([^"]*?)assets\//);
  const prefix = m?.[1] ?? '/';
  // A relative prefix ('./assets/…') is served fine from any base; treat it as root.
  return prefix.startsWith('/') ? prefix : '/';
}

function startPreview(base) {
  const child = spawn(
    'npm',
    ['--prefix', 'apps/viewer', 'run', 'preview', '--', '--port', String(PORT), '--strictPort'],
    // `vite preview` reads `base` from vite.config.ts, which reads VITE_BASE.
    // Hand it the base the build actually used.
    { cwd: REPO, stdio: 'pipe', env: { ...process.env, VITE_BASE: base } },
  );
  return { child, url: `http://localhost:${PORT}` };
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

/**
 * Fraction of the frame that is drawn on at all.
 *
 * These scenes are mostly empty space, and a fraction-of-frame diff budget says
 * nothing without knowing how much there was to differ. `earth-moon`'s original
 * golden was 99.86% black: 0.14% ink against a 0.5% budget, so no change to it
 * could ever have exceeded the budget and the scene had been passing since it
 * was added without testing anything. It is also the number that catches an
 * under-populated capture — a frame photographed before its trajectory caches
 * filled has a fraction of the ink of the same scene rendered whole, which is
 * the defect the cassini-soi goldens turned out to encode.
 */
function inkFrac(png) {
  let n = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    const o = i * 4;
    if (png.data[o] > INK_LEVEL || png.data[o + 1] > INK_LEVEL || png.data[o + 2] > INK_LEVEL) n++;
  }
  return n / (png.width * png.height);
}

async function main() {
  const chromium = await loadPlaywright();
  const { pixelmatch, PNG } = await loadDiffers();

  mkdirSync(GOLDEN_DIR, { recursive: true });

  let server = null;
  let baseUrl = process.env.CL_VIEWER_URL;
  let basePath = '/';
  if (!baseUrl) {
    if (process.env.VR_SKIP_BUILD !== '1') buildEverything();
    basePath = distBase();
    if (basePath !== '/') {
      console.log(`[visual-regression] dist was built for base "${basePath}"; serving preview there to match.`);
    }
    server = startPreview(basePath);
    baseUrl = server.url;
    await waitForServer(baseUrl + basePath.slice(1));
  }

  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'] });
  const failures = [];
  const warnings = [];
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });

    // A build problem and a scene regression used to be indistinguishable: both
    // showed up as a 120 s `waitForFunction` timeout. Fail on the HTTP response
    // instead, naming the URL, the moment it arrives.
    let httpFailures = [];
    let onFatalHttp = null;
    page.on('response', (res) => {
      const type = res.request().resourceType();
      const status = res.status();
      const ctype = (res.headers()['content-type'] ?? '').split(';')[0];
      // A base-path mismatch does NOT show up as a 404. `vite preview` answers
      // an unknown path with the SPA fallback, so a request for
      // `/cosmolabe/assets/index-*.js` comes back 200 `text/html` — 680 bytes of
      // index.html where the browser wanted a module script. That is the exact
      // signature, and diagnosing it is worth more than the status code alone:
      // it is what cost an entire debugging session before this check existed.
      const servedHtmlForCode =
        status < 400 && (type === 'script' || type === 'stylesheet') && ctype === 'text/html';
      if (status < 400 && !servedHtmlForCode) return;
      const fatal = servedHtmlForCode || type === 'document' || type === 'script' || type === 'stylesheet';
      const rec = { status, url: res.url(), type, ctype, fatal, servedHtmlForCode };
      httpFailures.push(rec);
      if (fatal && onFatalHttp) onFatalHttp(rec);
    });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    for (const scene of SCENES) {
      console.log(`\n[scene] ${scene.catalog}`);
      httpFailures = [];
      pageErrors.length = 0;

      const sceneUrl = `${baseUrl}${basePath}?catalog=${encodeURIComponent(scene.catalog)}&test=1`;

      // Armed BEFORE `goto`, not after. The failure this exists to catch — the
      // entry script answered with 404 or with the SPA fallback — happens during
      // the navigation itself, so a handler installed afterwards sees nothing
      // and the run still pays the full ready timeout to learn nothing.
      const fatalHttp = new Promise((_, reject) => {
        onFatalHttp = (rec) =>
          reject(
            new Error(
              rec.servedHtmlForCode
                ? `the server answered the ${rec.type} request ${rec.url} with ${rec.status} ${rec.ctype} — ` +
                  `that is the SPA fallback, so dist and the preview server disagree about the base path. ` +
                  `dist/index.html asks for "${distBase()}"; this run served "${basePath}". ` +
                  `Rebuild with VITE_BASE cleared (this script does that unless VR_SKIP_BUILD=1 or CL_VIEWER_URL is set).`
                : `${rec.status} on ${rec.type} ${rec.url} — the app cannot boot`,
            ),
          );
      });
      // Nothing awaits `fatalHttp` until the race below, and a rejection with no
      // handler is a process-level warning (a fatal error on some Node configs).
      fatalHttp.catch(() => {});
      try {
        await Promise.race([
          page
            .goto(sceneUrl, { waitUntil: 'load' })
            .then(() => page.waitForFunction(() => window.__cosmolabe?.ready === true, { timeout: 120000 })),
          fatalHttp,
        ]);
      } catch (err) {
        onFatalHttp = null;
        // Say which of the two it was. "Never loaded" and "never became ready"
        // want completely different fixes.
        const diag = await page
          .evaluate(() => ({
            hook: typeof window.__cosmolabe,
            canvas: !!document.querySelector('canvas'),
            readyState: document.readyState,
          }))
          .catch(() => ({ hook: 'unknown', canvas: false, readyState: 'unknown' }));
        const fatal = httpFailures.filter((f) => f.fatal);
        const lines = [`${scene.catalog}: scene never became ready — ${err.message}`];
        if (fatal.length) {
          lines.push(
            `    the app never loaded: ${fatal.map((f) => `${f.status} ${f.url}`).join(', ')}`,
            `    if those URLs carry a base prefix the server does not serve, dist and preview disagree —` +
              ` rebuild with VITE_BASE cleared (this script does that for you unless VR_SKIP_BUILD=1)`,
          );
        } else if (diag.hook === 'undefined' && !diag.canvas) {
          lines.push(`    the app never loaded: no canvas and no test hook (document.readyState=${diag.readyState})`);
        } else {
          lines.push(`    the app loaded (canvas=${diag.canvas}, hook=${diag.hook}) but the scene did not initialize`);
        }
        if (pageErrors.length) lines.push(`    page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
        failures.push(lines.join('\n'));
        continue;
      }
      onFatalHttp = null;
      await page.waitForTimeout(SETTLE_MS);

      const nonFatal = httpFailures.filter((f) => !f.fatal);
      if (nonFatal.length) {
        warnings.push(
          `${scene.catalog}: ${nonFatal.length} non-fatal HTTP failure(s), which can silently thin the scene: ` +
            nonFatal.slice(0, 5).map((f) => `${f.status} ${f.url}`).join(', '),
        );
      }

      const viewpoints = scene.viewpoints.length ? scene.viewpoints : [null];
      for (const vp of viewpoints) {
        const label = `${scene.catalog}${vp ? `--${vp}` : ''}`.replace(/[^\w.-]+/g, '_');
        let dataUrl;
        try {
          dataUrl = await page.evaluate((name) => window.__cosmolabe.capture(name ?? undefined), vp);
        } catch (err) {
          // The capture hook throws on a viewpoint it cannot resolve. It used to
          // ignore the failure and photograph whatever the camera was already
          // looking at, which combined with self-baselining turned a typo into a
          // confidently-committed wrong picture.
          failures.push(`${label}: capture failed — ${String(err).split('\n')[0]}`);
          continue;
        }
        const actual = dataUrlToPng(PNG, dataUrl);
        const actualInk = inkFrac(actual);
        const goldenPath = join(GOLDEN_DIR, `${label}.png`);
        const exists = existsSync(goldenPath);

        if (!exists && !CREATE) {
          // Writing this file and exiting 0 is how a renamed scene or viewpoint
          // used to promote its new picture to the truth, with no diff and no
          // warning. Creating a golden is now its own decision.
          failures.push(
            `${label}: no golden at ${goldenPath} (drew ${(actualInk * 100).toFixed(2)}% ink).\n` +
              '    If this scene is new, create it deliberately: CREATE_VISUAL_GOLDENS=1\n' +
              '    If it is not, a scene or viewpoint has been renamed and the old golden is now orphaned.',
          );
          continue;
        }
        if (UPDATE || !exists) {
          writeFileSync(goldenPath, PNG.sync.write(actual));
          console.log(`  ${exists ? 'wrote' : 'created'} golden ${label}.png (${(actualInk * 100).toFixed(2)}% ink)`);
          continue;
        }

        const golden = PNG.sync.read(readFileSync(goldenPath));
        if (golden.width !== actual.width || golden.height !== actual.height) {
          failures.push(`${label}: size ${actual.width}x${actual.height} != golden ${golden.width}x${golden.height}`);
          continue;
        }
        const goldenInk = inkFrac(golden);

        // A golden with less ink than the diff budget cannot fail, whatever
        // happens to the render. That is not a drift failure, it is a scene that
        // does not test anything, and it should be as loud as a real one.
        if (goldenInk <= MAX_DIFF_FRAC) {
          failures.push(
            `${label}: golden draws only ${(goldenInk * 100).toFixed(2)}% ink, which is less than the ` +
              `${(MAX_DIFF_FRAC * 100).toFixed(2)}% diff budget — no change to this scene could ever fail it.\n` +
              '    Point the scene at something (a viewpoint that fills the frame) or drop it.',
          );
          continue;
        }

        const diff = new PNG({ width: golden.width, height: golden.height });
        const nDiff = pixelmatch(golden.data, actual.data, diff.data, golden.width, golden.height, { threshold: THRESHOLD });
        const frac = nDiff / (golden.width * golden.height);
        // What share of everything the golden draws must move before this fails.
        // Above ~25% the scene is only catching gross changes; say so rather
        // than letting a green run imply more than it means.
        const share = MAX_DIFF_FRAC / goldenInk;
        const inkNote = `ink golden ${(goldenInk * 100).toFixed(2)}% / actual ${(actualInk * 100).toFixed(2)}%`;
        if (share > 0.25) {
          warnings.push(
            `${label}: low power — the ${(MAX_DIFF_FRAC * 100).toFixed(2)}% budget is ${(share * 100).toFixed(0)}% of ` +
              `all the ink in this golden (${(goldenInk * 100).toFixed(2)}%), so only gross changes can fail it.`,
          );
        }
        if (frac > MAX_DIFF_FRAC) {
          writeFileSync(join(OUT_DIR, `${label}-actual.png`), PNG.sync.write(actual));
          writeFileSync(join(OUT_DIR, `${label}-diff.png`), PNG.sync.write(diff));
          let msg =
            `${label}: ${(frac * 100).toFixed(3)}% pixels differ (> ${(MAX_DIFF_FRAC * 100).toFixed(2)}%) — ` +
            `see ${label}-diff.png [${inkNote}]`;
          // A big ink gap says the two frames do not contain the same amount of
          // scene, which points at the capture (caches still filling, a failed
          // fetch, a stale library build) rather than at moved geometry.
          if (goldenInk > 0 && Math.abs(actualInk - goldenInk) / goldenInk > 0.25) {
            msg +=
              `\n    the frames differ in how much they draw, not just where: ` +
              `${(actualInk / goldenInk).toFixed(2)}x the golden's ink. That is a capture difference ` +
              `(unfilled trajectory caches, a failed fetch, or a stale packages/*/dist), not moved geometry.`;
          }
          failures.push(msg);
        } else {
          console.log(`  ok ${label} (${(frac * 100).toFixed(3)}% diff, ${inkNote})`);
        }
      }
    }
  } finally {
    await browser.close();
    server?.child.kill();
  }

  if (warnings.length) {
    console.warn('\n[visual-regression] warnings:\n' + warnings.map((w) => '  - ' + w).join('\n'));
  }
  if (failures.length) {
    console.error('\n[visual-regression] FAILED:\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
  }
  console.log(`\n[visual-regression] ${UPDATE || CREATE ? 'goldens written' : 'all scenes match'}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
