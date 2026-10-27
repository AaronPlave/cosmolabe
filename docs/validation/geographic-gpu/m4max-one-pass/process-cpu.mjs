// Usage: node process-cpu.mjs "<viewpoint>" <label>, with the viewer on port 5188.
// CPU time of the browser GPU and renderer processes, vectors off then on, over 8 s of live rendering.
import { chromium } from 'playwright';
const [view, label] = process.argv.slice(2);
const profile = (await import('node:os')).tmpdir() + '/cl-process-cpu-' + process.pid;
const browser = await chromium.launchPersistentContext(profile, { viewport: { width: 1728, height: 1000 }, deviceScaleFactor: 2, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.setDefaultTimeout(120000);
await page.goto('http://127.0.0.1:5188/?catalog=test-catalogs/geographic-vectors-mars-streamed');
await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
await page.evaluate((v) => window.renderer.applyNamedViewpoint(v), view);
await page.waitForTimeout(20000);
const out = [];
for (const on of [false, true]) {
  await page.evaluate((on) => { const r = window.renderer; for (const l of r.universe.geographicLayers.layers) r.geographicVectors.setVisible(l.id, on); }, on);
  await page.waitForTimeout(1500);
  const { execSync } = await import('node:child_process');
  // CPU seconds of this browser's GPU and renderer processes (what heats the laptop).
  const cpu = () => { const rows = execSync('ps -axo pid=,time=,command=').toString().split('\n').filter(l => l.includes(profile));
    const sum = (k) => rows.filter(l => l.includes(k)).reduce((s, l) => { const t = l.trim().split(/\s+/)[1].split(':').map(Number); return s + (t.length === 3 ? t[0] * 3600 + t[1] * 60 + t[2] : t[0] * 60 + t[1]); }, 0);
    return { gpu: sum('--type=gpu-process'), renderer: sum('--type=renderer') }; };
  const c0 = cpu();
  const frames = await page.evaluate(async () => { let n = 0; const t = performance.now(); while (performance.now() - t < 8000) { await new Promise(requestAnimationFrame); n++; } return n / 8; });
  const c1 = cpu();
  out.push({ label, view, vectors: on, fps: frames, gpuProcess: +((c1.gpu - c0.gpu) / 8).toFixed(3), renderer: +((c1.renderer - c0.renderer) / 8).toFixed(3) });
}
console.log(JSON.stringify(out));
await browser.close();
