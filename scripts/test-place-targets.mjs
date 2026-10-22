/** Shared named-target state and unified navigation UX; normal viewer + CI. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const base=process.env.CL_VIEWER_URL??'http://127.0.0.1:5194/';
const out=process.env.CL_OUTPUT??'/tmp/planetary-place-targets';await mkdir(out,{recursive:true});
const hardware=process.env.CL_GPU==='hardware';
const browser=await chromium.launch({executablePath:hardware?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined,args:hardware?['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900},...(process.env.CL_RECORD?{recordVideo:{dir:out,size:{width:1440,height:900}}}:{})}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
try {
  await page.addInitScript(()=>{window.__placeModule=path=>import(performance.getEntriesByType('resource').map(e=>e.name).filter(url=>new URL(url).pathname===path).at(-1)??path);});
  await page.goto(`${base}?catalog=test-catalogs/planetary-places`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.renderer?.placeNames?.index.places.length===11139);
  await page.evaluate(async()=>{
    await window.renderer.waitForInitialAssets();window.cosmo.setPlaying(false);
    window.s=await window.__placeModule('/src/lib/viewer-state.svelte.ts');window.p=await window.__placeModule('/src/lib/places.ts');window.sh=await window.__placeModule('/src/lib/shell.svelte.ts');
    window.arena=window.renderer.placeNames.index.search('Arena Colles',{body:'Mars'}).find(p=>p.name==='Arena Colles');
    if(!window.arena)throw new Error('Missing real Arena Colles');
    window.p.showPlaceBody('Mars',true);
    window.p.navigateToPlace(window.arena,'jump');
    const pos=window.arena.feature.geometry.coordinates;
    window.s.goToCoordinates({bodyName:'Mars',latDeg:pos.latDeg,lonDeg:pos.lonDeg,latitude:'planetographic',longitudeDirection:'east'},{animate:false,rangeKm:200});
    window.p.selectPlace(window.arena);
    for(const tool of window.sh.TOOL_IDS)window.sh.closeTool(tool);
  });
  await page.waitForFunction(()=>[...document.querySelectorAll('.cl-place-name')].some(e=>e.textContent==='Arena Colles'&&Number(e.style.opacity)>.6));
  const box=await page.locator('.cl-place-name').filter({hasText:'Arena Colles'}).boundingBox();
  await page.mouse.dblclick(box.x+box.width/2,box.y+box.height/2,{delay:60});
  await page.waitForFunction(()=>window.s.vs.surfaceTarget?.place?.name==='Arena Colles'&&!!window.s.vs.flight);
  assert.ok(await page.locator('.named-target').getByText('Arena Colles',{exact:true}).count());
  assert.match(await page.locator('.target-value').getAttribute('title'),/Arena Colles.*Mars/);
  await page.waitForFunction(()=>!window.s.vs.flight);
  assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget.place.ref),await page.evaluate(()=>window.arena.ref));checks.push('real name double-click, shared Fly, semantic HUD through landing');
  await page.screenshot({path:`${out}/arena-named-target.png`});
  assert.equal(await page.getByText('Source & technical details',{exact:true}).evaluate(el=>el.closest('details').open),false);
  assert.equal(await page.getByText('About this place',{exact:true}).evaluate(el=>el.closest('details').open),false);
  const before=await page.evaluate(()=>({eye:window.renderer.camera.position.toArray(),et:window.s.vs.et,body:window.s.vs.trackedBodyName}));
  await page.getByRole('button',{name:'Clear surface target',exact:true}).click();
  const released=await page.evaluate(()=>({eye:window.renderer.camera.position.toArray(),et:window.s.vs.et,body:window.s.vs.trackedBodyName,target:window.s.vs.surfaceTarget,selected:window.s.vs.selectedPlaceRef,highlight:window.renderer.placeNames.selectedRef,pivot:window.renderer.cameraController.surfaceNavigating}));
  assert.deepEqual(released.eye,before.eye);assert.equal(released.et,before.et);assert.equal(released.body,'Mars');assert.equal(released.target,null);assert.equal(released.selected,null);assert.equal(released.highlight,null);assert.equal(released.pivot,false);checks.push('HUD X releases pivot/highlight without moving eye or changing tracking/time');
  await page.evaluate(()=>{window.p.selectPlace(window.arena);});
  assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget),null);
  await page.getByLabel('Search places',{exact:true}).fill('Jezero');
  await page.getByRole('button').filter({hasText:/^JezeroMars/}).first().click();
  assert.match(await page.evaluate(()=>window.s.vs.places.byRef.get(window.s.vs.selectedPlaceRef).name),/^Jezero/);checks.push('in-panel names search and selection without navigation');
  await page.evaluate(()=>{window.p.navigateToPlace(window.arena,'fly');});
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!window.s.vs.flight);
  assert.ok(await page.evaluate(()=>window.s.vs.surfaceTarget?.place));
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.sh.isToolOpen('navigate')),false);
  assert.ok(await page.evaluate(()=>window.s.vs.surfaceTarget));
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget),null);assert.equal(await page.evaluate(()=>window.s.vs.selectedPlaceRef),null);
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.s.vs.et),before.et);checks.push('Escape sequence stops flight, closes inspector, releases named target, then resets camera');
  await page.evaluate(()=>window.p.selectPlace(window.arena));await page.keyboard.press('Escape');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.s.vs.selectedPlaceRef),null);checks.push('selected-only Escape dismisses inspection');
  await page.evaluate(()=>{window.p.navigateToPlace(window.arena,'jump');window.p.selectPlace(null);});
  assert.equal(await page.evaluate(()=>window.renderer.placeNames.selectedRef),await page.evaluate(()=>window.arena.ref));
  assert.ok(await page.evaluate(()=>window.s.vs.surfaceTarget?.place));
  await page.evaluate(()=>{window.s.releaseSurfaceTarget();window.p.navigateToPlace(window.arena,'jump');const p=window.arena.feature.geometry.coordinates;window.s.goToCoordinates({bodyName:'Mars',...p,latitude:'planetographic',longitudeDirection:'east'},{animate:false});});
  assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget.place??null),null);assert.equal(await page.evaluate(()=>window.s.vs.selectedPlaceRef),null);checks.push('inspector clear preserves active target; generic replacement clears named association');
  await page.evaluate(()=>{window.p.navigateToPlace(window.arena,'jump');const next=window.renderer.placeNames.index.search('Jezero',{body:'Mars'}).find(p=>p.name==='Jezero');window.p.navigateToPlace(next,'jump');});
  assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget.place.name),'Jezero');
  const picked=await page.evaluate(()=>{const r=window.renderer;const hit=r.pickScene(r.renderer.domElement.clientWidth/2,r.renderer.domElement.clientHeight/2,'probe');return hit?.kind==='surface'&&window.s.navigateToSurfacePoint(hit.point,{animate:false,from:'click',verb:'zoom'});});assert.equal(picked,true);assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget.place??null),null);checks.push('different named target and actual picked surface replacement');
  await page.evaluate(()=>{window.p.navigateToPlace(window.arena,'jump');window.s.frameBody('Moon');});await page.waitForFunction(()=>!window.s.vs.surfaceTarget&&!window.s.vs.selectedPlaceRef);checks.push('other-body navigation clears target and selection');
  await page.evaluate(()=>{window.p.navigateToPlace(window.arena,'jump');window.sh.openTool('navigate');window.s.vs.navigateMode='coordinates';});
  await page.locator('input[aria-describedby="navigate-conventions navigate-status"]').fill('24.88 N, 82.93 E');
  await page.getByRole('button',{name:'Terrain source and datum',exact:true}).click();await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(()=>window.s.vs.surfaceTarget?.place));checks.push('popover Escape preserves active target');
  await page.locator('[aria-label="Navigate mode"]').getByText(/^places$/i).click();
  await page.evaluate(()=>window.sh.setFloat('navigate',{x:80,y:70,width:320,height:600},{width:1440,height:900}));
  await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.sh.isFloating('navigate')),true);
  await page.evaluate(()=>{window.sh.minimizePanel('navigate');window.sh.openTool('navigate');window.sh.dockPanel('navigate');});
  assert.equal(await page.evaluate(()=>window.sh.isFloating('navigate')),false);checks.push('Navigate floats, minimizes, reopens and docks');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  assert.equal(await page.getByRole('button',{name:/^Places$/}).count(),0);
  await page.screenshot({path:`${out}/navigate-compact.png`});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);checks.push('one Navigate entry, compact places mode without page overflow');
  await page.setViewportSize({width:1440,height:900});
  await page.keyboard.press('Control+k');await page.getByPlaceholder('Search places, bodies, commands...').fill('Shackleton');
  await page.getByRole('option').filter({hasText:'Shackleton'}).first().click();
  assert.equal(await page.evaluate(()=>window.s.vs.places.byRef.get(window.s.vs.selectedPlaceRef).name),'Shackleton');
  assert.match(await page.locator('.font-mono').filter({hasText:/89.6700/}).first().textContent(),/89.6700° S/);checks.push('Cmd/Ctrl K selection and correct southern hemisphere display');
  await page.evaluate(async()=>{const {loadCatalogUrl}=await window.__placeModule('/src/lib/loader.ts');await loadCatalogUrl(window.renderer.renderer.domElement,new URL('test-catalogs/planetary-places.json',location.href).href);});
  await page.waitForFunction(()=>window.renderer?.placeNames.index.places.length===11139);
  assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget),null);assert.equal(await page.evaluate(()=>window.s.vs.selectedPlaceRef),null);checks.push('scene reload clears named target');
  if(process.env.CL_TERRAIN) {
    const url=`${base}named-terrain.json`;
    await page.route(url,async route=>{
      const scene=JSON.parse(await readFile('apps/viewer/test-catalogs/geographic-vectors-shackleton-terrain.json','utf8'));
      scene.require=[`${base}test-catalogs/places/moon.json`];scene.geographicLayers=[];
      for(const item of scene.items)if(item.geometry?.terrain){item.geometry.terrain.url=`${base}test-catalogs/${item.geometry.terrain.url}`;if(item.geometry.terrain.cubeSphere)item.geometry.terrain.cubeSphere.cpuGrids=`${base}test-catalogs/${item.geometry.terrain.cubeSphere.cpuGrids}`;}
      await route.fulfill({json:scene});
    });
    const terrain=await page.evaluate(async url=>{
      const {loadCatalogUrl}=await window.__placeModule('/src/lib/loader.ts');await loadCatalogUrl(window.renderer.renderer.domElement,url);
      const r=window.renderer,place=r.placeNames.index.search('Shackleton',{body:'Moon'}).find(p=>p.name==='Shackleton');window.p.navigateToPlace(place,'jump');
      const revisions=new Set();
      for(let i=0;i<360;i++){await new Promise(requestAnimationFrame);if(window.s.vs.surfaceTarget?.place?.ref!==place.ref)throw new Error('Named target lost during terrain refinement');revisions.add(r.getBodyMesh('Moon').terrainRevision);}
      const hit=r.pickScene(r.renderer.domElement.clientWidth/2,r.renderer.domElement.clientHeight/2,'probe');
      return{revisions:[...revisions],source:hit?.kind==='surface'?hit.point.source:null};
    },url);
    assert.equal(terrain.source,'terrain');assert.ok(terrain.revisions.length>1);checks.push(`named target survives real terrain refinement (${terrain.revisions.length} revisions)`);
    await page.screenshot({path:`${out}/named-terrain.png`});
  }
  assert.deepEqual(errors,[]);
} finally {await writeFile(`${out}/results.json`,JSON.stringify({checks,errors},null,2));await browser.close();}
console.log(JSON.stringify({checks,errors},null,2));
