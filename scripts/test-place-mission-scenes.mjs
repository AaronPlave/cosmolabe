/** Shared Gazetteer composition in shipped mission scenes; no substituted catalogs. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const base=process.env.CL_VIEWER_URL??'http://127.0.0.1:5194/';
const out=process.env.CL_OUTPUT??'/tmp/place-mission-scenes';await mkdir(out,{recursive:true});
const hardware=process.env.CL_GPU==='hardware';
const browser=await chromium.launch({executablePath:hardware?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined,args:hardware?['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900},...(process.env.CL_RECORD?{recordVideo:{dir:out,size:{width:1440,height:900}}}:{})});
page.setDefaultTimeout(60000);const results=[];let sceneErrors=[];page.on('pageerror',e=>sceneErrors.push(e.message));
await page.addInitScript(()=>{window.__placeModule=path=>import(performance.getEntriesByType('resource').map(e=>e.name).filter(url=>new URL(url).pathname===path).at(-1)??path);});
try {
  for(const [catalog,body,name,mission] of [
    ['moonfall-shackleton','Moon','Shackleton','MoonFall base (synthetic)'],
    ['lro-moon','Moon','Shackleton',null],
    ['moon-imagery-apollo15','Moon','Hadley','Apollo 15 landing site'],
    ['msl-dingo-gap','Mars','Gale','Dingo Gap overlay anchor'],
    ['ingenuity-jezero','Mars','Jezero','Wright Brothers Field'],
    ['mars-imagery-jezero','Mars','Jezero',null],
  ]) {
    sceneErrors=[];await page.goto(`${base}?catalog=test-catalogs/${catalog}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(body=>window.renderer?.placeNames?.index.places.some(p=>p.layer.body===body),body);
    const result=await page.evaluate(async({body,name,mission})=>{
      const s=await window.__placeModule('/src/lib/viewer-state.svelte.ts'),p=await window.__placeModule('/src/lib/places.ts'),nv=await window.__placeModule('/src/lib/navigation-view.svelte.ts');
      window.cosmo.setPlaying(false);nv.navigationView.preset='overhead';nv.navigationView.rangeText='';nv.navigationView.framing='auto';
      const found=p.searchPlaces(name,{body}).find(p=>p.name===name)??p.searchPlaces(name,{body})[0];
      if(!found)throw new Error(`Missing ${name}`);
      if(!p.navigateToPlace(found,'jump'))throw new Error(`Navigation failed: ${name}`);
      const officialTarget=s.vs.surfaceTarget?.place?.name;
      let missionRef=null;
      if(mission){nv.navigationView.rangeText='20';nv.navigationView.framing='custom';const site=p.searchPlaces(mission,{body}).find(p=>p.name===mission);if(!site||site.origin!=='mission/user')throw new Error(`Missing distinct mission site ${mission}`);if(!p.navigateToPlace(site,'jump'))throw new Error(`Mission navigation failed: ${mission}`);missionRef=site.ref;}
      for(let i=0;i<180;i++)await new Promise(requestAnimationFrame);
      const c=window.renderer.camera.position;
      return{body,indexedBodies:[...new Set(s.vs.places.places.map(p=>p.layer.body))],count:s.vs.places.places.length,enabledBodies:[...s.vs.placeBodies],officialTarget,missionRef,target:s.vs.surfaceTarget?.place,failures:s.vs.placeFailures,camera:[c.x,c.y,c.z],labels:document.querySelectorAll('.cl-place-name').length,surface:s.vs.surfaceTarget?.surface,terrainReady:!!window.renderer.getBodyMesh(body)?.hasTerrain};
    },{body,name,mission});
    assert.deepEqual(result.indexedBodies,[body]);assert.deepEqual(result.enabledBodies,[body]);assert.deepEqual(result.failures,[]);assert.ok(result.target);assert.ok(result.camera.every(Number.isFinite));assert.ok(result.labels<150);assert.ok(result.count>=(body==='Moon'?9087:2051));
    results.push({catalog,...result,errors:sceneErrors});console.log(catalog,JSON.stringify(result));
    await page.screenshot({path:`${out}/${catalog}.png`});
  }
} catch(error){await page.screenshot({path:`${out}/failure.png`});throw error;}
finally{await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));await browser.close();}
