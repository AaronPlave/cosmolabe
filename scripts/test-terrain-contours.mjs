/** Offline WebGL smoke test. npm run build first.
 * node scripts/test-terrain-contours.mjs
 * Uses checked-in Mars TINs and an explicitly synthetic lunar polar patch.
 * This does not certify streamed imagery, cube terrain, or hardware timings.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const output = process.env.CONTOUR_OUTPUT ?? 'work/issue-183/captures';
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 5193 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(msg.text())) errors.push(msg.text()); });
  await page.route('**/contour-smoke', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0;background:#111"></body></html>' }));
  await page.goto(`${server.resolvedUrls.local[0]}contour-smoke`);
  const results = await page.evaluate(async upstreamAvailable => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { SurfaceAppearance, DEFAULT_SURFACE_APPEARANCE: defaults } = await import('/packages/three/src/SurfaceAppearance.ts');
    const { QuantizedMeshLoader } = await import('/node_modules/3d-tiles-renderer/src/three/plugins/loaders/QuantizedMeshLoader.js');
    const { injectShadowIntoShader, makeShadowUniforms } = await import('/packages/three/src/EclipseShadow.ts');
    const { injectAerialPerspectiveIntoShader, makeAerialPerspectiveUniforms } = await import('/packages/three/src/AerialPerspective.ts');
    const { normalizeAtmosphere } = await import('/packages/three/src/AtmosphereModel.ts');
    const { getAtmospherePreset } = await import('/packages/three/src/AtmosphereMesh.ts');
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    renderer.setSize(800, 600); renderer.setClearColor(0x151922); document.body.append(renderer.domElement);
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const result = { gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), captures: [] };
    const datum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] }, heightConvention: 'radial', verticalDatum: 'ellipsoid' };
    const moon = { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, heightConvention: 'radial', verticalDatum: 'reference-sphere' };
    // Procedural color texture exercises textured material composition, not
    // real imagery registration. Actual terrain TINs below are unmodified.
    const texels = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      const v = 95 + 30 * Math.sin((i % 32) * 0.5) * Math.cos(Math.floor(i / 32) * 0.4);
      texels.set([v * 1.2, v, v * 0.8, 255], i * 4);
    }
    const texture = new THREE.DataTexture(texels, 32, 32); texture.needsUpdate = true;
    async function marsTile(z, x, y) {
      const loader = new QuantizedMeshLoader();
      loader.ellipsoid.radius.set(3396190 - 8765, 3396190 - 8765, 3376200 - 8765);
      loader.minLon = (x / 2 ** (z + 1) * 360 - 180) * Math.PI / 180;
      loader.maxLon = ((x + 1) / 2 ** (z + 1) * 360 - 180) * Math.PI / 180;
      loader.minLat = (y / 2 ** z * 180 - 90) * Math.PI / 180;
      loader.maxLat = ((y + 1) / 2 ** z * 180 - 90) * Math.PI / 180;
      loader.skirtLength = 10;
      return loader.parse(await (await fetch(`/packages/three/src/__tests__/fixtures/marshub-${z}-${x}-${y}.terrain`)).arrayBuffer());
    }
    for (const body of ['Mars', 'Moon-synthetic-pole', 'Moon-synthetic-globe']) {
      const scene = new THREE.Scene(), group = new THREE.Group(); scene.add(group);
      const ambient = new THREE.AmbientLight(0xffffff, 2); scene.add(ambient);
      const sun = new THREE.DirectionalLight(0xffffff, 0.3); sun.position.set(1e7, 1e7, -1e7); scene.add(sun);
      const shadows = makeShadowUniforms();
      // Compile the production eclipse/AP chain. Baseline captures keep it
      // disabled; the controlled Mars fixture below actively exercises both.
      const atmosphere = normalizeAtmosphere(getAtmospherePreset('Mars'));
      const ap = makeAerialPerspectiveUniforms(atmosphere, 3396.19, 1000, null);
      Object.assign(ap, shadows); // Same eclipse fields for surface and atmospheric transport.
      const style = new SurfaceAppearance(body === 'Mars' ? datum : moon);
      const parents = [], children = [];
      let center, up;
      if (body === 'Mars') {
        const parent = await marsTile(13, 11716, 4935); parents.push(parent);
        center = parent.position.clone(); up = center.clone().normalize();
        for (const x of [23432, 23433]) for (const y of [9870, 9871]) children.push(await marsTile(14, x, y));
      } else if (body === 'Moon-synthetic-globe') {
        // Analytic global relief, not lunar observations. At this camera scale
        // every ground pixel exceeds the former 0.5 km footprint cutoff.
        // All heights also lie inside one 10 km band: a shallow negative basin
        // must still have contours, rather than passing only at zero crossings.
        const geometry = new THREE.SphereGeometry(1737400, 256, 128), p = geometry.getAttribute('position');
        const direction = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          direction.fromBufferAttribute(p, i).normalize();
          const lon = Math.atan2(direction.y, direction.x), lat = Math.asin(direction.z);
          const height = -4500 + 600 * Math.sin(8 * lon) * Math.cos(lat) + 300 * Math.sin(12 * lat);
          p.setXYZ(i, direction.x * (1737400 + height), direction.y * (1737400 + height), direction.z * (1737400 + height));
        }
        geometry.computeVertexNormals();
        center = new THREE.Vector3(); up = new THREE.Vector3(0, 0, 1);
        parents.push(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
      } else {
        const geometry = new THREE.PlaneGeometry(10000, 10000, 80, 80), p = geometry.getAttribute('position');
        center = new THREE.Vector3(0, 0, -1737400); up = new THREE.Vector3(0, 0, -1);
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), r = Math.hypot(x, y);
          const relief = 400 * Math.exp(-(((r - 2500) / 600) ** 2)) - 250 * Math.exp(-((r / 1600) ** 2));
          p.setZ(i, 1737400 - Math.sqrt(1737400 ** 2 - r ** 2) - relief);
        }
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()); mesh.position.copy(center); parents.push(mesh);
      }
      for (const mesh of [...parents, ...children]) {
        const matrix = new THREE.Matrix4().makeTranslation(...mesh.position);
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of materials) {
          m.map = texture; m.side = THREE.DoubleSide;
          if (body === 'Mars') {
            m.onBeforeCompile = shader => { injectShadowIntoShader(shader, shadows); injectAerialPerspectiveIntoShader(shader, ap); };
            m.customProgramCacheKey = () => 'contour-shadow-ap-compatibility';
          }
        }
        style.attach(mesh, matrix); mesh.position.sub(center); group.add(mesh);
      }
      children.forEach(m => { m.visible = false; });
      const bounds = new THREE.Box3().setFromObject(group), size = bounds.getSize(new THREE.Vector3()).length();
      const target = bounds.getCenter(new THREE.Vector3());
      const camera = new THREE.PerspectiveCamera(40, 800 / 600, 0.01, size * 10);
      camera.position.copy(target).addScaledVector(up, size * 1.35); camera.lookAt(target); camera.updateMatrixWorld();
      function render(name, settings) {
        style.set({ ...defaults, ...settings }); style.update(Infinity);
        style.updateContourInterval(camera, 800, 600, style.contourSources()); renderer.render(scene, camera);
        const pixels = new Uint8Array(800 * 600 * 4); gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        result.captures.push({ name: `${body}-${name}`, png: renderer.domElement.toDataURL() });
        return pixels;
      }
      const off = render('off', {}), on = render('contours', { contours: true });
      let changed = 0; for (let i = 0; i < off.length; i += 4) if (Math.abs(off[i] - on[i]) > 2) changed++;
      result[body] = { changedPixels: changed };
      render('combined', { contours: true, baseColor: 'elevation', hillshade: true });
      // On fully dark terrain the old diffuse-color injection produced no
      // visible lines. An annotation must survive absence of incident light.
      ambient.intensity = 0; sun.intensity = 0;
      const dark = render('dark-off', {});
      const darkContours = render('dark-contours', { contours: true, contourColor: '#ff0000', contourOpacity: 1 });
      let darkChanged = 0;
      for (let i = 0; i < dark.length; i += 4) if (darkContours[i] > dark[i] + 10) darkChanged++;
      result[body].darkContourPixels = darkChanged;
      ambient.intensity = 2; sun.intensity = 0.3;
      if (body === 'Mars') {
        // Controlled optical fixture, not an observed eclipse. Exercise active
        // production AP + eclipse hooks instead of compiling disabled uniforms.
        const red = { contours: true, contourColor: '#ff0000', contourOpacity: 1 };
        // Compare fully covered line cores; AA fringes mix with changing terrain light.
        const mask = data => { const result=[]; for(let i=0;i<data.length;i+=4)if(data[i]===255&&data[i+1]===0&&data[i+2]===0)result.push(i);return result; };
        const referenceData=render('optical-reference', red), reference=mask(referenceData);
        ap.uAPPlanetWorldPos.value.copy(center).negate();
        ap.uAPPlanetToWorld.value.makeScale(1000,1000,1000).setPosition(-center.x,-center.y,-center.z);
        ap.uAPWorldToPlanet.value.copy(ap.uAPPlanetToWorld.value).invert();
        ap.uAPCameraWorldPos.value.copy(camera.position); ap.uAPSunWorldPos.value.copy(sun.position);
        ap.uAPPlanetRadius.value=3396190; ap.uAPShellRadius.value=(3396.19+atmosphere.heightKm)*1000;
        ap.uAPStrength.value=1;
        const hazyData=render('active-atmosphere', red), hazy=mask(hazyData);
        shadows.uSunWorldPos.value.copy(sun.position); shadows.uSunRadius.value=100000;
        shadows.uShadowOccluderPos.value[0].copy(sun.position).sub(target).normalize().multiplyScalar(size*5).add(target);
        shadows.uShadowOccluderRadius.value[0]=size*2; shadows.uShadowOccluderCount.value=1;
        const eclipsedData=render('active-atmosphere-eclipse', red), eclipsed=mask(eclipsedData);
        const changed=(a,b)=>{let n=0;for(let i=0;i<a.length;i+=4)if(Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]))>2)n++;return n;};
        const combined = mask(render('active-atmosphere-eclipse-hillshade-elevation', { ...red, hillshade:true, baseColor:'elevation' }));
        result.Mars.opticalComposition={ fixture:'controlled synthetic occluder; actual Mars TIN',
          atmosphereChangedPixels:changed(referenceData,hazyData), eclipseChangedPixels:changed(hazyData,eclipsedData),
          referencePixels:reference.length, atmospherePixels:hazy.length, eclipsePixels:eclipsed.length, combinedPixels:combined.length,
          atmosphereRetainsMask:reference.every(i=>hazy.includes(i)), eclipseRetainsMask:reference.every(i=>eclipsed.includes(i)), combinedRetainsMask:reference.every(i=>combined.includes(i)) };
        ap.uAPStrength.value=0; shadows.uShadowOccluderCount.value=0;
        // Shadow-only synthetic caster tests stock shadow-map receiving;
        // it writes no ordinary color/depth and represents no mission object.
        ambient.intensity=0;
        const shadowReference=render('shadow-map-reference',red), shadowMask=mask(shadowReference);
        const oldSun=sun.position.clone(), oldTarget=sun.target.position.clone();
        const direction=sun.position.clone().sub(target).normalize(); sun.position.copy(target).addScaledVector(direction,size*4);
        sun.target.position.copy(target);scene.add(sun.target);sun.castShadow=true;
        Object.assign(sun.shadow.camera,{left:-size,right:size,top:size,bottom:-size,near:1,far:size*10});sun.shadow.camera.updateProjectionMatrix();
        sun.shadow.mapSize.set(1024,1024);renderer.shadowMap.enabled=true;
        parents.forEach(m=>{m.receiveShadow=true;});
        const caster=new THREE.Mesh(new THREE.BoxGeometry(size*.2,size*.2,size*.2),new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false}));
        caster.position.copy(target).addScaledVector(up,size*.25);caster.castShadow=true;scene.add(caster);
        const mappedData=render('active-shadow-map',red), mappedMask=new Set(mask(mappedData));
        result.Mars.opticalComposition.shadowMapChangedPixels=changed(shadowReference,mappedData);
        result.Mars.opticalComposition.shadowMapRetainsMask=shadowMask.every(i=>mappedMask.has(i));
        caster.removeFromParent();caster.geometry.dispose();caster.material.dispose();sun.castShadow=false;renderer.shadowMap.enabled=false;
        sun.position.copy(oldSun);sun.target.position.copy(oldTarget);ambient.intensity=2;
      }
      if (body === 'Mars') {
        parents.forEach(m => { m.visible = false; });
        children.forEach(m => { m.visible = true; }); render('children', { contours: true });
      }
      for (const factor of [0.25, 1, 4]) {
        camera.position.copy(target).addScaledVector(up, size * factor); camera.lookAt(target); camera.updateMatrixWorld();
        render(`zoom-${factor}`, { contours: true });
      }
      // Restore camera before comparing byte-identical disabled pixels.
      camera.position.copy(target).addScaledVector(up, size * 1.35); camera.lookAt(target); camera.updateMatrixWorld();
      children.forEach(m => { m.visible = false; }); parents.forEach(m => { m.visible = true; });
      const final = render('off-again', {});
      result[body].restored = final.every((v, i) => v === off[i]);
      result[body].heightAttributesAfterDisable = [...parents, ...children].filter(m => m.geometry.hasAttribute('surfaceHeightKm')).length;
      if (upstreamAvailable && body === 'Moon-synthetic-pole') {
        const { wrapTopoLineMaterial } = await import('/work/issue-183/wrapTopoLineMaterial.js');
        for (const mesh of parents) {
          const m = mesh.material; const params = wrapTopoLineMaterial(m, m.onBeforeCompile.bind(m));
          params.ellipsoid.value.setScalar(1737400); params.frame.value.makeTranslation(0, 0, 1737400);
          params.resolution.value.set(800, 600); params.topoColor.value.set('#f2e6c9'); params.cartoOpacity.value = 0;
          m.defines.USE_TOPO_LINES = 1; m.defines.USE_TOPO_ELLIPSOID = 1; m.needsUpdate = true;
        }
        renderer.render(scene, camera);
        result.captures.push({ name: 'upstream-0.4.27-synthetic-smoke', png: renderer.domElement.toDataURL() });
        result.upstreamEvaluated = true;
      }
      group.traverse(m => { if (m.isMesh) { m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach(mat => mat.dispose()); } });
    }
    // A skirt shares its top edge's ground vertices. Render only its faces,
    // positioning that edge inside a pixel so a >= .999 interpolated mask
    // admits a visible strip. The skirt must add no contour pixels at all.
    const skirtGeometry = new THREE.BufferGeometry();
    skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -100, 1000, 0, 100, 1000, 0, -100, 1000, 100, -100, -1000, 0, 100, -1000, 0,
    ], 3));
    skirtGeometry.setIndex([0, 1, 2, 0, 3, 1, 1, 3, 4]);
    skirtGeometry.userData.surfaceTriangles = 1;
    skirtGeometry.setDrawRange(3, 6);
    skirtGeometry.computeVertexNormals();
    const skirtMesh = new THREE.Mesh(skirtGeometry, new THREE.MeshStandardMaterial({ color: '#222222', side: THREE.DoubleSide }));
    const skirtScene = new THREE.Scene(); skirtScene.add(skirtMesh, new THREE.AmbientLight(0xffffff, 2));
    const skirtCamera = new THREE.OrthographicCamera(-110, 110, 1100, -1100, 0.1, 10000);
    skirtCamera.position.z = 1000; skirtCamera.lookAt(0, 0, 0);
    const skirtStyle = new SurfaceAppearance(moon);
    skirtStyle.attach(skirtMesh, new THREE.Matrix4().makeTranslation(0, 1736400, 0));
    function renderSkirt(enabled) {
      skirtStyle.set({ ...defaults, contours: enabled, contourColor: '#ff0000', contourOpacity: 1 });
      skirtStyle.update(Infinity); renderer.render(skirtScene, skirtCamera);
      const pixels = new Uint8Array(800 * 600 * 4); gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      result.captures.push({ name: `skirt-${enabled ? 'on' : 'off'}`, png: renderer.domElement.toDataURL() });
      return pixels;
    }
    const skirtOff = renderSkirt(false), skirtOn = renderSkirt(true);
    result.skirtChangedPixels = 0;
    for (let i = 0; i < skirtOff.length; i += 4) if (skirtOn[i] !== skirtOff[i] || skirtOn[i + 1] !== skirtOff[i + 1] || skirtOn[i + 2] !== skirtOff[i + 2]) result.skirtChangedPixels++;
    skirtGeometry.dispose(); skirtMesh.material.dispose();
    texture.dispose(); renderer.dispose(); return result;
  }, existsSync('work/issue-183/wrapTopoLineMaterial.js'));
  for (const { name, png } of results.captures) await writeFile(`${output}/${name}.png`, Buffer.from(png.split(',')[1], 'base64'));
  delete results.captures;
  results.errors = errors;
  await writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2));
  assert.deepEqual(errors, []);
  assert.ok(results.Mars.opticalComposition.referencePixels > 100);
  assert.ok(results.Mars.opticalComposition.atmosphereChangedPixels > 100, 'active atmosphere must change terrain shading');
  assert.ok(results.Mars.opticalComposition.eclipseChangedPixels > 100, 'active eclipse must change terrain shading');
  assert.ok(results.Mars.opticalComposition.atmosphereRetainsMask);
  assert.ok(results.Mars.opticalComposition.eclipseRetainsMask);
  assert.ok(results.Mars.opticalComposition.combinedRetainsMask);
  assert.ok(results.Mars.opticalComposition.shadowMapChangedPixels > 100, 'stock shadow map must change terrain shading');
  assert.ok(results.Mars.opticalComposition.shadowMapRetainsMask);
  assert.equal(results.skirtChangedPixels, 0, 'Contours must never draw on skirts, including their shared top edge');
  for (const body of ['Mars', 'Moon-synthetic-pole', 'Moon-synthetic-globe']) {
    assert.ok(results[body].changedPixels > 100, JSON.stringify(results));
    assert.ok(results[body].darkContourPixels > 100, JSON.stringify(results));
    assert.ok(results[body].restored, `${body} disabled shader did not restore original pixels`);
    assert.equal(results[body].heightAttributesAfterDisable, 0);
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); await server.close(); }
