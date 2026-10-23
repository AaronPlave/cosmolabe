/** Focused browse/inspect UX and shared inclusion policy in the actual viewer. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const base=process.env.CL_VIEWER_URL??'http://127.0.0.1:5194/',out=process.env.CL_OUTPUT??'/tmp/place-inspector';await mkdir(out,{recursive:true});
const hardware=process.env.CL_GPU==='hardware';const browser=await chromium.launch({executablePath:hardware?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined,args:hardware?['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900},...(process.env.CL_RECORD?{recordVideo:{dir:out,size:{width:1440,height:900}}}:{})});page.setDefaultTimeout(30000);const checks=[],errors=[],layouts=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.__placeModule=path=>import(performance.getEntriesByType('resource').map(e=>e.name).filter(url=>new URL(url).pathname===path).at(-1)??path);});
async function assertScrollbarInside(locator) {
 const geometry=await locator.evaluate(el=>{const rect=el.getBoundingClientRect();let clipRight=rect.right;for(let parent=el.parentElement;parent;parent=parent.parentElement){if(/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowX))clipRight=Math.min(clipRight,parent.getBoundingClientRect().right);if(getComputedStyle(parent).position==='fixed')break;}return{right:rect.right,clipRight,scrolls:el.scrollHeight>el.clientHeight};});
 assert.ok(geometry.right<=geometry.clipRight+.5,`scrollbar extends outside ancestor clip: ${JSON.stringify(geometry)}`);
 return geometry;
}
try {
 await page.goto(`${base}?catalog=test-catalogs/planetary-places`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.renderer?.placeNames?.index.places.length===11139);
 await page.evaluate(async()=>{window.s=await window.__placeModule('/src/lib/viewer-state.svelte.ts');window.p=await window.__placeModule('/src/lib/places.ts');window.sh=await window.__placeModule('/src/lib/shell.svelte.ts');window.nv=await window.__placeModule('/src/lib/navigation-view.svelte.ts');window.cosmo.setPlaying(false);window.site=window.p.searchPlaces('Valles Marineris')[0];window.p.navigateToPlace(window.site,'jump');});
 assert.equal(await page.getByLabel('Search places',{exact:true}).isVisible(),false);
 await page.getByRole('button',{name:'Fit feature',exact:true}).click();assert.equal(await page.getByLabel('Custom altitude (km)',{exact:true}).inputValue(),await page.evaluate(()=>String(window.site.diameterKm*1.5)));
 await page.getByRole('button',{name:'Auto',exact:true}).click();assert.equal(await page.getByLabel('Custom altitude (km)',{exact:true}).inputValue(),'');
 await page.getByText('Place details',{exact:true}).click();
 for(const h of [340,720]) {
  await page.evaluate(h=>window.sh.setFloat('navigate',{x:70,y:30,w:288,h},{width:innerWidth,height:innerHeight}),h);
  const metrics=await page.getByRole('button',{name:'Fly to',exact:true}).evaluate(el=>{const panel=el.closest('.instrument'),b=el.getBoundingClientRect(),p=panel.getBoundingClientRect();return{h:p.height,actionBottom:b.bottom,panelBottom:p.bottom,bodyScroll:panel.querySelector('.instrument-body').scrollTop,outerScroll:panel.querySelector('.places-content').scrollTop,inspectorOverflow:panel.querySelector('.inspector-scroll').scrollHeight>panel.querySelector('.inspector-scroll').clientHeight};});
  assert.ok(metrics.actionBottom<metrics.panelBottom);assert.equal(metrics.bodyScroll,0);assert.equal(metrics.outerScroll,0);layouts.push(metrics);
  await assertScrollbarInside(page.locator('.inspector-scroll'));
  await page.screenshot({path:`${out}/inspect-${h}.png`});
 }
 await page.getByRole('button',{name:'Back to places',exact:true}).click();assert.ok(await page.evaluate(()=>window.s.vs.surfaceTarget?.place));
 await page.getByLabel('Search place body',{exact:true}).selectOption('');
 await page.getByRole('button',{name:/^Filters and sort/}).click();
 const typeSelect=page.getByLabel('Search place type',{exact:true});
 await typeSelect.selectOption(await typeSelect.evaluate(el=>[...el.options].filter(o=>o.value).sort((a,b)=>b.text.length-a.text.length)[0].value));
 await page.getByLabel('Search place origin',{exact:true}).selectOption('nomenclature');await page.getByLabel('Sort places',{exact:true}).selectOption('diameter-desc');await page.keyboard.press('Escape');
 for(const width of [240,288,420]) {
  await page.evaluate(w=>window.sh.setFloat('navigate',{x:70,y:30,w,h:500},{width:innerWidth,height:innerHeight}),width);
  const metrics=await page.getByRole('button',{name:/^Filters and sort/}).evaluate(el=>{const label=el.querySelector('span'),summary=label.nextElementSibling,b=el.getBoundingClientRect(),l=label.getBoundingClientRect(),s=summary.getBoundingClientRect();return{overflow:el.scrollWidth>el.clientWidth,labelHeight:l.height,lineHeight:parseFloat(getComputedStyle(label).lineHeight),within:s.right<=b.right,summaryWidth:s.width,fullSummary:el.title};});
  assert.equal(metrics.overflow,false);assert.ok(metrics.labelHeight<=metrics.lineHeight+1);assert.ok(metrics.within);assert.ok(metrics.summaryWidth>0);assert.match(metrics.fullSummary,/Official names.*Largest first/);
  await page.screenshot({path:`${out}/filters-active-${width}.png`});
 }
 checks.push('multiple active filters and sort stay within narrow panels, label remains on one line, full summary available in tooltip');
 await page.getByRole('button',{name:/^Filters and sort/}).click();await typeSelect.selectOption('');await page.getByLabel('Search place origin',{exact:true}).selectOption('');await page.keyboard.press('Escape');
 await page.getByLabel('Search place body',{exact:true}).selectOption('Mars');const search=page.getByLabel('Search places',{exact:true});await search.fill('');
 await page.getByRole('button',{name:/^Filters and sort/}).click();await page.getByLabel('Sort places',{exact:true}).selectOption('name-asc');
 await page.screenshot({path:`${out}/browse-filters.png`});await page.keyboard.press('Escape');
 const list=page.locator('.place-results');await assertScrollbarInside(list);await list.evaluate(el=>el.scrollTop=800);const before=await list.evaluate(el=>el.scrollTop);
 await list.locator('button[aria-pressed]').nth(20).click();assert.equal(await search.isVisible(),false);await page.getByRole('button',{name:'Back to places',exact:true}).click();assert.equal(await list.evaluate(el=>el.scrollTop),before);
 assert.ok((await page.getByRole('button',{name:/^Filters and sort/}).textContent()).includes('Name A–Z'));checks.push('focused inspector, discoverable framing, pinned actions, single scroll owner, retained browse filters and scroll');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await assertScrollbarInside(list);await page.screenshot({path:`${out}/browse-compact.png`});
 await page.evaluate(()=>window.p.selectPlace(window.site));await page.getByText('Place details',{exact:true}).click();await assertScrollbarInside(page.locator('.inspector-scroll'));await page.screenshot({path:`${out}/inspect-compact.png`});checks.push('browse and inspector scrollbar tracks remain inside ancestor clipping bounds in floating and compact panels');
 const footer=await page.getByRole('button',{name:'Fly to',exact:true}).evaluate(el=>({button:el.getBoundingClientRect().bottom,panel:el.closest('.instrument').getBoundingClientRect().bottom}));assert.ok(footer.button<footer.panel);checks.push('390x844 inspector and browse remain within sheet, actions visible with expanded details');
 await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>{window.sh.dockPanel('navigate');window.sh.openTool('display');});await page.getByText('Name sources',{exact:true}).click();
 const showMoon=page.getByRole('checkbox',{name:'Show labels for Moon Gazetteer',exact:true}),includeMoon=page.getByRole('checkbox',{name:'Include Moon Gazetteer',exact:true});
 await showMoon.setChecked(false);assert.ok(await page.evaluate(()=>window.p.searchPlaces('Shackleton').length));
 async function cmdkCount(){await page.keyboard.press('Control+k');await page.getByPlaceholder('Search places, bodies, commands...').fill('Shackleton');const n=await page.getByRole('option').filter({hasText:'Shackleton'}).count();await page.keyboard.press('Escape');return n;}
 assert.ok(await cmdkCount());await page.evaluate(()=>window.p.navigateToPlace(window.p.searchPlaces('Shackleton')[0],'jump'));const eye=await page.evaluate(()=>window.renderer.camera.position.toArray());await includeMoon.setChecked(false);
 assert.equal(await page.evaluate(()=>window.p.searchPlaces('Shackleton').length),0);assert.equal(await cmdkCount(),0);assert.equal(await page.evaluate(()=>window.s.vs.selectedPlaceRef),null);assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget),null);assert.deepEqual(await page.evaluate(()=>window.renderer.camera.position.toArray()),eye);
 await includeMoon.setChecked(true);assert.ok(await cmdkCount());assert.equal(await showMoon.isChecked(),false);assert.equal(await page.evaluate(()=>window.s.vs.excludedPlaceLayers.filter(id=>id.startsWith('moon:')).length),0);
 await page.getByRole('checkbox',{name:'Include Mars Gazetteer',exact:true}).setChecked(false);assert.ok(await page.evaluate(()=>window.p.searchPlaces('Alpha').length));assert.equal(await page.evaluate(()=>window.p.searchPlaces('Jezero').length),0);await page.getByRole('checkbox',{name:'Include Mars Gazetteer',exact:true}).setChecked(true);
 await page.screenshot({path:`${out}/source-inclusion.png`});checks.push('UI source inclusion affects Cmd-K and Places, hiding labels stays searchable, target/selection reconcile without moving camera, multiple same-body sources independent');
 const unlinked=await page.evaluate(async()=>{const {getUniverse}=await window.__placeModule('/src/lib/loader.ts');const u=getUniverse(),site=window.p.searchPlaces('Shackleton')[0],owner=site.layer.source.catalog;window.p.navigateToPlace(site,'jump');const loads=u.geographicLayers.loads.filter(l=>l.layer?.source.catalog===owner);if(!owner||loads.length!==4)throw new Error('Expected logical Moon catalog owner');u.geographicLayers.removeCatalog(owner);u.events.emit('geographic:changed',{});const removed=window.p.searchPlaces('Shackleton').length,target=window.s.vs.surfaceTarget,selected=window.s.vs.selectedPlaceRef;u.geographicLayers.replaceCatalog(owner,loads);u.events.emit('geographic:changed',{});return{removed,target,selected,restored:window.p.searchPlaces('Shackleton').length};});
 assert.equal(unlinked.removed,0);assert.equal(unlinked.target,null);assert.equal(unlinked.selected,null);assert.ok(unlinked.restored);assert.ok(await cmdkCount());checks.push('actual geographic catalog unlink/relink rebuilds both search surfaces and reconciles active state');
 assert.deepEqual(errors,[]);
} catch(error){await page.screenshot({path:`${out}/failure.png`});throw error;}
finally{await writeFile(`${out}/results.json`,JSON.stringify({checks,layouts,errors},null,2));await browser.close();}
console.log(JSON.stringify({checks,layouts,errors},null,2));
