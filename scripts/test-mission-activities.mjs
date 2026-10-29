/** Native timeline acceptance, including local-first Vite dataset fallback. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://127.0.0.1:5193/';
const out = process.argv[3] ?? 'work/issue-293';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless:true,
  ...(process.platform === 'darwin' ? { executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args:[process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport:{width:1440,height:900} });
page.setDefaultTimeout(30000);
const results = { cases:[], errors:[], failedRequests:[], httpErrors:[] };
page.on('pageerror', e => results.errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) results.httpErrors.push({url:r.url(),status:r.status()}); });
page.on('requestfailed', r=>results.failedRequests.push({url:r.url(),error:r.failure()?.errorText}));
const fixture = JSON.parse(await readFile('apps/viewer/test-catalogs/fixtures/mission-activities.json','utf8'));
const stress = { name:'Activity stress fixture', defaultTime:fixture.defaultTime, items:fixture.items,
  activities:Array.from({length:10000}, (_,i)=>({...fixture.activities[0], id:`stress:${i}`, name:`Stress flight ${i}`, start:672089519.3+i*2, end:672089529.3+i*2})) };

await page.route('**/test-catalogs/activity-stress.json', route => route.fulfill({json:stress}));
async function liveModule(name) {
  return page.evaluate(async name=>{
    const url=performance.getEntriesByType('resource').map(r=>r.name).find(url=>new URL(url).pathname.endsWith('/src/lib/'+name));
    if(!url)throw new Error('Live module unavailable: '+name);
    return url;
  },name);
}
async function load(catalog, count) {
  if (page.url()==='about:blank') await page.goto(`${base}?catalog=test-catalogs/${catalog}`, { waitUntil:'domcontentloaded' });
  else {
    const loaderUrl = await liveModule('loader.ts');
    await page.evaluate(async ({catalog,loaderUrl})=>{
      const loader=await import(loaderUrl);
      const canvas=window.renderer.renderer.domElement;
      await loader.loadCatalogUrl(canvas,new URL(`test-catalogs/${catalog}.json`,location.href).href,catalog);
    },{catalog,loaderUrl});
  }
  await page.waitForFunction(n=>window.cosmo?.listActivities?.().length === n, count, {timeout:120000});
  await page.evaluate(()=>window.cosmo.setPlaying(false));
}
async function expanded() {
  const button = page.getByRole('button',{name:'Expand timeline',exact:true});
  if (await button.count()) await button.click();
}
try {
  for (const [catalog, count] of [['ingenuity-jezero',72],['moonfall-shackleton',24],['msl-dingo-gap',2],['fixtures/mission-activities',4]]) {
    console.log('Loading',catalog);
    await load(catalog,count);
    await expanded();
    const state = await page.evaluate(()=>({ids:window.cosmo.listActivities().map(a=>a.id),gpu:(()=>{const gl=window.renderer.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return {vendor:gl.getParameter(gl.VENDOR),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),antialias:gl.getContextAttributes().antialias};})()}));
    await page.evaluate(()=>window.cosmo.setLayer('trajectories',false));
    assert.equal(await page.evaluate(()=>window.cosmo.listActivities().length),count);
    const chooser = page.locator('select[aria-label^="Choose"]').first();
    const id = await chooser.locator('option:not([disabled])').first().getAttribute('value');
    await chooser.selectOption(id);
    assert.equal(await page.evaluate(()=>window.cosmo.getSelectedActivity()?.id),id);
    const selected = await page.evaluate(()=>window.cosmo.getSelectedActivity());
    assert.equal(await page.evaluate(()=>window.cosmo.getTime()),selected.start);
    await expanded();
    console.log('After select', await page.locator('select[aria-label^="Choose"]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))));
    const nextButton = page.getByRole('button',{name:/^Next (activity|flight|hop|drive|descent|landing)$/}).first();
    if (await nextButton.isEnabled()) {
      await nextButton.click();
      assert.notEqual(await page.evaluate(()=>window.cosmo.getSelectedActivity()?.id),id);
      const stateUrl = await liveModule('viewer-state.svelte.ts');
      assert.ok(await page.evaluate(async url => {
        const {vs} = await import(url), a = window.cosmo.getSelectedActivity();
        return vs.scrubMin <= a.start && vs.scrubMax >= a.end && vs.scrubMax - vs.scrubMin <= Math.max(60, a.end-a.start)*2;
      }, stateUrl), 'Navigation fits the new activity');
      await page.getByRole('button',{name:/^Previous (activity|flight|hop|drive|descent|landing)$/}).first().click();
      assert.equal(await page.evaluate(()=>window.cosmo.getSelectedActivity()?.id),id);
    }
    await page.evaluate(()=>{const a=window.cosmo.getSelectedActivity(); window.cosmo.seekActivity(a.id,'end');});
    assert.equal(await page.evaluate(()=>window.cosmo.getTime()),selected.end);
    await page.getByRole('button',{name:`Window ${selected.name}`,exact:true}).click();
    const lane = page.getByRole('button',{name:`Go to ${selected.name}`,exact:true});
    await lane.scrollIntoViewIfNeeded();
    await lane.click();
    assert.equal(await page.evaluate(()=>window.cosmo.getTime()),selected.start);
    if(catalog==='fixtures/mission-activities') {
      const analysisUrl=await liveModule('analysis.svelte.ts');
      await page.evaluate(async analysisUrl=>{
        const a=await import(analysisUrl);
        const q=a.createConfiguredEventQuery({kind:'closest-approach',bodies:{observer:'Aircraft',target:'Rover'}},'Fixture approach');
        a.setEventResults(q.id,[{id:'fixture:event',queryId:q.id,kind:'closest-approach',temporality:'instant',et:672089540,label:'Synthetic closest approach',bodies:{observer:'Aircraft',target:'Rover'}}]);
        a.createConfiguredProfile({quantity:'range',bodies:{observer:'Aircraft',target:'Rover'}},'Fixture range');
      },analysisUrl);
      const eventUrl = await liveModule('event-finder.svelte.ts');
      const stateUrl = await liveModule('viewer-state.svelte.ts');
      const cleanup = await page.evaluate(async ({eventUrl,stateUrl,id}) => {
        const ef = await import(eventUrl), {vs} = await import(stateUrl);
        ef.selectEvent({id:'fixture:event',queryId:'fixture-query',kind:'closest-approach',temporality:'instant',et:672089540,label:'Synthetic closest approach',bodies:{observer:'Aircraft',target:'Rover'}});
        const before = [...vs.highlightedBodies], time = window.cosmo.getTime(), target = vs.selectedBodyName;
        window.cosmo.selectActivity(id);
        return {before,after:[...vs.highlightedBodies],timeUnchanged:time===window.cosmo.getTime(),targetUnchanged:target===vs.selectedBodyName};
      },{eventUrl,stateUrl,id});
      assert.ok(cleanup.before.length>0);
      assert.deepEqual(cleanup.after,[]);
      assert.ok(cleanup.timeUnchanged && cleanup.targetUnchanged);
      assert.ok(await page.locator('[data-tl-row^="lane:event-query"]').count());
      assert.ok(await page.locator('[data-tl-row^="profile:"]').count());
    }
    assert.equal(await page.locator('.activity-facts').count(),0);
    if(catalog==='msl-dingo-gap') {
      assert.ok(await page.locator('.activity-mark.bounded').count());
      assert.ok(await page.getByRole('region',{name:'Selected event',exact:true}).innerText().then(t=>t.includes('duration unknown')));
    }
    await page.screenshot({path:`${out}/${catalog.split('/').at(-1)}-desktop.png`});
    await page.setViewportSize({width:390,height:844});
    await page.waitForTimeout(350); // Responsive shell replaces the dock after resize.
    await page.locator('select[aria-label^="Choose"]').first().scrollIntoViewIfNeeded();
    await page.locator('select[aria-label^="Choose"]').first().focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.screenshot({path:`${out}/${catalog.split('/').at(-1)}-390.png`});
    const geometry = await page.evaluate(()=>({
      pageWidth:document.documentElement.scrollWidth, viewport:innerWidth,
      region:document.querySelector('.lane-region')?.getBoundingClientRect().height,
      pageScroll:document.documentElement.scrollTop,
    }));
    assert.ok(geometry.pageWidth<=geometry.viewport);
    await page.getByRole('button',{name:'Collapse timeline',exact:true}).click();
    assert.equal(await page.locator('select[aria-label="Choose activity"]').count(),1);
    await page.screenshot({path:`${out}/${catalog.split('/').at(-1)}-compact-390.png`});
    if(catalog==='fixtures/mission-activities') {
      await page.evaluate(()=>{window.cosmo.setTimeRate(10);window.cosmo.setPlaying(true);});
      results.baseline = await page.evaluate(async()=>{
        const times=[];let last=performance.now();
        for(let i=0;i<120;i++){await new Promise(requestAnimationFrame);const now=performance.now();times.push(now-last);last=now;}
        times.sort((a,b)=>a-b);window.cosmo.setPlaying(false);
        return {records:4,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:times[Math.floor(times.length*.95)]};
      });
    }
    results.cases.push({catalog,count,ids:state.ids,gpu:state.gpu,geometry});
    await page.setViewportSize({width:1440,height:900});
  }
  await page.setViewportSize({width:1440,height:900});
  await load('activity-stress',10000);
  await expanded();
  const aggregate = page.getByRole('button',{name:/^Zoom into \d+ activities$/}).first();
  assert.ok(await aggregate.count());
  const stateUrl = await liveModule('viewer-state.svelte.ts');
  const beforeBin = await page.evaluate(async url=>{const {vs}=await import(url);return {span:vs.scrubMax-vs.scrubMin,time:vs.et,id:window.cosmo.getSelectedActivity()?.id??null};},stateUrl);
  await aggregate.click();
  const afterBin = await page.evaluate(async url=>{const {vs}=await import(url);return {span:vs.scrubMax-vs.scrubMin,time:vs.et,id:window.cosmo.getSelectedActivity()?.id??null};},stateUrl);
  assert.ok(afterBin.span < beforeBin.span);
  assert.equal(afterBin.time,beforeBin.time);
  assert.equal(afterBin.id,beforeBin.id);
  await page.getByRole('searchbox',{name:'Search Aircraft flight'}).fill('Stress flight 9999');
  await page.getByRole('combobox',{name:'Choose flight'}).selectOption('stress:9999');
  assert.equal(await page.evaluate(()=>window.cosmo.getSelectedActivity()?.id),'stress:9999');
  await page.evaluate(()=>{window.cosmo.seekActivity('stress:0');window.cosmo.setTimeRate(10);window.cosmo.setPlaying(true);});
  results.performance = await page.evaluate(async()=>{
    const samples=[];let last=performance.now();
    for(let i=0;i<120;i++) {await new Promise(requestAnimationFrame);const now=performance.now();samples.push(now-last);last=now;}
    samples.sort((a,b)=>a-b);window.cosmo.setPlaying(false);
    return {records:window.cosmo.listActivities().length,meanMs:samples.reduce((a,b)=>a+b,0)/samples.length,p95Ms:samples[Math.floor(samples.length*.95)],marks:document.querySelectorAll('.activity-mark').length,options:document.querySelectorAll('select[aria-label="Choose flight"] option').length};
  });
  assert.ok(results.performance.marks<=200);
  assert.ok(results.performance.options<=202);
  await page.screenshot({path:`${out}/stress-desktop.png`});
  assert.equal(results.errors.length,0,results.errors.join('\n'));
  const assetErrors=results.httpErrors.filter(r=>/\/test-catalogs\/(data|kernels)\//.test(new URL(r.url).pathname));
  assert.deepEqual(assetErrors,[], 'Managed assets must load through the native Vite fallback');
  console.log('Mission activity browser acceptance passed');
} catch (error) {
  await page.screenshot({path:`${out}/failure.png`});
  console.log(await page.locator('body').innerText());
  throw error;
} finally {
  await writeFile(`${out}/browser.json`,JSON.stringify(results,null,2)+'\n');
  await browser.close();
}
