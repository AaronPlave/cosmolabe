#!/usr/bin/env node
// Validate the actual WebGL profile/LUT equations against independent integrals.
// Requires a local Vite viewer; build packages before running.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { extinctionAt, normalizeAtmosphere, transmittanceToSpace } from '../packages/three/dist/AtmosphereModel.js';
import { getAtmospherePreset } from '../packages/three/dist/AtmosphereMesh.js';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5174';
  await page.goto(`${base}/?catalog=atmosphere-earth&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 120000 });
  const results = await page.evaluate(async repo => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    // Probe the shared equations directly; the lookup path uses a minimal shell vertex shader.
    const { ATMOSPHERE_PROFILES_GLSL } =
      await import(`/@fs${repo}packages/three/dist/AtmosphereProfiles.js`);
    const { SKY_VIEW_BASIS_GLSL } =
      await import(`/@fs${repo}packages/three/dist/SkyViewLUT.js`);
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
      const horizonSamples = [2, 10, 50, 90].flatMap(h => {
        const tangentMu = -Math.sqrt(1 - (6378.1 / (6378.1 + h)) ** 2);
        return [0.0001, 0.001, 0.005].map(offset => {
          const mu = tangentMu + offset;
          material.uniforms.probePoint.value.set((6378.1 + h) / atm.shellRadius, 0, 0);
          material.uniforms.probeDir.value.set(mu, Math.sqrt(1 - mu * mu), 0);
          return { h, mu, rgb: read() };
        });
      });
      material.uniforms.mode.value = 1;
      const phaseIntegral = read();
      material.uniforms.mode.value = 2;
      const segmentWeight = read();
      // Exercise the missing-LUT direct-Sun branch with the same numerical oracle.
      material.uniforms.mode.value = 0;
      material.uniforms.uAtmHasTransmittanceLUT = { value: false };
      const fallbackSamples = samples.map(({ h, mu }) => {
        material.uniforms.probePoint.value.set((6378.1 + h) / atm.shellRadius, 0, 0);
        material.uniforms.probeDir.value.set(mu, Math.sqrt(1 - mu * mu), 0);
        return { h, mu, rgb: read() };
      });
      const { AERIAL_PERSPECTIVE_FRAG_PARS, makeAerialPerspectiveUniforms } =
        await import(`/@fs${repo}packages/three/dist/AerialPerspective.js`);
      const apu = makeAerialPerspectiveUniforms(atm.model, 6378.1, 1, atm.transmittanceLUT);
      apu.uAPCameraWorldPos.value.set(6778.1, 0, 0);
      apu.uAPSunWorldPos.value.set(100000000, 0, 0);
      apu.uSunWorldPos.value.copy(apu.uAPSunWorldPos.value);
      apu.uSunRadius.value = 695000;
      apu.uAPPlanetRadius.value = 6378.1; apu.uAPShellRadius.value = atm.shellRadius;
      apu.uAPStrength.value = 1; apu.uAPMieK.value = -0.9;
      apu.uAPMultiScatterLUT.value = atm.multiScatterLUT;
      const apMaterial = new THREE.ShaderMaterial({ uniforms: apu,
        vertexShader: material.vertexShader,
        fragmentShader: `${AERIAL_PERSPECTIVE_FRAG_PARS}
          void main(){ AerialPerspectiveResult ap=computeAerialPerspective(vec3(6378.1,0.0,0.0));
            gl_FragColor=vec4(ap.inscatter,ap.transmittance.r); }` });
      scene.children[0].material = apMaterial;
      const readAP = () => {
        r.setRenderTarget(target); r.render(scene,camera);
        const data=new Float32Array(4); r.readRenderTargetPixels(target,0,0,1,1,data);
        return Array.from(data);
      };
      const clearAP=readAP();
      apu.uShadowOccluderCount.value=1;
      apu.uShadowOccluderPos.value[0].set(40000,0,0);
      apu.uShadowOccluderRadius.value[0]=1800;
      const eclipsedAP=readAP();
      // The endpoint is shadowed, but samples above this small nearby occluder are lit.
      apu.uShadowOccluderPos.value[0].set(6400,0,0);
      apu.uShadowOccluderRadius.value[0]=5;
      const partialAP=readAP();
      apu.uShadowOccluderCount.value=0;
      const opaque=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);
      opaque.needsUpdate=true;
      apu.uRingMap.value=opaque; apu.uRingOuterRadius.value=10000;
      apu.uRingCenterWorld.value.set(40000,1000,0); apu.uRingNormalWorld.value.set(1,0,0);
      const ringAP=readAP();
      // A translated, rotated, oblate body must put eclipse samples in scene space.
      apu.uRingOuterRadius.value = 0;
      const frame = new THREE.Matrix4().compose(new THREE.Vector3(12345, -6789, 4321),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), Math.PI / 2),
        new THREE.Vector3(1,0.9,1));
      apu.uAPPlanetToWorld.value.copy(frame); apu.uAPWorldToPlanet.value.copy(frame).invert();
      apu.uAPCameraWorldPos.value.set(6778.1,0,0).applyMatrix4(frame);
      apu.uAPSunWorldPos.value.set(100000000,0,0).applyMatrix4(frame);
      apu.uSunWorldPos.value.copy(apu.uAPSunWorldPos.value);
      apu.uShadowOccluderCount.value = 1;
      apu.uShadowOccluderPos.value[0].set(40000,0,0).applyMatrix4(frame);
      apu.uShadowOccluderRadius.value[0] = 1800;
      apMaterial.fragmentShader = apMaterial.fragmentShader.replace(
        'computeAerialPerspective(vec3(6378.1,0.0,0.0))',
        'computeAerialPerspective((uAPPlanetToWorld * vec4(6378.1,0.0,0.0,1.0)).xyz)');
      apMaterial.needsUpdate = true;
      const transformedAP = readAP();
      apMaterial.dispose(); opaque.dispose();
      // Render a complete shell built without the optional renderer argument.
      const { AtmosphereMesh, getAtmospherePreset } = await import(`/@fs${repo}packages/three/dist/AtmosphereMesh.js`);
      const fallback = new AtmosphereMesh(6378.1,getAtmospherePreset('Earth'));
      fallback.scale.setScalar(fallback.shellRadius); fallback.updateMatrixWorld(true);
      const shellCamera=new THREE.PerspectiveCamera(40,1,1,100000);
      shellCamera.position.set(18000,0,0); shellCamera.lookAt(0,0,0); shellCamera.updateMatrixWorld(true);
      fallback.update(shellCamera.position,new THREE.Vector3(100000000,0,0));
      const shellScene=new THREE.Scene(); shellScene.add(fallback);
      const shellTarget=new THREE.WebGLRenderTarget(128,128,{type:THREE.FloatType});
      r.setRenderTarget(shellTarget); r.render(shellScene,shellCamera);
      const pixels=new Float32Array(128*128*4); r.readRenderTargetPixels(shellTarget,0,0,128,128,pixels);
      let litPixels=0; for(let i=0;i<pixels.length;i+=4) if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>0.0001) litPixels++;
      fallback.dispose(); shellTarget.dispose();
      // Read the actual filtered half-float sky lookup through the reader's
      // elevation mapping, including rays on both sides of the cap tangent.
      const skyShell=new AtmosphereMesh(6378.1,getAtmospherePreset('Earth'),r);
      skyShell.scale.setScalar(skyShell.shellRadius); skyShell.updateMatrixWorld(true);
      const skyMaterial=new THREE.ShaderMaterial({
        uniforms:{lut:{value:skyShell.material.uniforms.uSkyViewLUT.value},
          eye:{value:new THREE.Vector3()},capR:{value:skyShell.material.uniforms.planetR.value-skyShell.material.uniforms.planetCapBias.value},
          theta:{value:0}},
        vertexShader:material.vertexShader,
        fragmentShader:`uniform sampler2D lut; uniform vec3 eye; uniform float capR; uniform float theta;
          ${SKY_VIEW_BASIS_GLSL}
          void main(){float v=skyVFromTheta(theta,skyHorizonTheta(eye,capR));
            gl_FragColor=vec4(texture2D(lut,vec2(0.5,v)).aaa,1.0);}`,
      });
      scene.children[0].material=skyMaterial;
      const skySamples=[];
      for(const h of [50,99.99]){
        skyShell.update(new THREE.Vector3(6378.1+h,0,0),new THREE.Vector3(1e8,0,0));
        skyMaterial.uniforms.eye.value.set((6378.1+h)/skyShell.shellRadius,0,0);
        const capKm=6378.1-skyShell.model.planetCapBias*skyShell.shellRadius;
        const tangent=Math.PI-Math.asin(capKm/(6378.1+h));
        for(const offset of [-0.05,0.05]){
          const theta=tangent+offset*Math.PI/180;
          skyMaterial.uniforms.theta.value=theta;
          skySamples.push({h,theta,alpha:read()[0]});
        }
      }
      skyMaterial.dispose(); skyShell.dispose();
      return { samples, horizonSamples, fallbackSamples, phaseIntegral, segmentWeight, clearAP, eclipsedAP, partialAP, ringAP, transformedAP, litPixels, skySamples };
    } finally {
      r.setRenderTarget(previous); target.dispose(); material.dispose(); geometry.dispose();
    }
  }, fileURLToPath(new URL('../', import.meta.url)));
  const model = normalizeAtmosphere(getAtmospherePreset('Earth'));
  const skyRadius=6378.1+model.heightKm;
  const capRadius=6378.1-model.planetCapBias*skyRadius;
  for(const {h,theta,alpha} of results.skySamples){
    const eye=6378.1+h,mu=Math.cos(theta);
    const exit=-eye*mu+Math.sqrt((eye*mu)**2-(eye**2-skyRadius**2));
    const capDisc=(eye*mu)**2-(eye**2-capRadius**2);
    const capHit=capDisc>0?-eye*mu-Math.sqrt(capDisc):Infinity;
    const end=capHit>0?Math.min(exit,capHit):exit;
    const step=end/16;
    const depth=[0,0,0];
    for(let j=0;j<16;j++){
      const distance=(j+0.5)*step;
      const altitude=Math.max(0,Math.sqrt(eye**2+distance**2+2*eye*mu*distance)-6378.1);
      const extinction=extinctionAt(model,altitude);
      for(let i=0;i<3;i++)depth[i]+=extinction[i]*step;
    }
    const reference=depth.reduce((sum,value)=>sum+Math.exp(-value)/3,0);
    assert.ok(Math.abs(alpha-reference)<0.025,
      `Filtered sky LUT at ${h} km, theta=${theta}: ${alpha}, direct=${reference}`);
  }
  for (const { h, mu, rgb } of [...results.samples, ...results.fallbackSamples]) {
    const reference = transmittanceToSpace(model, 6378.1, [6378.1 + h, 0, 0], [mu, Math.sqrt(1 - mu * mu), 0], 4096);
    rgb.forEach((value, i) => assert.ok(Number.isFinite(value) && Math.abs(value - reference[i]) < 0.025,
      `LUT at h=${h}, mu=${mu}, channel=${i}: ${value}, reference ${reference[i]}`));
  }
  for (const { h, mu, rgb } of results.horizonSamples) {
    const reference = transmittanceToSpace(model, 6378.1,
      [6378.1 + h, 0, 0], [mu, Math.sqrt(1 - mu * mu), 0], 4096);
    rgb.forEach((value, i) => assert.ok(Math.abs(value - reference[i]) < 0.005,
      `Grazing Sun path at h=${h}, mu=${mu}, channel=${i}: ${value}, reference ${reference[i]}`));
  }
  results.phaseIntegral.forEach(value => assert.ok(Math.abs(value - 1) < 0.001, `phase integral ${value}`));
  [2, (1 - Math.exp(-0.2)) / 0.1, (1 - Math.exp(-20)) / 10].forEach((value, i) =>
    assert.ok(Math.abs(results.segmentWeight[i] - value) < 0.00001, `segment integral channel ${i}`));
  assert.ok(results.litPixels > 20, `Renderer-optional shell is dark: ${results.litPixels} lit pixels`);
  for (let i=0;i<3;i++) {
    assert.ok(results.clearAP[i]>0.00001);
    assert.ok(results.eclipsedAP[i]<0.000001, `Umbra has daytime radiance: ${results.eclipsedAP}`);
    assert.ok(results.transformedAP[i]<0.000001, `Transformed umbra has daytime radiance: ${results.transformedAP}`);
    assert.ok(results.ringAP[i]<0.000001, `Opaque ring has daytime radiance: ${results.ringAP}`);
    assert.ok(results.partialAP[i]>0 && results.partialAP[i]<results.clearAP[i], `Sample visibility not preserved: ${results.partialAP}`);
  }
  for (const result of [results.eclipsedAP,results.partialAP,results.ringAP,results.transformedAP])
    assert.ok(Math.abs(result[3]-results.clearAP[3])<0.00001, 'Occlusion changed view extinction');
  console.log('Renderer-optional shell and per-sample moon/ring visibility pass; shadowed extinction is unchanged.');
  console.log('GPU segment integration passes. GPU transmittance: LUT and fallback each match 5 RGB rays against the numerical reference; Rayleigh and Mie phases integrate to 1.');
  console.log('GPU transmittance matches 12 grazing Sun rays within 0.005 RGB of direct integration.');
  console.log('Filtered sky-view LUT matches direct extinction near the horizon at 50 km and 99.99 km.');
} finally { await browser.close(); }
