/** Persistent natural-language Ask UI control for #363. Haiku only; paid inference opt-in. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createProxy, anthropicProvider } from '../examples/ask-proxy/server.mjs';
assert.equal(process.env.ASK_ANALYSIS_LIVE, '1');
assert.ok(process.env.ANTHROPIC_API_KEY);
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5200/';
const model = 'claude-haiku-5-5', usage = [];
const output = process.env.ASK_ANALYSIS_REPORT ?? '/tmp/ask-analysis-transfer.json';
const cases = [
  { id:'ingenuity', catalog:'ingenuity-jezero', analytical:true, objects:['Ingenuity'], views:[], prompts:[
    'show me when ingenuity is at max elevation across all flights',
    'Use height above the Mars reference ellipsoid across all flights, and show me.',
    'show me',
  ] },
  { id:'moonfall', catalog:'moonfall-shackleton', analytical:true, objects:['Polaris-A','Polaris-B','Polaris-C','Polaris-D'], views:[], prompts:[
    'show me the highest radial height above the Moon reference sphere across all Polaris hops',
    'show me',
  ] },
  { id:'height-heldout', catalog:'ingenuity-jezero', analytical:true, objects:['Ingenuity'], views:[], prompts:[
    'Across all Ingenuity flights, which had the lowest height above the reference ellipsoid? Show me.',
  ] },
  { id:'height-unavailable', catalog:'rosetta', analytical:true, limited:true, objects:['Philae'], views:[], prompts:[
    'Find Philae maximum physical terrain clearance over 2014-11-12 08:35:40 to 16:00:00 UTC and show me.',
  ] },
  { id: 'rosetta', catalog: 'rosetta', objects: ['Rosetta','Philae'], views: ['Philae first touchdown, Agilkia (2014-11-12)', 'Philae separation (2014-11-12)'], prompts: [
    'show me when philae lander touched down on 67p',
    'show me the moment rosetta and philae separated (for philae descent to 67p)',
    'use a distance calc between rosetta and philae to figure it out',
    'go to the min',
  ] },
  { id: 'cassini', catalog: 'cassini-soi', objects: ['Cassini','Titan'], views: ['Huygens Landing (2005-01-14)'], prompts: [
    'show me Huygens landing on Titan',
    'How did the distance between Cassini and Titan change around then?',
    'go to the smallest distance you sampled',
  ] },
  { id: 'heldout', catalog: 'rosetta', objects: ['Rosetta','Mars'], views: ['Mars swing-by (2007-02-25)'], prompts: [
    'Show the authored Mars swing-by view.',
    "How did Rosetta's distance from Mars change around that time?",
    'Take me to the smallest of those samples.',
  ] },
];
const report = { model, fallback: false, renderer: 'Chromium SwiftShader', cache: 'warmth uncontrolled', runs: [] };
const proxy = createProxy({ apiKey: process.env.ANTHROPIC_API_KEY, origins: [new URL(base).origin], provider: anthropicProvider, model, escalationModel: model, fallback: false, maxTokens: 1536, tokenBudget: 1200000, costBudgetUsd: 1, perMinute: 100, cache: true,
  fetchImpl: (url, options) => { const body = JSON.parse(options.body); assert.equal(body.model, model); assert.equal(body.fallbacks, undefined); return fetch(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) }); },
  onUsage: row => { assert.equal(row.model, model); assert.equal(row.requestedModel, model); usage.push(row); console.log(`Haiku completed: ${row.inputTokens+row.cacheReadTokens+row.cacheWriteTokens+row.outputTokens} processed tokens`); },
});
await new Promise(resolve => proxy.listen(8797, '127.0.0.1', resolve));
const launchBrowser = () => chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  for (const scenario of cases.filter(c => !process.env.ASK_ANALYSIS_CASE || process.env.ASK_ANALYSIS_CASE.split(',').includes(c.id))) {
    const browser=await launchBrowser();
    const context=await browser.newContext({viewport:{width:1400,height:900}});
    await context.addInitScript(()=>{localStorage.clear();sessionStorage.clear();});
    const page = await context.newPage();
    page.on('response', response => { if (response.url() === 'http://127.0.0.1:8797/') console.log(`${scenario.id}: proxy HTTP ${response.status()}`); });
    page.on('pageerror', e => console.error(`${scenario.id}: browser ${e.message}`));
    const start = usage.length, payloads = new Map(); let rounds = 0, runRecord = null;
    page.on('request', request => {
      if (request.url() !== 'http://127.0.0.1:8797/' || request.method() !== 'POST') return;
      const wire = request.postDataJSON(); rounds++;
      for (const m of wire.messages) for (const b of m.content) if (b.type === 'tool_result') payloads.set(b.toolUseId, b.content);
      console.log(`${scenario.id}: round ${rounds}`);
    });
    const loading = setInterval(() => { page.evaluate(() => document.body.innerText.match(/Loading kernels\s+(\d+\s*\/\s*\d+)/)?.[1] ?? null).then(progress => { if (progress) console.log(`${scenario.id}: kernels ${progress}`); }).catch(() => {}); }, 15000);
    try {
      console.log(`${scenario.id}: loading ${scenario.catalog}`);
      await page.goto(new URL(`?catalog=test-catalogs/${scenario.catalog}`, base).href, { timeout: 120000, waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 600000, polling: 100 });
      await page.evaluate(async () => {
        window.cosmo.setPlaying(false);
        const resource = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path);
        window.__analysisShell = await import(resource('/src/lib/shell.svelte.ts'));
        const store = await import(resource('/src/lib/ask/ask.svelte.ts'));
        window.__analysisAsk = store.ask;
      });
      clearInterval(loading);
      await page.waitForFunction(() => window.__analysisShell.isToolAvailable('ask'), null, { polling: 100 });
      await page.evaluate(() => window.__analysisShell.openTool('ask'));
      await page.bringToFront();
      console.log(`${scenario.id}: scene ready`);
      const run = { id: scenario.id, catalog: scenario.catalog, turns: [] }; report.runs.push(run); runRecord = run;
      await page.evaluate(() => { window.__interactionEvents = []; for (const name of ['cameraInput','flightEnd','time','playback']) window.cosmo.on(name,e => window.__interactionEvents.push({name,...e})); });
      let historyPoints = [], heightWinner = null;
      for (const [turnIndex,prompt] of scenario.prompts.entries()) {
        const before = usage.length, roundStart = rounds;
        const turnCount=await page.evaluate(()=>window.__analysisAsk.turns.length);
        await page.getByRole('textbox', {name:'Request',exact:true}).fill(prompt);
        await page.getByRole('button', {name:'Send request',exact:true}).click();
        await page.waitForFunction(({turnCount,prompt}) => window.__analysisAsk.turns.length>turnCount && window.__analysisAsk.turns.at(-1).prompt===prompt && !window.__analysisAsk.running, {turnCount,prompt}, {timeout:900000});
        const result = await page.evaluate(scenario => {
          const t = window.__analysisAsk.turns.at(-1), c = window.cosmo;
          return {prompt:t.prompt,status:t.status,answer:t.reply,error:t.error,verification:t.result,steps:t.steps,
            state:{et:c.getTime(),playing:c.isPlaying(),tracked:c.getTracked(),selected:c.getSelected(),camera:c.getCamera(),composition:c.getViewComposition(scenario.objects),authored:scenario.views.map(v=>c.getViewpointInfo(v)),context:scenario.objects.map(n=>c.getObjectContext(n)),event:c.getEventVisualization(),viewer:c.getViewerState(),profiles:c.listProfiles().items.map(p=>c.getProfile(p.id))},events:window.__interactionEvents.splice(0)};
        }, scenario);
        const row = {...result,rounds:rounds-roundStart,tokens:usage.slice(before).reduce((n,r)=>n+r.inputTokens+r.cacheReadTokens+r.cacheWriteTokens+r.outputTokens,0)};
        row.checks = [];
        const check = (name, valid, detail = null) => row.checks.push({name,pass:!!valid,...(detail ? {detail} : {})});
        const name = step => step.name === 'invokeCapability' ? step.input.id.split('.').at(-1) : step.name.split('.').at(-1);
        check('useful answer without provider/runtime failure', row.status === 'done' && !!row.answer && !row.error);
        check('no synthetic/manual camera takeover during UI submission', !row.events.some(e=>e.name==='cameraInput'));
        for (const step of row.steps.filter(s=>s.result?.data)) check(`model received ${name(step)}`, payloads.has(step.id) && !payloads.get(step.id).includes('result-too-large'));
        if (scenario.analytical) {
          const tasks = row.steps.filter(s=>name(s)==='analyzeTrajectoryExtrema' && s.result?.ok).map(s=>s.result.data);
          const task = tasks.at(-1);
          check('bounded native executions', tasks.filter(t=>t.started).length <= 1);
          check('no repeated expert configuration', row.steps.filter(s=>name(s)==='findTrajectoryExtrema').length === 0);
          if (scenario.id==='ingenuity' && turnIndex===0) {
            check('one precise measurement clarification', /\?|which|do you mean|choose|height basis/i.test(row.answer) && /ellipsoid|reference|terrain|AGL/i.test(row.answer));
            check('ambiguous metric never executed', !tasks.some(t=>t.started));
          } else if (scenario.limited) {
            check('useful early unsupported/data-limited explanation', /unavailable|unsupported|cannot|can.t|no compatible|not available|not supported|lack/i.test(row.answer));
            check('no collection winner or fabricated navigation', !task?.winnerId && !row.steps.some(s=>name(s)==='navigateToAnalysisResult' && s.result?.ok));
            check('not misdescribed as absent surface geometry', !/no (?:surface model|physical geometry|DSK)|surface model (?:is |was )?(?:absent|missing)/i.test(row.answer));
          } else {
            if (task?.winner || task?.candidate) {
              heightWinner=task.winner??task.candidate;
              check('every requested activity evaluated', task.comparedCount===task.scope.requested);
              check('partial collection never names a full-scope winner', task.status==='complete' ? task.scope.requested===task.scope.completed && task.winnerId : !task.winnerId && task.coverage.incompleteIntervals>0 && /partial|gap|incomplet|available|unresolved|not.*(?:global|winner|certif)/i.test(row.answer));
              const independent=await page.evaluate(async scenario=> {
                const url=performance.getEntriesByType('resource').map(e=>e.name).find(url=>new URL(url).pathname==='/src/lib/analysis.svelte.ts');
                const a=await import(url), c=window.cosmo;
                const results=Object.values(a.analysis.eventResults).flat().filter(e=>e.trajectoryAnalysis).map(e=>e.trajectoryAnalysis);
                const activities=c.listActivities().filter(a=>a.enabled!==false && scenario.objects.includes(a.vehicle) && a.kind===(scenario.id==='moonfall'?'hop':'flight'));
                return {results,activityIds:activities.map(a=>a.id)};
              },scenario);
              check('all native activity IDs compared', independent.activityIds.length===task.scope.requested && independent.activityIds.every(id=>independent.results.some(r=>r.activityId===id)));
              const rank=independent.results.reduce((a,b)=>(task.parameters.metric && (scenario.id==='height-heldout'?b.value<a.value:b.value>a.value))?b:a);
              check('native comparison winner agrees', rank.id===heightWinner.id && Math.abs(rank.value-heightWinner.value)<1e-9);
              // Direct shared query is an independent numerical control, not an Ask tool substitute.
              const measured=await page.evaluate(async winner=> {
                const state=window.cosmo.getObjectState(winner.object,{center:winner.body,frame:winner.frame,time:{kind:'et',et:winner.et}});
                const resource=performance.getEntriesByType('resource').map(e=>e.name).find(url=>new URL(url).pathname.endsWith('/packages/core/src/index.ts'));
                const core=await import(resource);
                return winner.datum.kind==='sphere'?Math.hypot(...state.position)-winner.datum.radiusKm:core.bodyFixedToGeodetic({xKm:state.position[0],yKm:state.position[1],zKm:state.position[2]},{referenceShape:winner.datum,verticalDatum:'ellipsoid',heightConvention:'geodetic-normal'}).heightKm;
              },heightWinner);
              check('actual native position agrees with height', Math.abs(measured-heightWinner.value)<1e-6);
              check('answer reports sampled/source limitation', /sample|refin|uncertain|reconstruct|estimated|synthetic|not.*certif/i.test(row.answer));
            }
            check('numerical result retained', !!heightWinner);
            check('measured result shown at exact native epoch', heightWinner && Math.abs(row.state.et-heightWinner.et)<1e-6 && !row.state.playing && row.state.selected===heightWinner.object && row.state.tracked===heightWinner.object);
            check('measured activity/event selected', heightWinner && row.state.event.selected?.id===heightWinner.id);
            if (turnIndex>0 && scenario.id!=='ingenuity' || turnIndex===2) check('follow-up reuses native result', !tasks.some(t=>t.started));
          }
          check('within bounded model rounds', row.rounds <= 6);
          check('no false manual takeover claim', !/(?:you|person|user) (?:moved|changed|took over)/i.test(row.answer) || row.events.some(e=>e.name==='cameraInput'||e.name==='time'&&e.cause==='viewer'));
        } else if (turnIndex < scenario.views.length) {
          const view = row.state.authored[turnIndex];
          check('authored view actually applied', row.steps.some(s=>name(s)==='viewpoint' && s.result?.ok));
          check('exact authored epoch held', view && row.state.et === view.epoch && !row.state.playing);
          check('authored pose still matches after native frames', view?.navigation.poseMatches);
          check('answer distinguishes authored source', /authored|catalog|annotation/i.test(row.answer));
          check('no numeric extremum substituted for authored event', !row.steps.some(s=>/findClosestApproach|runEventQuery|sampleProfileData/.test(name(s))));
        } else if (turnIndex === scenario.prompts.length-2) {
          const reads = row.steps.flatMap(step => {
            const data = step.result?.data;
            if (!step.result?.ok) return [];
            if (data?.quantity === 'range' && Array.isArray(data.samples)) return data.samples.filter(p=>p.value!==null).map(p=>({...p,id:data.id,bodies:data.bodies}));
            if (Array.isArray(data?.position) && typeof data.et === 'number') return [{et:data.et,value:Math.hypot(...data.position),object:(step.input.input??step.input).object,center:data.center}];
            return [];
          });
          historyPoints = reads.sort((a,b)=>a.et-b.et);
          check('numerical distance history', new Set(reads.map(p=>p.et)).size >= 3);
          check('method preserved history investigation', !row.steps.some(s=>/findClosestApproach|runEventQuery/.test(name(s))));
          for (const p of reads) {
            const actual = await page.evaluate(p => p.id ? window.cosmo.getProfileValue(p.id,p.et).minimum?.value : Math.hypot(...window.cosmo.getObjectState(p.object,{center:p.center,time:{kind:'et',et:p.et}}).position),p);
            check('independent native distance agrees', Math.abs(actual-p.value)<1e-7);
          }
          check('sampled history does not certify physical event', !/\b(?:true|verified|confirmed) (?:separation|release|touchdown) (?:is|lies|was|occurred)/i.test(row.answer));
        } else {
          const minimum = historyPoints.reduce((a,b)=>b.value<a.value?b:a,{value:Infinity});
          check('prior numerical sample exists', Number.isFinite(minimum.et));
          // Tiny equal-distance roundoff does not distinguish a plateau sample;
          // every accepted destination must still be an exact returned epoch.
          const chosen = historyPoints.find(p=>Math.abs(p.et-row.state.et)<1e-6 && Math.abs(p.value-minimum.value)<1e-6);
          check('explicit minimum navigation uses an exact prior sample ET', chosen && !row.state.playing, {requestedMinimumEt:minimum.et,observedEt:row.state.et});
          check('no fabricated selected Event Finder result', !row.state.event.selected);
          const assessed = new Set(row.steps.filter(s=>s.result?.ok).flatMap(s=>{ const data = s.result.data; const v = name(s)==='getViewComposition' ? data : data?.composition; return v?.fresh !== false ? v?.objects?.map(o=>o.object)??[] : []; }));
          const hidden = row.state.composition.objects.some(o=>!o.drawEnabled||!o.inView||o.occlusion?.kind==='full' && o.occlusion?.basis!=='model-bounds');
          check('visibility assessed or accurately limited', scenario.objects.every(n=>assessed.has(n)) || hidden && /hidden|occlu|before|not (?:visible|shown|in view)|not.{0,16}drawn|cannot|can.t|unconfirmed/i.test(row.answer));
        }
        await page.screenshot({path:`/tmp/ask-conversation-${scenario.id}-${turnIndex+1}.png`});
        run.turns.push(row); writeFileSync(output,JSON.stringify(report,null,2)+'\n');
        console.log(JSON.stringify({prompt,answer:row.answer,status:row.verification.status,rounds:row.rounds,tokens:row.tokens,failed:row.checks.filter(c=>!c.pass)}));
      }
    } catch (e) {
      const diagnostic = await Promise.race([page.evaluate(() => ({ scene: window.cosmo?.getScene(), flight: window.cosmo?.getFlight(), turns: window.__analysisAsk?.turns.map(t => ({status:t.status,reply:t.reply,steps:t.steps.map(s => ({name:s.name,result:!!s.result}))})), requestVisible: !!document.querySelector('[aria-label=\"Request\"]'), stopVisible: !!document.querySelector('[aria-label=\"Stop request\"]') })), new Promise(resolve => setTimeout(() => resolve({unresponsive:true}),3000))]).catch(() => ({closed:true}));
      if (runRecord) Object.assign(runRecord, { error: String(e), diagnostic });
      else report.runs.push({ ...scenario, rounds, error: String(e), diagnostic }); console.error(`${scenario.id}: ${e}`); console.log(JSON.stringify(diagnostic));
    }
    finally { clearInterval(loading); writeFileSync(output, JSON.stringify(report,null,2)+'\n'); await page.close(); await browser.close(); }
  }
} finally { await new Promise(resolve => proxy.close(resolve)); }
if (report.runs.some(r => r.error || r.turns?.some(t=>t.checks.some(c=>!c.pass)))) process.exitCode = 1;
