/** #297: real default Ask planner → shared controls → observed state.
 * Explicitly opt in to paid public-scene inference; never reads a user's catalog.
 * Start the viewer with VITE_ASK_ENDPOINT=http://127.0.0.1:8798.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { etToDate } from '../packages/core/dist/index.js';
import { createProxy, anthropicProvider } from '../examples/ask-proxy/server.mjs';

assert.equal(process.env.ASK_MISSION_LIVE, '1', 'Set ASK_MISSION_LIVE=1 to authorize paid public-scene inference');
assert.ok(process.env.ANTHROPIC_API_KEY, 'Configured Anthropic key required');
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5797/';
const output = process.env.ASK_MODERN_OUTPUT ?? '/tmp/297-ask-modern';
mkdirSync(output, { recursive: true });
const usage = [], model = process.env.ASK_MODEL ?? anthropicProvider.defaultModel;
const proxy = createProxy({ apiKey: process.env.ANTHROPIC_API_KEY, origins: [new URL(base).origin],
  provider: anthropicProvider, model, maxTokens: 1536, perMinute: 100,
  tokenBudget: Number(process.env.ASK_TEST_TOKEN_BUDGET ?? 1000000), costBudgetUsd: 3, cache: true, onUsage: row => usage.push(row) });
await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(8798, '127.0.0.1', resolve); });
const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const report = { model, cache: 'sequential; cache warmth uncontrolled; USD is a proxy estimate, not billing', runs: [] };
const scenarios = [
  { id: 'psyche-earth', catalog: 'psyche', prompt: 'show me all psyche flybys of earth' },
  { id: 'psyche-mars', catalog: 'psyche', prompt: 'show me the one where psyche is closest to mars' },
  { id: 'voyager', catalog: 'voyagers', prompt: 'show me when voyager 1 flew past jupiter' },
  { id: 'cassini', catalog: 'cassini-soi', prompt: 'show cassini at closest approach to mimas' },
  { id: 'ingenuity', catalog: 'ingenuity-jezero', prompt: 'Show Flight 5 at Airfield B, pause at its end and frame Ingenuity. Save a visible centre-to-centre distance measurement from Ingenuity to Mars called flight5-distance. Turn on Mars hillshade with the blue-gold elevation palette, and enable the highest-resolution Jezero imagery available separately. Keep elevation coloring as the final base color, with that imagery layer enabled for later use. Explain the estimated timing and that centre distance is not terrain clearance.' },
  { id: 'instrument-capture', catalog: 'cassini-soi', prompt: 'Select the ISS NAC synthetic instrument feed and inspect its pointing limitations. Then close the feed, save this camera as Ask verification, frame Mimas, and restore Ask verification. After assets readiness succeeds with a bounded wait, capture a screenshot named ask-approved-capture.' },
  { id: 'geographic', catalog: 'geographic-vectors', prompt: 'Inspect the editable annotation layer I just created by copying a shape in the UI. Tell me how many features it contains, and delete its first feature using the original typed source ID. Request approval for the deletion.' },
];
const selected = process.env.ASK_SCENARIOS?.split(',');
const modes = process.env.ASK_MODES?.split(',') ?? ['fixed', 'discovery'];
async function state(page) {
  return page.evaluate(() => {
    const c = window.cosmo, turn = window.__askSmoke.turns.at(-1);
    return { status: turn.status, error: turn.error, reply: turn.reply,
      state: { et: c.getTime(), playing: c.isPlaying(), selected: c.getSelected(), tracked: c.getTracked(), camera: c.getCamera(),
        activity: c.getSelectedActivity(), place: c.getSelectedPlace(), measurements: c.listMeasurements(), appearance: c.getSurfaceAppearance('Mars'),
        imagery: c.getImagery('Mars'), instrument: c.getInstrument(), bookmarks: c.listBookmarks(), events: c.getEventVisualization(), geographic: c.listGeographicLayers() },
      steps: turn.steps.map(s => ({ id: s.id, name: s.name === 'invokeCapability' ? s.input.id : s.name, input: s.input,
        ok: s.result?.ok, status: s.result?.receipt?.status ?? null, data: s.result?.ok ? s.result.data : undefined,
        error: s.result && !s.result.ok ? s.result.error : null })) };
  });
}
try {
  for (const scenario of scenarios.filter(s => !selected || selected.includes(s.id))) for (const mode of modes) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await context.newPage(), offered = [], schemaBytes = [], payloads = [], downloads = [], errors = [], approvals = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url().startsWith('http://127.0.0.1:8798') && r.method() === 'POST') { const req = r.postDataJSON(); offered.push(req.tools.map(t => t.name)); schemaBytes.push(Buffer.byteLength(JSON.stringify(req.tools))); payloads.push(...req.messages.flatMap(m => m.content.filter(b => b.type === 'tool_result').map(b => ({ id: b.toolUseId, content: b.content })))); } });
    page.on('download', d => { downloads.push(d.saveAs(`${output}/${scenario.id}-${mode}-${d.suggestedFilename()}`)); });
    const started = performance.now(), usageStart = usage.length; let progressCaptured = false;
    try {
      console.log(`Loading ${scenario.id} (${mode})`);
      await page.goto(`${base}?catalog=test-catalogs/${scenario.catalog}${mode === 'discovery' ? '&askMode=discovery' : ''}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 });
      if (scenario.id === 'ingenuity') {
        // Ensure the natural-language request must actually change imagery.
        // Public fixture setup only; all subsequent actions are model-owned.
        await page.evaluate(() => { for (const layer of window.cosmo.getImagery('Mars').layers) if (layer.optional) window.cosmo.setImageryVisible('Mars', layer.id, false); });
      }
      if (scenario.id === 'geographic') {
        await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
        await page.getByRole('button', { name: 'Open Jezero synthetic science', exact: true }).click();
        await page.getByRole('option', { name: 'Jezero science target Point', exact: true }).click();
        await page.getByRole('button', { name: 'Edit a copy', exact: true }).click();
        await page.getByRole('toolbar', { name: 'Editing shape' }).waitFor();
      }
      await page.evaluate(async () => {
        const resource = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path);
        (await import(resource('/src/lib/shell.svelte.ts'))).openTool('ask');
        window.__askSmoke = (await import(resource('/src/lib/ask/ask.svelte.ts'))).ask;
      });
      await page.getByRole('textbox', { name: 'Request', exact: true }).fill(scenario.prompt);
      await page.getByRole('button', { name: 'Send request', exact: true }).click();
      for (let poll = 0; poll < 600; poll++) {
        if (scenario.id.startsWith('psyche-')) {
          assert.equal(await page.locator('.ask-turn').last().locator('.ask-status').count(), 1);
          if (!progressCaptured && await page.locator('.ask-status').last().innerText() !== 'Request completed') {
            await page.screenshot({ path: `${output}/${scenario.id}-${mode}-progress.png` }); progressCaptured = true;
          }
        }
        if (await page.getByRole('button', { name: 'Approve once', exact: true }).isVisible()) {
          // Test-owned public fixtures only. A production user makes this choice.
          const approval = await page.evaluate(() => import(performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === '/src/lib/ask/ask.svelte.ts')).then(m => m.askApproval.pending));
          const approvalUI = page.getByRole('group', { name: 'Approve Ask action' });
          approval.uiText = await approvalUI.innerText();
          assert.ok(!/events\.upsertEventQuery/.test(approval.uiText), 'main approval is human-readable');
          if (approval.operation.endsWith('upsertEventQuery')) {
            assert.match(approval.uiText, /Set up closest approach search/);
            await page.screenshot({ path: `${output}/${scenario.id}-${mode}-approval.png` });
          }
          approvals.push(approval);
          await page.getByRole('button', { name: 'Approve once', exact: true }).click();
        }
        if (await page.evaluate(() => window.__askSmoke.turns.length > 0 && window.__askSmoke.turns.at(-1).status !== 'running')) break;
        await page.waitForTimeout(500);
      }
      const result = await state(page), rows = usage.slice(usageStart);
      const gpu = await page.evaluate(() => {
        for (const canvas of document.querySelectorAll('canvas')) {
          const gl = canvas.getContext('webgl2');
          const debug = gl?.getExtension('WEBGL_debug_renderer_info');
          if (debug) return gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
        }
        return null;
      });
      await Promise.all(downloads);
      const run = { scenario: scenario.id, mode, prompt: scenario.prompt, latencyMs: Math.round(performance.now() - started), modelRounds: offered.length,
        rawTokens: rows.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens, 0), estimatedUsd: rows.some(r => r.estimatedUsd === null) ? null : rows.reduce((n,r) => n + r.estimatedUsd, 0), usage: rows, schemaBytes, toolCalls: result.steps.length, refusals: result.steps.filter(s => s.ok === false).length,
        offeredTools: offered[0], gpu, approvals, downloads: downloads.length, errors, result };
      report.runs.push(run);
      writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ scenario: scenario.id, mode, status: result.status, rounds: run.modelRounds, latencyMs: run.latencyMs, rawTokens: run.rawTokens, estimatedUsd: run.estimatedUsd, reply: result.reply }));
      assert.equal(result.status, 'done');
      assert.deepEqual(errors, []);
      assert.equal(offered[0].includes('listCapabilities'), true);
      assert.equal(offered[0].includes('resolve'), mode === 'fixed');
      const success = name => result.steps.some(s => s.ok && s.name.split('.').at(-1) === name);
      // Check actual serialized, call-ID-matched tool results delivered to the provider.
      for (const step of result.steps.filter(s => /getEventSearchOptions|getEventResultPage|listGeographicFeatures/.test(s.name) && s.ok)) {
        const delivered = payloads.find(p => p.id === step.id);
        assert.ok(delivered && !/result-too-large/.test(delivered.content), `${step.name} must be model-visible`);
      }
      if (['cassini','voyager','psyche-earth','psyche-mars'].includes(scenario.id)) {
        assert.equal(approvals.length, 0, 'routine Event Finder searches need no approval');
        assert.ok(success('getEventSearchOptions'));
        assert.ok(offered.length <= 12, 'bounded Cassini planner round trips');
        assert.ok(!result.steps.some(s => /Describe this capability before/i.test(s.error ?? '')), 'no protocol precondition refusal');
        assert.ok(success('runEventQuery') || result.steps.some(s => /getEventSearchOptions$/.test(s.name) && s.data?.coverage?.status === 'none'));
        if (scenario.id === 'psyche-earth' && !success('presentEventResult')) {
          assert.match(result.reply, /no.*flyby|not.*flyby|no.*flyb[yi]/i, 'distant minima must not become Earth flybys');
          const independent = await page.evaluate(() => { const c = window.cosmo, queries = c.listEventQueries(); return queries.map(q => ({ query: c.getEventQueryInfo(q.id), page: c.getEventResultPage(q.id, { limit: 100 }) })); });
          assert.ok(independent.some(q => q.page.total > 0));
          assert.equal(result.state.events.selected, null);
          result.independent = independent;
        } else if (success('runEventQuery')) {
          assert.ok(success('presentEventResult'),'show request uses shared encounter presentation');
          const selected=result.state.events.selected;assert.ok(selected);
          assert.equal(result.state.playing,false);
          const expected=scenario.id==='voyager'?['Voyager 1','Jupiter']:scenario.id.startsWith('psyche-')?['Psyche',scenario.id==='psyche-earth'?'Earth':'Mars']:['Cassini','Mimas'];
          assert.ok(expected.includes(result.state.tracked));
          const v=result.state.events;assert.ok(v.presentation);
          for(const object of expected) { const projected=v.presentation.participants.find(p=>p.object===object); assert.ok(projected?.inView,`${object} projected center fits actual camera`); assert.ok(Math.abs(projected.ndc[0]) < .4 && Math.abs(projected.ndc[1]) < .5,`${object} is composed in the central view, clear of standard side panels`); }
          assert.ok(v.presentation.participants.every(p=>p.drawEnabled),'native participant groups are enabled');
          assert.equal(v.renderer.observedEt,result.state.et,'native event pass observed exact frozen epoch/current camera');
          const inspected=result.steps.filter(s=>s.ok&&s.data?.ranking?.order==='range-ascending').flatMap(s=>s.data.items);
          if (scenario.id !== 'psyche-earth') assert.ok(inspected.some(i=>i.reference.id===selected.id&&i.reference.query===selected.query&&i.reference.revision===selected.revision),'winner came from complete ranked candidate set');
          const independent=await page.evaluate(query=>{const c=window.cosmo,p=c.getEventResultPage(query,{limit:100});let all=[...p.items],next=p.nextOffset;while(next!==null){const q=c.getEventResultPage(query,{offset:next,limit:100});all.push(...q.items);next=q.nextOffset;}return {info:p.query,events:all};},selected.query);
          const candidates=independent.events.map(i=>({reference:i.reference,event:i.event,range:i.event.metrics.find(m=>m.key==='range'&&m.unit==='km')?.value}));
          assert.ok(candidates.length&&candidates.every(i=>Number.isFinite(i.range)));
          const winner=candidates.reduce((a,b)=>a.range<=b.range?a:b);
          if (scenario.id !== 'psyche-earth') assert.equal(selected.id,winner.reference.id,'smallest range across entire current candidate set, not chronological result 0');
          assert.ok(candidates.some(c=>c.reference.id===selected.id&&Math.abs(result.state.et-c.event.et)<.001));
          const rankedStep=result.steps.find(s=>s.ok&&s.data?.ranking?.order==='range-ascending');if(scenario.id!=='psyche-earth')assert.equal(rankedStep.data.ranking.compared,candidates.length);
          const searched=independent.info.definition.query.window;
          for (const et of [searched.start,searched.end]) assert.ok(result.reply.includes(String(etToDate(et).getUTCFullYear())),'answer reports both searched boundary years, not only event date');
          assert.match(result.reply,/window|searched|search covered|between|from/i,'answer scopes the reported minimum');
          assert.ok(!/by hand|my own conversion/i.test(result.reply),'use viewer-provided UTC rather than approximate manual ET conversion');
          result.independent={window:independent.info.definition.query.window,total:candidates.length,winner:{reference:winner.reference,et:winner.event.et,rangeKm:winner.range},coverage:independent.info.coverage,provenance:independent.info.provenance};
          assert.ok(!result.steps.some(s=>/limit must be at most|lacks a shared semantic readback/.test(s.error??'')));
        }
      } else if (scenario.id === 'ingenuity') {
        assert.equal(result.state.activity?.id, 'ingenuity:flight:5');
        assert.equal(result.state.playing, false);
        assert.ok(Math.abs(result.state.et - result.state.activity.end) < 0.01);
        assert.equal(result.state.tracked, 'Ingenuity');
        assert.ok(result.state.measurements.some(m => m.id === 'flight5-distance' && m.source?.bodyName === 'Ingenuity' && m.target?.bodyName === 'Mars'));
        assert.equal(result.state.appearance.settings.hillshade, true);
        assert.equal(result.state.appearance.settings.palette, 'blue-gold');
        assert.equal(result.state.appearance.settings.baseColor, 'elevation','requested palette is actually presented, not hidden in imagery mode');
        assert.ok(success('showImagery'));
        const best = result.state.imagery.layers.filter(l => l.resolutionMeters != null).sort((a,b) => a.resolutionMeters - b.resolutionMeters)[0];
        assert.ok(best?.visible, 'highest-resolution managed imagery is actually enabled');
      } else if (scenario.id === 'instrument-capture') {
        assert.ok(success('selectInstrument') && success('getInstrument'));
        assert.ok(success('saveBookmark') && success('viewpoint'));
        assert.ok(success('waitUntilReady') && success('screenshot'));
        assert.equal(downloads.length, 1);
        assert.ok(approvals.some(a => a.kind === 'external'));
      } else {
        assert.ok(success('listGeographicLayers') && success('listGeographicFeatures') && success('editAnnotation'));
        assert.ok(approvals.some(a => a.kind === 'authoring'));
        assert.ok(result.state.geographic.some(l => l.editable && l.features === 0));
      }
      await page.screenshot({ path: `${output}/${scenario.id}-${mode}-panel.png` });
      if (scenario.id === 'psyche-mars') {
        await page.getByRole('textbox', { name: 'Request', exact: true }).fill('Explain what this distance measures and the limits of this search without changing the scene.');
        await page.getByRole('button', { name: 'Send request', exact: true }).click();
        await page.waitForFunction(() => window.__askSmoke.turns.length === 2 && window.__askSmoke.turns.at(-1).status !== 'running', null, { timeout: 120000 });
        assert.equal(await page.locator('.ask-turn').count(), 2);
        assert.equal(await page.locator('.ask-turn').last().locator('.ask-status').count(), 1);
        assert.equal(await page.getByRole('button', { name: 'Approve once', exact: true }).count(), 0);
        const followup = await state(page);
        assert.equal(followup.status, 'done');
        assert.deepEqual(followup.state.events.selected, result.state.events.selected);
        assert.equal(followup.state.et, result.state.et);
        report.runs.at(-1).followup = { prompt: 'Explain what this distance measures and the limits of this search without changing the scene.', reply: followup.reply, status: followup.status };
        await page.screenshot({ path: `${output}/${scenario.id}-${mode}-transcript.png` });
      }
    } finally { await context.close(); }
  }
} finally {
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  await new Promise(resolve => proxy.close(resolve));
}
