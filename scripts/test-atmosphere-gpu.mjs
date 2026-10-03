#!/usr/bin/env node
// Validate the actual WebGL profile/LUT equations against independent integrals.
// Requires a local Vite viewer; build packages before running.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { normalizeAtmosphere, transmittanceToSpace } from '../packages/three/dist/AtmosphereModel.js';
import { getAtmospherePreset } from '../packages/three/dist/AtmosphereMesh.js';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5174';
  await page.goto(`${base}/?catalog=atmosphere-earth&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 120000 });
  const results = await page.evaluate(async () => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    // Probe the shared equations from the actual viewer material.
    const shader = window.renderer.atmosphereMeshes.get('Earth').atm.material.vertexShader;
    const ATMOSPHERE_PROFILES_GLSL = shader.slice(shader.indexOf('uniform float uAtmPlanetR;'), shader.indexOf('varying vec3  vColor;'));
    const r = window.renderer.renderer;
    const atm = window.renderer.atmosphereMeshes.get('Earth').atm;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    const material = new THREE.ShaderMaterial({
      uniforms: { ...atm.material.uniforms, probePoint: { value: new THREE.Vector3() }, probeDir: { value: new THREE.Vector3() }, mode: { value: 0 } },
      vertexShader: 'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader: `${ATMOSPHERE_PROFILES_GLSL}
        uniform vec3 probePoint; uniform vec3 probeDir; uniform int mode;
        void main(){
          if(mode==0){gl_FragColor=vec4(atmSunTransmittance(probePoint,probeDir),1.0);return;}
          if(mode==2){gl_FragColor=vec4(atmSegmentWeight(vec3(0.0,0.1,10.0),2.0),1.0);return;}
          vec3 integral=vec3(0.0); vec3 mieIntegral=vec3(0.0);
          for(int i=0;i<1024;i++){
            float mu=-1.0+2.0*(float(i)+0.5)/1024.0;
            float k=-0.9;
            float mie=(1.0-k*k)/((1.0-k*mu)*(1.0-k*mu));
            integral+=atmScattering(vec3(1.0,0.0,0.0),0.75*(1.0+mu*mu),mie)* (4.0*3.14159265358979/1024.0);
            mieIntegral+=atmScattering(vec3(0.0,1.0,0.0),0.0,mie)* (4.0*3.14159265358979/1024.0);
          }
          gl_FragColor=vec4(integral.r/uAtmRayleighScattering.r,mieIntegral.r/uAtmMieScattering.r,1.0,1.0);
        }`,
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geometry, material));
    const camera = new THREE.Camera();
    const previous = r.getRenderTarget();
    const read = () => {
      r.setRenderTarget(target); r.render(scene, camera);
      const data = new Float32Array(4); r.readRenderTargetPixels(target, 0, 0, 1, 1, data);
      return Array.from(data).slice(0, 3);
    };
    try {
      const samples = [[2, 1], [2, 0], [25, 0.3], [90, 1], [2, -0.1]].map(([h, mu]) => {
        material.uniforms.probePoint.value.set((6378.1 + h) / atm.shellRadius, 0, 0);
        material.uniforms.probeDir.value.set(mu, Math.sqrt(1 - mu * mu), 0);
        return { h, mu, rgb: read() };
      });
      material.uniforms.mode.value = 1;
      const phaseIntegral = read();
      material.uniforms.mode.value = 2;
      return { samples, phaseIntegral, segmentWeight: read() };
    } finally {
      r.setRenderTarget(previous); target.dispose(); material.dispose(); geometry.dispose();
    }
  });
  const model = normalizeAtmosphere(getAtmospherePreset('Earth'));
  for (const { h, mu, rgb } of results.samples) {
    const reference = transmittanceToSpace(model, 6378.1, [6378.1 + h, 0, 0], [mu, Math.sqrt(1 - mu * mu), 0], 4096);
    rgb.forEach((value, i) => assert.ok(Number.isFinite(value) && Math.abs(value - reference[i]) < 0.025,
      `LUT at h=${h}, mu=${mu}, channel=${i}: ${value}, reference ${reference[i]}`));
  }
  results.phaseIntegral.forEach(value => assert.ok(Math.abs(value - 1) < 0.001, `phase integral ${value}`));
  [2, (1 - Math.exp(-0.2)) / 0.1, (1 - Math.exp(-20)) / 10].forEach((value, i) =>
    assert.ok(Math.abs(results.segmentWeight[i] - value) < 0.00001, `segment integral channel ${i}`));
  console.log('GPU segment integration passes. GPU transmittance: 5 RGB rays match the numerical reference; Rayleigh and Mie phases integrate to 1.');
} finally { await browser.close(); }
