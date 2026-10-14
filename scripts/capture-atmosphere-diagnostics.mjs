#!/usr/bin/env node
// Same-camera transport decomposition and Saturn cloud-top loading brackets.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const repo = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.ATMOSPHERE_CAPTURE_DIR ?? 'apps/viewer/test-screenshots/atmosphere-diagnostics';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error' && msg.text().includes('THREE.WebGLProgram')) errors.push(msg.text()); });
  await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5185'}/?catalog=test-catalogs/atmosphere-saturn-shadow&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 120000 });
  assert.equal((await page.evaluate(() => window.__cosmolabe.assetSummary)).failed, 0);
  await page.evaluate(() => window.__cosmolabe.runScript('setPlaying off\nsetTime 2024-07-04T12:00:00Z'));
  await page.waitForTimeout(1000);
  for (const scale of [1, 0.5, 0.25]) {
    await page.evaluate(async ({ scale, repo }) => {
      const { AtmosphereMesh, getAtmospherePreset } = await import(`/@fs${repo}packages/three/dist/AtmosphereMesh.js`);
      const { makeAtmosphereProfileUniforms } = await import(`/@fs${repo}packages/three/dist/AtmosphereProfiles.js`);
      const r = window.renderer;
      const entry = r.atmosphereMeshes.get('Saturn');
      // Preserve the original inherited loading for reproducible brackets after calibration.
      const params = { ...getAtmospherePreset('Saturn'), mieCoeff: 0.0025 * scale,
        rayleighCoeff: [0.0035, 0.0028, 0.0015].map(v => v * scale),
        absorptionCoeff: [0.0008, 0.0006, 0.0002].map(v => v * scale) };
      const atm = new AtmosphereMesh(entry.atm.planetRadius, params, r.renderer);
      r.scene.remove(entry.atm); entry.atm.dispose(); entry.atm = atm; r.scene.add(atm);
      const u = r.aerialPerspectiveUniforms.get('Saturn');
      const profiles = makeAtmosphereProfileUniforms(atm.model, 1 / r.scaleFactor,
        atm.planetRadius * r.scaleFactor, atm.shellRadius * r.scaleFactor, atm.transmittanceLUT);
      for (const [key, uniform] of Object.entries(profiles)) u[key].value = uniform.value;
      u.uAPMultiScatterLUT.value = atm.multiScatterLUT;
      const mat = r.getBodyMesh('Saturn').mesh.material;
      window.diagnosticOriginalOBC ??= mat.onBeforeCompile.bind(mat);
    }, { scale, repo });
    for (const mode of ['off', 'extinction', 'inscatter', 'full']) {
      await page.evaluate(mode => {
        const mat = window.renderer.getBodyMesh('Saturn').mesh.material;
        mat.onBeforeCompile = (shader, renderer) => {
          window.diagnosticOriginalOBC(shader, renderer);
          const formula = { off: 'outgoingLight = outgoingLight;', extinction: 'outgoingLight *= _ap.transmittance;',
            inscatter: 'outgoingLight += _ap.inscatter;', full: 'outgoingLight = outgoingLight * _ap.transmittance + _ap.inscatter;' }[mode];
          shader.fragmentShader = shader.fragmentShader.replace('outgoingLight = outgoingLight * _ap.transmittance + _ap.inscatter;', formula);
        };
        mat.customProgramCacheKey = () => `diagnostic-${mode}`;
        mat.needsUpdate = true;
      }, mode);
      await page.waitForTimeout(500);
      const data = await page.evaluate(() => window.__cosmolabe.capture());
      const file = `${output}/saturn-${scale}-${mode}.png`;
      writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
      console.log(file);
    }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
