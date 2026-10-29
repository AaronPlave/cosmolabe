#!/usr/bin/env node
/**
 * The embeddable workspace as an installed package: `npm pack` the viewer,
 * unpack it into a throwaway project outside the repository, typecheck a
 * plain TypeScript host against the shipped declarations, build it with an
 * ordinary Vite (no Svelte plugin, no Cosmolabe configuration), serve the
 * result and mount the workspace in a browser.
 *
 * Proves the tarball is self-contained: its JavaScript, declarations, CSS,
 * workers, WASM and data assets. Run after `npm run build:embed`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => path.join(ROOT, 'node_modules/.bin', name);
const dir = mkdtempSync(path.join(tmpdir(), 'cosmolabe-embed-'));
const PORT = Number(process.env.EMBED_PACKAGE_PORT ?? 5298);

try {
  // Pack and unpack: exactly what `npm install <tarball>` would place.
  execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: path.join(ROOT, 'apps/viewer'), stdio: 'pipe' });
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  const target = path.join(dir, 'node_modules/@cosmolabe/viewer');
  mkdirSync(target, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(dir, tarball), '-C', target, '--strip-components=1']);
  const shipped = readdirSync(path.join(target, 'dist-embed'));
  if (!shipped.includes('cosmolabe.js') || !shipped.includes('cosmolabe.d.ts')) throw new Error(`tarball lacks the build: ${shipped}`);

  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><h1>Consumer</h1><div id="v" style="width:800px;height:500px"></div><script type="module" src="./main.ts"></script></body></html>');
  writeFileSync(path.join(dir, 'main.ts'), `
import { mountCosmolabe, HostDataAdapter, type MissionStateSource } from '@cosmolabe/viewer';

const adapter = new HostDataAdapter('consumer');
// A spacecraft parked 7000 km along J2000 +X from Earth, with a known attitude.
const source: MissionStateSource = {
  id: 'probe',
  position: { timeScale: 'TDB', frame: 'J2000', center: 'Earth', positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: 120 },
  async request(_channel, w) {
    const samples = [];
    for (let t = Math.ceil(w.start / 60) * 60; t <= w.end; t += 60) samples.push({ t, position: [7000, 0, 0], velocity: [0, 0, 0] });
    return adapter.supply({ window: { start: w.start, end: w.end }, samples }, { id: 'parked', kind: 'trajectory', classification: 'synthetic' });
  },
};
const viewer = await mountCosmolabe(document.getElementById('v')!, { missionState: [source] });
await viewer.loadCatalog({ json: { name: 'Consumer', defaultTime: '2026-01-01T00:00:00Z', items: [
  { name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
  { name: 'Earth', center: 'Sun', trajectory: { type: 'FixedPoint', position: [1.5e8, 0, 0] }, geometry: { type: 'Globe', radius: 6378 } },
  { name: 'Probe', center: 'Earth', class: 'spacecraft', trajectory: { type: 'MissionState', source: 'probe' } },
] } });
viewer.control.setPlaying(false);
for (let i = 0; i < 100 && !viewer.control.getObjectState('Probe')?.position; i++) await new Promise((r) => setTimeout(r, 25));
(window as unknown as { result: unknown }).result = viewer.control.getObjectState('Probe', { frame: 'J2000', center: 'Earth' });
`);
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true, noEmit: true, skipLibCheck: false, types: [] },
    files: ['main.ts'],
  }));

  execFileSync(bin('tsc'), ['-p', dir], { stdio: 'inherit' });
  console.log('  ✓ host typechecks against the shipped declarations');
  writeFileSync(path.join(dir, 'vite.config.mjs'), "export default { base: './', build: { target: 'es2022', chunkSizeWarningLimit: 4000 } };\n");
  execFileSync(bin('vite'), ['build', '--logLevel', 'warn'], { cwd: dir, stdio: 'inherit' });
  console.log('  ✓ ordinary Vite production build');

  const server = spawn(bin('vite'), ['preview', '--port', String(PORT), '--strictPort'], { cwd: dir, stdio: 'pipe' });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
      server.on('exit', (code) => reject(new Error(`vite preview exited ${code}`)));
    });
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForFunction(() => window.result !== undefined, null, { timeout: 60_000 });
      const result = await page.evaluate(() => window.result);
      const p = result?.position;
      if (!p || Math.hypot(p[0] - 7000, p[1], p[2]) > 1e-9) throw new Error(`state ${JSON.stringify(result)}`);
      const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
      if (!fonts.some((f) => /Public Sans/.test(f))) throw new Error(`workspace fonts not loaded: ${fonts}`);
      if (errors.length) throw new Error(errors.join('\n'));
      console.log('  ✓ mounts from the installed package; workers, WASM, fonts and state work');
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
