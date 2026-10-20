#!/usr/bin/env node
// Verify solar extinction in complete stock material shaders, not just a GLSL probe.
// Build packages and run the dev viewer first (see docs/atmosphere-validation.md).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { normalizeAtmosphere, transmittanceToSpace } from '../packages/three/dist/AtmosphereModel.js';
import { getAtmospherePreset } from '../packages/three/dist/AtmosphereMesh.js';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('THREE.WebGLProgram')) errors.push(message.text());
  });
  await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5174'}/?catalog=test-catalogs/atmosphere-earth&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 120000 });
  const results = await page.evaluate(async repo => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { injectAerialPerspectiveIntoShader, makeAerialPerspectiveUniforms } =
      await import(`/@fs${repo}packages/three/dist/AerialPerspective.js`);
    const renderer = window.renderer.renderer;
    const atm = window.renderer.atmosphereMeshes.get('Earth').atm;
    const radius = 6378.1;
    const u = makeAerialPerspectiveUniforms(atm.model, radius, 1, atm.transmittanceLUT);
    u.uAPPlanetRadius.value = radius; u.uAPShellRadius.value = atm.shellRadius;
    u.uAPMultiScatterLUT.value = atm.multiScatterLUT;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry); scene.add(mesh);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.00001, 10);
    const sun = new THREE.DirectionalLight(0xffffff, 1); scene.add(sun, sun.target);
    const ambient = new THREE.AmbientLight(0xffffff, 0); scene.add(ambient);
    const local = new THREE.PointLight(0xffffff, 0, 0, 0); scene.add(local);
    const previous = renderer.getRenderTarget();
    const tone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    const read = strength => {
      u.uAPStrength.value = strength;
      scene.updateMatrixWorld(true);
      renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene, camera);
      const data = new Float32Array(4); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, data);
      return Array.from(data).slice(0, 3);
    };
    const samples = [];
    try {
      for (const kind of ['phong', 'standard', 'physical', 'basic']) {
        const mat = kind === 'phong' ? new THREE.MeshPhongMaterial({ color: 0xffffff, specular: 0xffffff })
          : kind === 'standard' ? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 })
          : kind === 'physical' ? new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.4, clearcoat: 1 })
          : new THREE.MeshBasicMaterial({ color: 0xffffff });
        let projectGlobe = false;
        mat.onBeforeCompile = shader => injectAerialPerspectiveIntoShader(shader, u, projectGlobe);
        mat.customProgramCacheKey = () => `${kind}-surface-${projectGlobe}`;
        mesh.material = mat;
        for (const transformed of [false, true]) {
          const frame = transformed ? new THREE.Matrix4().compose(new THREE.Vector3(12345, -6789, 4321),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.8), new THREE.Vector3(1, 0.9, 1))
            : new THREE.Matrix4();
          u.uAPPlanetToWorld.value.copy(frame); u.uAPWorldToPlanet.value.copy(frame).invert();
          for (const [h, mu, globe] of [[0, 1, false], [0, 0.05, false], [2, 0.2, false], [20, 0.2, false],
            [100, 1, false], [400, 1, false], [0, 0.05, true]]) {
            projectGlobe = globe; mat.needsUpdate = true;
            // A chord endpoint must project onto the reference globe, while
            // terrain uses its actual height. The central pixel faces +Z.
            const position = new THREE.Vector3(0, 0, radius + h - (globe ? 1 : 0));
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(frame).multiply(new THREE.Matrix4().makeTranslation(...position.toArray()));
            camera.position.set(0, 0, radius + h + 0.001).applyMatrix4(frame);
            camera.up.set(0, 1, 0).transformDirection(frame);
            camera.lookAt(new THREE.Vector3(0, 0, radius + h).applyMatrix4(frame));
            camera.updateMatrixWorld(true);
            u.uAPCameraWorldPos.value.copy(camera.position);
            u.uAPSunWorldPos.value.set(Math.sqrt(1 - mu * mu) * 1e8, 0, radius + h + mu * 1e8).applyMatrix4(frame);
            sun.position.copy(u.uAPSunWorldPos.value);
            sun.target.position.set(0, 0, radius + h).applyMatrix4(frame);
            local.position.copy(camera.position);
            sun.intensity = 1; ambient.intensity = 0; local.intensity = 0;
            samples.push({ kind, transformed, h, mu, globe, source: 'sun', baseline: read(0), attenuated: read(1) });
            if (h === 0 && mu === 1 && !globe) {
              sun.intensity = 0;
              for (const source of ['ambient', 'point', 'emission']) {
                ambient.intensity = source === 'ambient' ? 1 : 0;
                local.intensity = source === 'point' ? 1 : 0;
                if ('emissive' in mat) mat.emissive.setHex(source === 'emission' ? 0xffffff : 0);
                samples.push({ kind, transformed, h, mu, source, baseline: read(0), attenuated: read(1) });
              }
              if ('emissive' in mat) mat.emissive.setHex(0);
            }
          }
        }
        mat.dispose();
      }
      return samples;
    } finally {
      renderer.setRenderTarget(previous); renderer.toneMapping = tone;
      target.dispose(); geometry.dispose();
    }
  }, fileURLToPath(new URL('../', import.meta.url)));
  assert.deepEqual(errors, [], 'WebGL shader compilation errors');
  const model = normalizeAtmosphere(getAtmospherePreset('Earth'));
  for (const sample of results) {
    const { kind, source, h, mu, baseline, attenuated } = sample;
    if (source === 'sun') assert.ok(baseline.every(value => value > 1e-4), `Unlit test fixture: ${JSON.stringify(sample)}`);
    const expected = source === 'sun' && kind !== 'basic'
      ? transmittanceToSpace(model, 6378.1, [0, 0, 6378.1 + h], [Math.sqrt(1 - mu * mu), 0, mu], 4096)
      : [1, 1, 1];
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Number.isFinite(attenuated[channel]), JSON.stringify(sample));
      if (baseline[channel] > 1e-6) assert.ok(Math.abs(attenuated[channel] / baseline[channel] - expected[channel]) < 0.025,
        `${JSON.stringify(sample)} channel=${channel}, expected ratio=${expected[channel]}`);
      else assert.ok(Math.abs(attenuated[channel]) < 1e-6, JSON.stringify(sample));
    }
  }
  console.log(`${results.length} material probes pass: RGB solar extinction, globe/terrain endpoints, oblate transforms, elevated geometry, and unaffected ambient/local/emissive/unlit terms.`);
} finally { await browser.close(); }
