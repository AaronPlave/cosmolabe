/** Small natural-language transfer control for #363. Haiku only; paid live inference opt-in. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { etToDate } from '../packages/core/dist/index.js';
import { checkAnswer, statedDates } from '../packages/control/dist/answer-check.js';
import { chromium } from 'playwright';
import { createProxy, anthropicProvider } from '../examples/ask-proxy/server.mjs';
assert.equal(process.env.ASK_ANALYSIS_LIVE, '1');
assert.ok(process.env.ANTHROPIC_API_KEY);
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5200/';
const model = 'claude-haiku-5-5', usage = [];
const output = process.env.ASK_ANALYSIS_REPORT ?? '/tmp/ask-analysis-transfer.json';
const cases = [
  { id: 'cassini', catalog: 'cassini-soi', prompt: 'When did Cassini get closest to Titan? Show me' },
  { id: 'philae-success', successControl: true, catalog: 'rosetta', prompt: 'When did Philae get closest to comet 67P during its landing? Show me.' },
  { id: 'philae', catalog: 'rosetta', prompt: 'When did Philae get closest to comet 67P during its landing? Show me.' },
  { id: 'descent', catalog: 'rosetta', prompt: "How did Philae's distance change during descent?" },
  { id: 'earth', catalog: 'rosetta', prompt: 'When was Rosetta closest to Earth?' },
  { id: 'touchdown', catalog: 'rosetta', prompt: 'When did Philae first touch down?' },
  { id: 'coverage', catalog: 'rosetta', prompt: 'When were Philae and Earth closest during 1980? Show me.' },
  // Held out from implementation/design: same contract, different pair and interval.
  { id: 'heldout', catalog: 'cassini-soi', prompt: 'Find the smallest distance between Cassini and Saturn in the loaded data and show it.' },
];
const report = { model, fallback: false, renderer: 'Chromium SwiftShader', cache: 'warmth uncontrolled', runs: [] };
const proxy = createProxy({ apiKey: process.env.ANTHROPIC_API_KEY, origins: [new URL(base).origin], provider: anthropicProvider, model, escalationModel: model, fallback: false, maxTokens: 1536, tokenBudget: 600000, costBudgetUsd: 0.5, perMinute: 100, cache: true,
  fetchImpl: (url, options) => { const body = JSON.parse(options.body); assert.equal(body.model, model); assert.equal(body.fallbacks, undefined); return fetch(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) }); },
  onUsage: row => { assert.equal(row.model, model); assert.equal(row.requestedModel, model); usage.push(row); console.log(`Haiku completed: ${row.inputTokens+row.cacheReadTokens+row.cacheWriteTokens+row.outputTokens} processed tokens`); },
});
await new Promise(resolve => proxy.listen(8797, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
try {
  for (const scenario of cases.filter(c => !process.env.ASK_ANALYSIS_CASE || process.env.ASK_ANALYSIS_CASE.split(',').includes(c.id))) {
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
        window.__analysisAsk = store.ask; window.__analysisSubmit = store.submitAsk;
      });
      clearInterval(loading);
      await page.waitForFunction(() => window.__analysisShell.isToolAvailable('ask'), null, { polling: 100 });
      await page.evaluate(() => window.__analysisShell.openTool('ask'));
      if (scenario.successControl) await page.evaluate(async resolverPath => {
        const resource = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path);
        const loader = await import(resource('/src/lib/loader.ts')), worker = loader.getGeometryWorker();
        if (!worker) throw new Error('Real worker required');
        const { loadCatalogFromUrl } = await import('/@fs' + resolverPath);
        const graph = await loadCatalogFromUrl(loader.demoCatalogUrl('test-catalogs/rosetta'));
        const dependencies = graph.kernels.map(k => k.url).filter(u => /\.(?:tf|tsc|bc)(?:\.gz)?$/i.test(new URL(u).pathname));
        const kernels = worker.options.kernels; worker.options.kernels = async () => [...await kernels(), ...dependencies];
        const search = worker.search.bind(worker); worker.search = options => search({ ...options, scope: undefined });
      }, new URL('../packages/core/src/catalog/CatalogResolver.ts', import.meta.url).pathname);
      await page.bringToFront();
      console.log(`${scenario.id}: scene ready`);
      // The panel's normal entry point, with the exact natural-language text.
      // Await the request itself rather than coupling completion to canvas RAF.
      let timer;
      try { await Promise.race([page.evaluate(prompt => window.__analysisSubmit(prompt), scenario.prompt), new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('Ask request deadline exceeded')),900000); })]); }
      finally { clearTimeout(timer); }
      const result = await page.evaluate(() => {
        const t = window.__analysisAsk.turns.at(-1), c = window.cosmo;
        return { status: t.status, answer: t.reply, error: t.error, verification: t.result, steps: t.steps.map(s => ({ id: s.id, name: s.name === 'invokeCapability' ? s.input.id : s.name, input: s.input, result: s.result })),
          state: { et: c.getTime(), playing: c.isPlaying(), tracked: c.getTracked(), camera: c.getCamera(), event: c.getEventVisualization(), profiles: c.listProfiles().items.map(p => c.getProfile(p.id)) } };
      });
      const approaches = result.steps.filter(s => s.result?.data?.status === 'computed' || s.result?.data?.status === 'sampled');
      const run = { ...scenario, rounds, tokens: usage.slice(start).reduce((n,r) => n+r.inputTokens+r.cacheReadTokens+r.cacheWriteTokens+r.outputTokens,0), result, checks: [] };
      report.runs.push(run); runRecord = run;
      if (['cassini','philae-success','heldout'].includes(scenario.id)) { assert.ok(approaches.some(s => s.result.data.computedEventVerified), 'Expected verified computed presentation'); assert.equal(result.verification.status, 'verified'); }
      if (['philae','earth'].includes(scenario.id)) assert.ok(approaches.some(s => s.result.data.status === 'sampled'), 'Expected qualified sampled alternative');
      assert.ok(result.answer, 'Useful final answer required');
      assert.deepEqual(checkAnswer(result.answer, result.verification.facts), [], 'Final numerical claims grounded in published facts');
      for (const s of result.steps.filter(s => s.result?.data?.status === 'computed' || s.result?.data?.status === 'sampled')) {
        const wire = payloads.get(s.id);
        assert.ok(wire && !wire.includes('result-too-large'), 'Result delivered to model by matching call ID');
        const data = s.result.data;
        if (data.status === 'computed' && data.presentation) {
          assert.equal(data.computedEventVerified, true);
          const chosen = data.result.items[0];
          assert.equal(result.state.event.selected.id, chosen.reference.id);
          assert.equal(result.state.event.selected.revision, chosen.reference.revision);
          assert.equal(result.state.et, chosen.et);
          assert.equal(result.state.event.status, 'observed');
          run.checks.push('computed event, exact epoch/reference and native presentation');
        } else if (data.status === 'sampled') {
          assert.equal(data.computedEventVerified, false);
          assert.ok(data.samples.count <= 32);
          const raw = await page.evaluate(d => window.cosmo.sampleProfileData(d.id, { ...d.requestedWindow, count: d.count }), data.samples);
          const finite = raw.samples.filter(s => s.value !== null);
          assert.equal(data.samples.minimum.value, Math.min(...finite.map(s => s.value)));
          const actual = await page.evaluate(({ id, et }) => window.cosmo.getProfileValue(id, et), { id: data.samples.id, et: data.samples.minimum.et });
          assert.equal(actual.minimum.value, data.samples.minimum.value);
          assert.match(result.answer, /sampl|approxim/i);
          assert.match(result.answer, /missing|gaps?/i);
          assert.ok(result.answer.includes(String(data.samples.count)), 'Disclose actual sample count');
          for (const endpoint of [raw.samples[0], raw.samples.at(-1)]) assert.ok(statedDates(result.answer).some(d => d.day === endpoint.utc.slice(0,10)) || result.answer.includes(String(endpoint.et)), 'Disclose interval endpoints');
          if (data.sampledEpochSelected) assert.equal(result.state.et, data.samples.minimum.et);
          else { assert.equal(data.sampledView, null); assert.ok(!result.steps.some(s => /^(?:time\.|camera\.|setTime|setPlaying|frameObject|composeView|track)/.test(s.name) && s.result?.ok), 'Exploratory result must not be followed by successful granular navigation'); assert.match(data.limitations.join(' '), /exploratory/i); if (/show/i.test(scenario.prompt)) assert.match(result.answer, /exploratory|coarse|low.resolution|not.*(?:seek|navigat|encounter|change.*(?:view|time|clock))|no.*(?:seek|navigat|encounter)|(?:view|time|clock).*unchanged/i); }
          assert.equal(result.state.profiles.find(p => p.definition.id === data.samples.id)?.timeline.traceVisible, true);
          assert.equal(result.verification.status, 'failed');
          run.checks.push('actual bounded samples; computed-event goal remains unmet');
        } else {
          assert.equal(data.status, 'computed');
          run.checks.push('computed event without requested presentation');
        }
      }
      if (scenario.id === 'descent') {
        const read = result.steps.findLast(s => s.result?.data?.sampling && s.result.data.minimum);
        if (read) assert.ok(payloads.get(read.id) && !payloads.get(read.id).includes('result-too-large'));
        else {
          // A history question can use actual point states without authoring a
          // chart. Re-evaluate those positions and ground the derived norms.
          const points = result.steps.flatMap(s => {
            const d = s.result?.data, state = d?.state ?? d;
            return state?.position && Number.isFinite(state.et) && state.center ? [{ step: s, state }] : [];
          });
          assert.ok(new Set(points.map(p => p.state.et)).size >= 2, 'Actual numerical history required');
          const values = [];
          for (const { step, state } of points) {
            assert.ok(payloads.get(step.id) && !payloads.get(step.id).includes('result-too-large'));
            const actual = await page.evaluate(d => window.cosmo.getObjectState(d.object, { center: d.center, time: { kind: 'et', et: d.et } }), { object: step.input.input?.object ?? step.input.object, center: state.center, et: state.et });
            const km = Math.hypot(...state.position);
            assert.ok(Math.abs(Math.hypot(...actual.position) - km) < 1e-5, 'Independent native center distance agrees');
            values.push({ km, et: state.et, utc: etToDate(state.et).toISOString() });
          }
          values.sort((a,b) => a.et-b.et);
          const minimum = values.reduce((a,b) => a.km < b.km ? a : b);
          assert.deepEqual(checkAnswer(result.answer, [{ kind: 'sampled-range', observer: 'Philae', target: '67P', startUtc: values[0].utc, endUtc: values.at(-1).utc, count: values.length, missing: 0, minimumKm: minimum.km, minimumEt: minimum.et, minimumUtc: minimum.utc, samples: values, eventSearchUnavailable: false }]), [], 'History distances independently grounded');
          for (const clock of result.answer.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)/g)) assert.ok(values.some(v => v.utc.slice(11,16) === `${clock[1].padStart(2,'0')}:${clock[2]}`), 'History clock matches a returned epoch');
        }
        run.checks.push('bounded numerical history and grounded answer');
        run.checks.push(result.state.profiles.some(p => p.timeline.traceVisible) ? 'native trace present' : 'no native trace (not requested)');
      }
      if (scenario.id === 'touchdown') {
        assert.match(result.answer, /catalog|authored|viewpoint|annotation/i);
        assert.ok(!result.steps.some(s => /findClosestApproach|runEventQuery|sampleProfileData/.test(s.name)));
        run.checks.push('authored annotation only; no computed contact claim');
      }
      if (scenario.id === 'coverage') {
        assert.ok(result.steps.some(s => s.result?.data?.reason === 'missing-coverage'));
        assert.equal(result.state.profiles.length, 0);
        run.checks.push('structured missing coverage, no profile substitution');
      }
      console.log(JSON.stringify({ id: scenario.id, rounds, tokens: run.tokens, status: result.status, answer: result.answer, checks: run.checks }));
    } catch (e) {
      const diagnostic = await Promise.race([page.evaluate(() => ({ scene: window.cosmo?.getScene(), flight: window.cosmo?.getFlight(), turns: window.__analysisAsk?.turns.map(t => ({status:t.status,reply:t.reply,steps:t.steps.map(s => ({name:s.name,result:!!s.result}))})), requestVisible: !!document.querySelector('[aria-label=\"Request\"]'), stopVisible: !!document.querySelector('[aria-label=\"Stop request\"]') })), new Promise(resolve => setTimeout(() => resolve({unresponsive:true}),3000))]).catch(() => ({closed:true}));
      if (runRecord) Object.assign(runRecord, { error: String(e), diagnostic });
      else report.runs.push({ ...scenario, rounds, error: String(e), diagnostic }); console.error(`${scenario.id}: ${e}`); console.log(JSON.stringify(diagnostic));
    }
    finally { clearInterval(loading); writeFileSync(output, JSON.stringify(report,null,2)+'\n'); await page.close(); }
  }
} finally { await browser.close(); await new Promise(resolve => proxy.close(resolve)); }
if (report.runs.some(r => r.error)) process.exitCode = 1;
