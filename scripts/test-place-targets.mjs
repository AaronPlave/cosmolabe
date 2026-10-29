/** Shared named-target state and unified navigation UX; normal viewer + CI. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const base=process.env.CL_VIEWER_URL??'http://127.0.0.1:5194/';
const out=process.env.CL_OUTPUT??'/tmp/planetary-place-targets';await mkdir(out,{recursive:true});
const hardware=process.env.CL_GPU==='hardware';
const browser=await chromium.launch({executablePath:hardware?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined,args:hardware?['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900},...(process.env.CL_RECORD?{recordVideo:{dir:out,size:{width:1440,height:900}}}:{})}),errors=[],checks=[];
page.setDefaultTimeout(45000);
checks.push=(...items)=>{console.log(...items);return Array.prototype.push.apply(checks,items);};
page.on('pageerror',e=>errors.push(e.message));
async function browsePlaces(){const back=page.getByRole('button',{name:'Back to places',exact:true});if(await back.isVisible())await back.click();const button=page.getByRole('button',{name:/^Filters and sort/});if(await button.getAttribute('aria-expanded')==='true')await page.keyboard.press('Escape');}
async function openFilters(){const button=page.getByRole('button',{name:/^Filters and sort/});if(await button.getAttribute('aria-expanded')!=='true')await button.click();}
async function filterOption(locator,value){await openFilters();await locator.selectOption(value);}

try {
  await page.addInitScript(()=>{window.__placeModule=path=>import(performance.getEntriesByType('resource').map(e=>e.name).filter(url=>new URL(url).pathname===path).at(-1)??path);});
  await page.goto(`${base}?catalog=test-catalogs/planetary-places`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.renderer?.placeNames?.index.places.length===11139);
  assert.deepEqual(await page.evaluate(()=>[...window.renderer.placeNames.bodies].sort()),['Mars','Moon']);
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
  assert.equal(await page.evaluate(()=>window.s.vs.flight.target),'Arena Colles');
  await page.waitForFunction(()=>!window.s.vs.flight);
  assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget.place.ref),await page.evaluate(()=>window.arena.ref));checks.push('real name double-click, shared Fly, semantic HUD through landing');
  await page.screenshot({path:`${out}/arena-named-target.png`});
  assert.equal(await page.getByText('Place details',{exact:true}).evaluate(el=>el.closest('details').open),false);
  const initialPanelHeight=await page.locator('.instrument').filter({has:page.getByText('Navigate',{exact:true})}).evaluate(el=>el.getBoundingClientRect().height);
  assert.ok(initialPanelHeight<=451&&initialPanelHeight>=400,`Initial Navigate height: ${initialPanelHeight}`);
  assert.equal(await page.evaluate(()=>window.s.vs.flight?.target ?? window.s.vs.surfaceTarget?.place?.name),'Arena Colles');
  const before=await page.evaluate(()=>({eye:window.renderer.camera.position.toArray(),et:window.s.vs.et,body:window.s.vs.trackedBodyName}));
  await page.getByRole('button',{name:'Clear surface target',exact:true}).click();
  const released=await page.evaluate(()=>({eye:window.renderer.camera.position.toArray(),et:window.s.vs.et,body:window.s.vs.trackedBodyName,target:window.s.vs.surfaceTarget,selected:window.s.vs.selectedPlaceRef,highlight:window.renderer.placeNames.selectedRef,pivot:window.renderer.cameraController.surfaceNavigating}));
  assert.deepEqual(released.eye,before.eye);assert.equal(released.et,before.et);assert.equal(released.body,'Mars');assert.equal(released.target,null);assert.equal(released.selected,null);assert.equal(released.highlight,null);assert.equal(released.pivot,false);checks.push('HUD X releases pivot/highlight without moving eye or changing tracking/time');
  await page.evaluate(()=>{window.p.selectPlace(window.arena);});
  assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget),null);
  await browsePlaces();await page.getByLabel('Search places',{exact:true}).fill('Jezero');
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
  await page.evaluate(()=>window.sh.setFloat('navigate',{x:80,y:70,w:320,h:600},{width:1440,height:900}));
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
  // Focused search owns only the first Escape; later presses reach the target.
  await page.evaluate(()=>window.p.navigateToPlace(window.arena,'jump'));
  const search=page.getByLabel('Search places',{exact:true});await browsePlaces();await search.fill('Arena');
  await page.keyboard.press('Escape');assert.equal(await search.evaluate(el=>el===document.activeElement),false);
  assert.equal(await page.evaluate(()=>window.sh.isToolOpen('navigate')),true);
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget),null);checks.push('focused search Escape blurs, dismisses inspector, then releases target');
  // A default body filter follows tracking; an explicit filter remains intentional.
  await page.evaluate(()=>{window.sh.openTool('navigate');window.s.frameBody('Mars');});
  const bodyFilter=page.getByLabel('Search place body',{exact:true});assert.equal(await bodyFilter.inputValue(),'Mars');
  await page.evaluate(()=>window.s.frameBody('Moon'));assert.equal(await bodyFilter.inputValue(),'Moon');
  await browsePlaces();await search.fill('Shackleton');assert.ok(await page.getByRole('button').filter({hasText:/^ShackletonMoon/}).count());
  await bodyFilter.selectOption('Mars');await page.evaluate(()=>window.s.frameBody('Moon'));assert.equal(await bodyFilter.inputValue(),'Mars');
  checks.push('body filter follows tracking until explicitly selected');
  // Places shares type filtering with Cmd/K and can distinguish mixed origins.
  await browsePlaces();await search.fill('');
  assert.equal(await page.getByRole('button',{name:/^Filters and sort/}).getAttribute('aria-expanded'),'false');
  await page.getByText('Filters and sort',{exact:true}).click();
  const typeFilter=page.getByLabel('Search place type',{exact:true}),originFilter=page.getByLabel('Search place origin',{exact:true});
  await filterOption(typeFilter,'Crater, craters');
  assert.ok(await page.getByRole('list',{name:'Named places'}).getByRole('button').count());
  assert.ok((await page.getByRole('list',{name:'Named places'}).locator('button[aria-pressed]').allTextContents()).every(t=>t.includes('Crater')));
  await browsePlaces();await search.fill('Valles Marineris');assert.ok(await page.getByText('No places match this search and filters.',{exact:true}).count());
  await browsePlaces();await search.fill('');await filterOption(originFilter,'mission/user');
  await page.waitForFunction(()=>document.querySelector('[aria-label="Search place type"]').value==='');
  assert.equal(await page.getByRole('list',{name:'Named places'}).getByRole('button').count(),1);
  assert.match(await page.getByRole('list',{name:'Named places'}).textContent(),/Alpha/);
  await filterOption(originFilter,'nomenclature');assert.doesNotMatch(await page.getByRole('list',{name:'Named places'}).textContent(),/Synthetic Alpha/);
  await filterOption(originFilter,'');await filterOption(typeFilter,'Synthetic site');
  await bodyFilter.selectOption('Moon');await page.waitForFunction(()=>document.querySelector('[aria-label="Search place type"]').value==='');
  await bodyFilter.selectOption('Mars');
  const sortFilter=page.getByLabel('Sort places',{exact:true});
  await filterOption(sortFilter,'name-asc');
  const alphabetical=await page.getByRole('list',{name:'Named places'}).locator('li > button[aria-pressed]').evaluateAll(rows=>rows.map(row=>row.firstElementChild.textContent));
  assert.deepEqual(alphabetical,[...alphabetical].sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:'base',numeric:true})));
  const sortedRefs=await page.evaluate(()=>window.s.vs.places.search('',{body:'Mars',sort:'diameter-desc',limit:100}).map(p=>p.ref));
  await filterOption(sortFilter,'diameter-desc');
  await page.screenshot({path:`${out}/places-filters-expanded.png`});
  const firstLargest=await page.getByRole('list',{name:'Named places'}).getByRole('button').first().textContent();
  assert.ok(firstLargest.includes(await page.evaluate(ref=>window.s.vs.places.byRef.get(ref).name,sortedRefs[0])));assert.match(firstLargest,/≈ .*km across/);
  await filterOption(originFilter,'mission/user');assert.match(await page.getByRole('list',{name:'Named places'}).textContent(),/Diameter unknown/);
  await filterOption(originFilter,'');await filterOption(sortFilter,'relevance');
  await page.keyboard.press('Escape');
  // Every result is reachable; sorting operates on the entire matching catalog.
  await bodyFilter.selectOption('');
  const total=await page.evaluate(()=>window.s.vs.places.places.length);
  assert.ok(await page.getByRole('status').filter({hasText:`${total.toLocaleString()} places`}).count());
  const list=page.locator('ul[aria-label="Named places"]');
  assert.equal(await list.locator('button[aria-pressed]').count(),100);
  await list.evaluate(el=>el.scrollTop=el.scrollHeight);
  await page.waitForFunction(()=>document.querySelectorAll('[aria-label="Named places"] button[aria-pressed]').length>=200);
  // Load the entire Moon catalog through the keyboard-accessible fallback.
  await bodyFilter.selectOption('Moon');await filterOption(sortFilter,'name-asc');await page.keyboard.press('Escape');
  const moonTotal=await page.evaluate(()=>window.s.vs.places.search('',{body:'Moon',limit:'all'}).length);
  while(await list.locator('button[aria-pressed]').count()<moonTotal) {
    await list.locator('li:last-child > button:not([aria-pressed])').evaluate(el=>el.focus({preventScroll:true}));
    await page.keyboard.press('Enter');
  }
  assert.equal(await list.locator('button[aria-pressed]').count(),moonTotal);
  const lastMoon=await page.evaluate(()=>window.s.vs.places.search('',{body:'Moon',sort:'name-asc',limit:'all'}).at(-1).name);
  assert.equal(await list.locator('button[aria-pressed]').last().locator('span').first().textContent(),lastMoon);
  await list.locator('button[aria-pressed]').last().click();
  assert.equal(await page.getByRole('button',{name:/^Filters and sort/}).isVisible(),false);
  assert.equal(await sortFilter.isVisible(),false);
  await page.getByRole('button',{name:'Clear selected place',exact:true}).click();
  await bodyFilter.selectOption('Mars');await filterOption(sortFilter,'relevance');
  await page.keyboard.press('Escape');
  checks.push('all matches reachable beyond 100 through scroll and keyboard, totals shown, final sorted Moon result selectable, filters persist through selection');
  await search.focus();
  const layout=await page.locator('.place-results').evaluate(el=>({panelHeight:el.closest('.instrument').getBoundingClientRect().height,panelWidth:el.closest('.instrument').getBoundingClientRect().width,listHeight:el.clientHeight,dockScrollTop:el.closest('.instrument').parentElement.scrollTop}));
  assert.equal(layout.dockScrollTop,0);assert.ok(layout.listHeight>100);
  await writeFile(`${out}/layout.json`,JSON.stringify(layout,null,2));
  const focusRoom=await search.evaluate(el=>{const b=el.getBoundingClientRect(),c=el.closest('.places-content').getBoundingClientRect();return{left:b.left-c.left,right:c.right-b.right,shadow:getComputedStyle(el).boxShadow};});
  assert.ok(focusRoom.left>=1&&focusRoom.right>=1);assert.notEqual(focusRoom.shadow,'none');
  await page.screenshot({path:`${out}/places-filters-focus.png`});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
  await search.focus();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.ok(await page.getByRole('list',{name:'Named places'}).evaluate(el=>el.clientHeight>30));
  await page.screenshot({path:`${out}/places-filters-focus-compact.png`});
  // Display must open in the desktop dock, not a compact sheet that remounts it.
  await page.setViewportSize({width:1440,height:900});
  await page.waitForFunction(()=>window.sh.shell.layout==='desktop');
  checks.push('body/type/origin filters combine, empty matches explain filters, unavailable types reset, focus ring fits scroll clip');
  // Display names each logical source once; one source toggle affects all chunks.
  await page.evaluate(()=>window.sh.openTool('display'));
  await page.getByText('Name sources',{exact:true}).click();
  assert.equal(await page.getByText(/^Moon Gazetteer /).count(),1);assert.equal(await page.getByText(/^Mars Gazetteer /).count(),1);
  assert.equal(await page.getByText(/Moon places \(\d\/4\)/).count(),0);
  const moonSource=page.getByRole('checkbox',{name:'Show labels for Moon Gazetteer',exact:true});await moonSource.click();
  assert.equal(await page.evaluate(()=>window.s.vs.hiddenPlaceLayers.filter(id=>id.startsWith('moon:usgs:places:')).length),4);await moonSource.click();
  await page.getByText('By body',{exact:true}).click();
  await page.screenshot({path:`${out}/display-desktop.png`});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
  await page.getByText('Name sources',{exact:true}).evaluate(el=>el.closest('details').open=true);
  await page.getByText('Name sources',{exact:true}).evaluate(el=>{el.closest('.instrument-body').scrollTop=185;});
  await page.screenshot({path:`${out}/display-compact.png`});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1440,height:900});await page.waitForFunction(()=>window.sh.shell.layout==='desktop');await page.evaluate(()=>window.sh.closeTool('display'));
  checks.push('logical Gazetteer source toggle groups all four Moon chunks; desktop and compact Display');
  // The master explains disabled datasets while retaining separate body intent.
  await page.evaluate(()=>window.sh.openTool('display'));
  await page.getByText('Name sources',{exact:true}).evaluate(el=>el.closest('details').open=true);
  const sourceLabels=page.locator('details').filter({has:page.getByText('Name sources',{exact:true})}).locator('[role="checkbox"][aria-label^="Show labels for"]');
  for(const checkbox of await sourceLabels.all()) await checkbox.setChecked(false);
  assert.ok(await page.getByText('Geographic labels hidden; names remain searchable',{exact:true}).isVisible());
  const hiddenBeforeMaster=await page.evaluate(()=>[...window.s.vs.hiddenPlaceLayers]);
  const namesMaster=page.getByRole('checkbox',{name:'Geographic names',exact:true});
  await namesMaster.setChecked(false);
  assert.deepEqual(await page.evaluate(()=>window.s.vs.hiddenPlaceLayers),hiddenBeforeMaster);
  await namesMaster.setChecked(true);
  assert.ok(await page.getByText('Geographic labels hidden; names remain searchable',{exact:true}).isVisible());
  await page.screenshot({path:`${out}/display-no-sources.png`});

  await page.getByRole('checkbox',{name:'Show labels for Moon Gazetteer',exact:true}).click();
  assert.equal(await page.getByText('Geographic labels hidden; names remain searchable',{exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>window.s.vs.hiddenPlaceLayers.filter(id=>id.startsWith('moon:usgs:places:')).length),0);
  assert.ok(await page.evaluate(()=>window.s.vs.hiddenPlaceLayers.length>0));
  await namesMaster.setChecked(false);
  assert.ok(await page.getByText('Geographic labels hidden; names remain searchable',{exact:true}).isVisible());
  for(const checkbox of await sourceLabels.all()) await checkbox.setChecked(true);
  await namesMaster.setChecked(true);
  await page.evaluate(()=>window.sh.closeTool('display'));
  checks.push('hidden-but-searchable status; master preserves hidden datasets; logical Moon restoration and mixed/body-off states');

  // Exercise real clipboard -> Coordinates for both Mars hemispheres, using
  // every common view preset; compare actual camera eyes and orientations.
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  for(const [name,preset,range] of [['Jezero','overhead',''],['Hellas','oblique','200'],['Jezero','surface','100']]) {
    await page.evaluate(async({name,preset,range})=>{
      window.nv=await window.__placeModule('/src/lib/navigation-view.svelte.ts');
      window.nv.navigationView.preset=preset;window.nv.navigationView.rangeText=range;window.nv.navigationView.framing=(range ? 'custom' : 'auto');
      const p=window.s.vs.places.search(name,{body:'Mars'}).find(p=>p.name===name);if(!p)throw new Error('Missing '+name);
      window.testPlace=p;window.p.selectPlace(p);window.s.vs.navigateMode='places';
    },{name,preset,range});
    await page.getByRole('button',{name:'Jump to',exact:true}).click();
    const named=await page.evaluate(()=>({eye:window.renderer.camera.position.toArray(),q:window.renderer.camera.quaternion.toArray()}));
    await page.getByRole('button',{name:'Copy coordinates',exact:true}).click();
    const copied=await page.evaluate(()=>navigator.clipboard.readText());assert.match(copied,name==='Hellas'?/° S/:/° N/);
    const displayed=await page.locator('span[title^="Planetocentric latitude"]').textContent();assert.match(displayed,name==='Hellas'?/° S/:/° N/);
    await page.locator('[aria-label="Navigate mode"]').getByText(/^coordinates$/i).click();
    await page.locator('form select').selectOption('Mars');
    await page.locator('input[aria-describedby="navigate-conventions navigate-status"]').fill(copied);
    await page.getByRole('button',{name:'Jump to',exact:true}).click();
    const coord=await page.evaluate(()=>({eye:window.renderer.camera.position.toArray(),q:window.renderer.camera.quaternion.toArray()}));
    for(const key of ['eye','q'])for(let i=0;i<named[key].length;i++)assert.ok(Math.abs(named[key][i]-coord[key][i])<1e-6,`${name} ${preset} ${key}: ${JSON.stringify({named,coord})}`);
    // The same configured Fly must end at that same view as Jump.
    await page.evaluate(()=>window.s.frameBody('Mars'));
    await page.getByRole('button',{name:'Fly to',exact:true}).click();await page.waitForFunction(()=>!window.s.vs.flight);
    const flown=await page.evaluate(()=>window.renderer.camera.position.toArray());for(let i=0;i<3;i++)assert.ok(Math.abs(flown[i]-coord.eye[i])<1e-6);
    await page.locator('[aria-label="Navigate mode"]').getByText(/^places$/i).click();
    await page.evaluate(()=>{window.s.frameBody('Mars');window.p.selectPlace(window.testPlace);});
    await page.getByRole('button',{name:'Fly to',exact:true}).click();
    await page.waitForFunction(()=>!!window.s.vs.flight);assert.equal(await page.evaluate(()=>window.s.vs.flight.target),name);
    await page.waitForFunction(()=>!window.s.vs.flight);
    const namedFly=await page.evaluate(()=>window.renderer.camera.position.toArray());for(let i=0;i<3;i++)assert.ok(Math.abs(namedFly[i]-coord.eye[i])<1e-6);
  }
  checks.push('north/south Mars clipboard round trip; Places and Coordinates Jump/Fly equivalent for overhead, oblique and surface');
  for(const [preset,range] of [['surface','100'],['oblique','invalid'],['overhead','8000']]) {
    const expected=await page.evaluate(({preset,range})=>{
      window.nv.navigationView.preset=preset;window.nv.navigationView.rangeText=range;window.nv.navigationView.framing=(range ? 'custom' : 'auto');
      const c=window.arena.feature.geometry.coordinates;
      window.s.goToCoordinates({bodyName:'Mars',...c,latitude:'planetographic',longitudeDirection:'east'},{preset:'overhead',animate:false});
      const expected={eye:window.renderer.camera.position.toArray(),q:window.renderer.camera.quaternion.toArray()};
      window.s.frameBody('Moon'); // retained manual range can belong to another body
      window.s.goToCoordinates({bodyName:'Mars',...c,latitude:'planetographic',longitudeDirection:'east'},{preset:'overhead',animate:false,rangeKm:200});
      window.p.selectPlace(window.arena);
      return expected;
    },{preset,range});
    const label=page.locator('.cl-place-name').filter({hasText:'Arena Colles'});
    await page.waitForFunction(()=>[...document.querySelectorAll('.cl-place-name')].some(el=>el.textContent==='Arena Colles'&&Number(el.style.opacity)>.6));
    const b=await label.boundingBox();await page.mouse.dblclick(b.x+b.width/2,b.y+b.height/2,{delay:60});
    await page.waitForFunction(()=>!!window.s.vs.flight);await page.waitForFunction(()=>!window.s.vs.flight);
    const actual=await page.evaluate(()=>({eye:window.renderer.camera.position.toArray(),q:window.renderer.camera.quaternion.toArray(),preset:window.nv.navigationView.preset,range:window.nv.navigationView.rangeText}));
    for(const key of ['eye','q'])for(let i=0;i<expected[key].length;i++)assert.ok(Math.abs(expected[key][i]-actual[key][i])<1e-6,`Viewport ${preset}/${range}: ${key}`);
    assert.equal(actual.preset,preset);assert.equal(actual.range,range);
  }
  checks.push('actual viewport label double-click ignores Surface/100m, invalid input and another body range, preserves form choices, lands at automatic overhead');

  await page.evaluate(()=>{window.nv.navigationView.preset='overhead';window.nv.navigationView.rangeText='';window.nv.navigationView.framing='auto';window.p.navigateToPlace(window.arena,'jump');});
  await browsePlaces();await search.fill('');
  await page.screenshot({path:`${out}/navigate-desktop.png`});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);await page.screenshot({path:`${out}/navigate-compact.png`});
  await page.setViewportSize({width:1440,height:900});
  await page.locator('[aria-label="Navigate mode"]').getByText(/^coordinates$/i).click();
  await page.locator('input[aria-describedby="navigate-conventions navigate-status"]').fill(await page.evaluate(()=>window.p.placeCoordinates(window.arena)));
  await page.screenshot({path:`${out}/coordinates-desktop.png`});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);await page.screenshot({path:`${out}/coordinates-compact.png`});
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{for(const id of new Set(window.s.vs.places.places.map(p=>p.layer.id)))window.p.showPlaceDataset(id,false);});
  await page.evaluate(async()=>{const {loadCatalogUrl}=await window.__placeModule('/src/lib/loader.ts');await loadCatalogUrl(window.renderer.renderer.domElement,new URL('test-catalogs/planetary-places.json',location.href).href);});
  await page.waitForFunction(()=>window.renderer?.placeNames.index.places.length===11139);
  assert.equal(await page.evaluate(()=>window.s.vs.surfaceTarget),null);assert.equal(await page.evaluate(()=>window.s.vs.selectedPlaceRef),null);assert.deepEqual(await page.evaluate(()=>window.s.vs.hiddenPlaceLayers),[]);
  await page.evaluate(()=>window.sh.openTool('display'));assert.equal(await page.getByText('Geographic labels hidden; names remain searchable',{exact:true}).count(),0);await page.evaluate(()=>window.sh.closeTool('display'));
  checks.push('scene reload clears named target and resets disabled-source state');
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
      window.nv.navigationView.preset='overhead';window.nv.navigationView.rangeText='30';window.nv.navigationView.framing='custom';
      const r=window.renderer,place=r.placeNames.index.search('Shackleton',{body:'Moon'}).find(p=>p.name==='Shackleton');window.p.navigateToPlace(place,'jump');
      const revisions=new Set();
      for(let i=0;i<360;i++){await new Promise(requestAnimationFrame);if(window.s.vs.surfaceTarget?.place?.ref!==place.ref)throw new Error('Named target lost during terrain refinement');revisions.add(r.getBodyMesh('Moon').terrainRevision);}
      const hit=r.pickScene(r.renderer.domElement.clientWidth/2,r.renderer.domElement.clientHeight/2,'probe');
      return{revisions:[...revisions],source:hit?.kind==='surface'?hit.point.source:null};
    },url);
    assert.equal(terrain.source,'terrain');assert.ok(terrain.revisions.length>1);checks.push(`named target survives real terrain refinement (${terrain.revisions.length} revisions)`);
    await page.screenshot({path:`${out}/named-terrain.png`});
  }
  const gpu=await page.evaluate(()=>{const gl=window.renderer.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};});
  await writeFile(`${out}/gpu.json`,JSON.stringify(gpu,null,2));
  const latency=await page.evaluate(()=>{
    const cases=[['all-name',{sort:'name-asc'}],['all-name-desc',{sort:'name-desc'}],['all-diameter',{sort:'diameter-desc'}],['all-smallest',{sort:'diameter-asc'}],['all-relevance',{sort:'relevance',activeBody:'Mars'}],['moon-craters',{body:'Moon',kind:'Crater, craters',sort:'name-asc'}],['prefix',{query:'mon',sort:'name-asc'}]];
    return cases.map(([name,{query='',...opts}])=>{
      const times=[];let count=0;
      for(let i=0;i<50;i++){const start=performance.now();count=window.s.vs.places.search(query,{...opts,limit:'all'}).length;if(i>=10)times.push(performance.now()-start);}
      times.sort((a,b)=>a-b);return{name,count,p95Ms:times[Math.ceil(times.length*.95)-1],maxMs:times.at(-1)};
    });
  });
  await writeFile(`${out}/search-latency.json`,JSON.stringify(latency,null,2));
  if(hardware)assert.ok(latency.every(c=>c.p95Ms<100),JSON.stringify(latency));
  checks.push(`full Gazetteer query/filter/sort p95: ${latency.map(c=>`${c.name} ${c.p95Ms.toFixed(1)}ms`).join(', ')}`);
  assert.deepEqual(errors,[]);
} catch (error) { await page.screenshot({path:`${out}/failure.png`}); throw error; } finally {await writeFile(`${out}/results.json`,JSON.stringify({checks,errors},null,2));await browser.close();}
console.log(JSON.stringify({checks,errors},null,2));
