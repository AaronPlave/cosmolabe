/**
 * Loading screen layout (#346): the progress bar must not move as the stage,
 * catalog name or detail line change, and a long filename must never hide the
 * numeric progress beside it. Drives the real loading state through the app's
 * own viewer-state module (no kernel downloads), at desktop and narrow widths.
 *
 *   npx vite dev --port 5194 (in apps/viewer)  &&  node scripts/test-loading-layout.mjs
 *   CL_VIEWER_URL=...   server to use   CL_SHOTS_DIR=...   also save screenshots there
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://localhost:5194/';
const shots = process.env.CL_SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });

const LONG_NAME = 'Voyager 1 & 2 grand tour of the outer solar system with every encounter kernel and a deliberately overlong catalog title';
const LONG_FILE = 'Saturn ephemeris (699) — sat459_with_a_very_long_descriptive_kernel_file_name_that_cannot_fit.bsp';

// Row 1 is stage (`label`) + `count`; row 2 is optional `detail` (file) + `figures` (bytes).
const STEPS = [
  { id: 'fetching', begin: ['Fetching catalog', {}] },
  { id: 'preparing', begin: ['Preparing mission data', { kernelBytes: 263e6 }] },
  { id: 'spice', set: { label: 'Loading kernels', detail: 'Initializing SPICE', count: '', figures: '' } },
  { id: 'kernel-short', phase: ['kernels', 0.1], set: { label: 'Loading kernels', detail: 'de440s.bsp', count: '1 / 21', figures: '3.2 MB / 263.2 MB' } },
  { id: 'kernel-long', phase: ['kernels', 0.6], set: { detail: LONG_FILE, count: '9 / 21', figures: '149.4 MB / 263.2 MB' } },
  { id: 'kernel-no-detail', phase: ['kernels', 0.7], set: { detail: '', count: '', figures: '' } },
  { id: 'building', phase: ['kernels', 1], set: { label: 'Building scene', detail: '', count: '', figures: '' } },
  { id: 'assets', phase: ['assets', 0.4], set: { label: 'Loading models and textures', count: '12 / 30', detail: '', figures: '' } },
  { id: 'assets-grown', phase: ['assets', 0.1], set: { count: '12 / 120' } }, // total grew; bar must not retreat
];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 640 }]) {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(`${base}?test`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => e.name.includes('viewer-state')));
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((u) => new URL(u).pathname.includes('/lib/viewer-state.svelte'));
      window.__vs = await import(url);
    });

    const samples = [];
    for (const name of [LONG_NAME, 'Short']) {
      for (const step of STEPS) {
        await page.evaluate(([step, name]) => {
          const vs = window.__vs;
          if (step.begin) vs.beginLoad(step.begin[0], { ...step.begin[1], catalog: name });
          if (step.phase) vs.setPhaseProgress(step.phase[0], step.phase[1], step.set);
          else if (step.set) vs.setLoadingState(step.set);
        }, [step, name]);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const m = await page.evaluate(() => {
          const rect = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right }; };
          const figs = [...document.querySelectorAll('.figures')];
          const bar = document.querySelector('.bar');
          const file = document.querySelector('.file');
          return {
            bar: rect('.bar'), name: rect('.name'), label: rect('.label'), detail: rect('.detail'), body: rect('.body'),
            status: rect('.row:not(.detail)'),
            figuresRight: Math.max(...figs.map((f) => f.getBoundingClientRect().right)),
            figuresText: figs.map((f) => f.textContent).join(' | '),
            figuresClipped: figs.some((f) => f.scrollWidth > f.clientWidth),
            fileClipped: file.scrollWidth > file.clientWidth, fileTitle: file.title,
            nameTitle: document.querySelector('.name').title,
            pct: Number(bar.getAttribute('aria-valuenow')),
            overflowX: document.documentElement.scrollWidth > innerWidth,
          };
        });
        samples.push({ ...m, step: step.id, name });
        if (shots && name === LONG_NAME) await page.screenshot({ path: `${shots}/${viewport.width}-${step.id}.png` });
      }
    }

    const tag = `${viewport.width}px`;
    const bar0 = samples[0].bar;
    for (const s of samples) {
      const where = `${tag} ${s.step} (${s.name.slice(0, 8)})`;
      assert.deepEqual(s.bar, bar0, `bar moved at ${where}`);
      assert.equal(s.body.w <= Math.min(384, viewport.width) + 0.5, true, `body too wide at ${where}`);
      assert.equal(s.overflowX, false, `page overflows horizontally at ${where}`);
      assert.equal(s.figuresClipped, false, `figures clipped at ${where}`);
      assert.ok(s.figuresRight <= s.body.r + 0.5, `figures outside module at ${where}`);
      assert.deepEqual(s.body, samples[0].body, `module moved/resized at ${where}`);
      assert.deepEqual([s.status.x, s.status.y, s.status.h], [samples[0].status.x, samples[0].status.y, samples[0].status.h], `status row moved at ${where}`);
      assert.deepEqual([s.detail.x, s.detail.y], [samples[0].detail.x, samples[0].detail.y], `detail row moved at ${where}`);
      assert.ok(s.detail.h === samples[0].detail.h && s.label.h === samples[0].label.h && s.name.h === samples[0].name.h, `row height changed at ${where}`);
    }
    const long = samples.find((s) => s.step === 'kernel-long' && s.name === LONG_NAME);
    assert.equal(long.figuresText, '9 / 21 | 149.4 MB / 263.2 MB');
    assert.equal(long.fileClipped, true, 'long filename should ellipsize');
    assert.equal(long.fileTitle, LONG_FILE, 'full filename in tooltip');
    assert.equal(long.nameTitle, LONG_NAME, 'full catalog name in tooltip');
    // One bar, one direction: monotonic within each begun load, including the asset total growing.
    for (const name of [LONG_NAME, 'Short']) {
      const pcts = samples.filter((s) => s.name === name).map((s) => s.pct);
      assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), `bar retreated (${tag}): ${pcts}`);
    }
    console.log(`PASS ${tag}: bar, status and detail rows fixed across ${samples.length} states; figures never clipped; long names ellipsize with tooltips; no overflow.`);
    await page.close();
  }
} finally {
  await browser.close();
}
