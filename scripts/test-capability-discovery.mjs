/** Loaded-viewer #328 acceptance and optional bounded real-provider comparison.
 * Start the intended checkout on CL_VIEWER_URL, then run this script.
 * CAPABILITY_LIVE=1 runs both configured provider keys; no key enters the browser.
 * Reports observations, never assumes discovery reduces total tokens/cost/latency.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { anthropicProvider } from '../examples/ask-proxy/anthropic.mjs';
import { openaiProvider } from '../examples/ask-proxy/openai.mjs';
import { estimatedCostUsd } from '../examples/ask-proxy/cost.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5298/';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', error => console.error(error.message));
const fixture = JSON.parse(readFileSync(new URL('../apps/viewer/test-catalogs/earth-moon.json', import.meta.url), 'utf8'));
fixture.activities = [{ version: 1, id: 'capability-inspection', name: 'Capability inspection fixture', vehicle: 'Moon', body: 'Earth',
  kind: 'other', temporality: 'interval', timeSystem: 'UTC', start: '2024-07-04T12:00:00Z', end: '2024-07-04T12:01:00Z',
  references: { viewpoint: 'Lunar Orbit' }, provenance: { source: 'capability acceptance fixture', version: '1', authority: 'authored', timing: 'exact', limitations: 'Synthetic test activity; not a mission operation.' } }];
await page.route('**/earth-moon.json', route => route.fulfill({ json: fixture }));
const report = { fixture: 'Earth + Moon with an explicitly synthetic test activity', renderer: 'Chromium SwiftShader (software WebGL)', loadedViewer: null, comparisons: [] };
let provider, rounds, processed = 0, estimatedSpent = 0;
await page.exposeFunction('capabilitySend', async request => {
  assert.ok(rounds.length < 20, 'bounded provider round trips');
  assert.ok(processed < 300000 && estimatedSpent < 1, 'bounded token/cost smoke guard');
  const key = process.env[provider.name === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'];
  const model = process.env[provider.name === 'openai' ? 'CAPABILITY_OPENAI_MODEL' : 'CAPABILITY_ANTHROPIC_MODEL'] ?? provider.defaultModel;
  const translated = provider.toRequest({ version: 1, ...request }, { model, maxTokens: 1536 });
  assert.ok(!translated.error, translated.error);
  const started = performance.now();
  const response = await fetch(provider.url, { method: 'POST', headers: { ...provider.headers(key), 'content-type': 'application/json' }, body: JSON.stringify(translated.body), signal: AbortSignal.timeout(60000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${provider.name} HTTP ${response.status}: ${String(body.error?.message ?? 'request rejected').slice(0, 1000)}`);
  const usage = provider.usage(body);
  const cost = estimatedCostUsd(provider.name, usage);
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  processed += input + usage.outputTokens;
  estimatedSpent += cost ?? 0;
  rounds.push({ tools: request.tools.length, schemaChars: JSON.stringify(request.tools).length, totalInputTokens: input, ...usage, estimatedUsd: cost, latencyMs: Math.round(performance.now() - started) });
  return provider.fromResponse(body);
});
try {
  await page.goto(`${base}?catalog=earth-moon&test=1`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 60000 });
  } catch (error) {
    console.error(await page.evaluate(() => ({ scene: window.cosmo?.getScene(), screen: document.body.innerText.slice(0, 4000) })));
    throw error;
  }
  report.loadedViewer = await page.evaluate(async root => {
    const { createCapabilityTools } = await import(`/@fs${root}/packages/control/dist/index.js`);
    const control = window.cosmo;
    const tools = createCapabilityTools(control);
    const task = tools.begin();
    const initial = tools.list().map(t => t.name);
    const discovery = await task.call('listCapabilities', { domain: 'activities' });
    await task.call('describeCapabilities', { ids: ['activities.getActivity', 'activities.selectActivity', 'activities.seekActivity', 'time.setPlaying', 'camera.viewpoint', 'surface.getSurfaceData', 'surface.showImagery'] });
    const results = [];
    for (const [name, input] of [
      ['getActivity', { activity: 'capability-inspection' }], ['setPlaying', { on: false }],
      ['selectActivity', { activity: 'capability-inspection' }], ['seekActivity', { activity: 'capability-inspection' }],
      ['viewpoint', { name: 'Lunar Orbit' }], ['getSurfaceData', { object: 'Earth' }],
      ['showImagery', { object: 'Earth', layer: 'missing', visible: true }], ['describeScene', {}],
    ]) results.push({ name, ...await task.call(name, input) });
    const state = await task.call('describeScene', {});
    task.finish(); tools.dispose();
    return { initial, discovery, results, state };
  }, root);
  assert.equal(report.loadedViewer.initial.length, 5);
  const results = report.loadedViewer.results;
  assert.ok(results.find(r => r.name === 'getSurfaceData').ok, 'real ViewerControl surface read');
  assert.equal(results.find(r => r.name === 'selectActivity').receipt.status, 'completed');
  assert.equal(results.find(r => r.name === 'showImagery').ok, false, 'explicit cross-domain partial failure');
  assert.equal(report.loadedViewer.state.data.selectedActivity.id, 'capability-inspection');
  assert.equal(report.loadedViewer.state.data.time.playing, false);

  // Exercise the actual Ask component with local tool replies; no provider needed.
  await page.evaluate(async () => {
    // Vite may timestamp rune modules. Reuse the exact loaded URLs so the
    // probe cannot accidentally construct a second module-wide state object.
    const loaded = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path);
    const ask = await import(loaded('/src/lib/ask/ask.svelte.ts'));
    const shell = await import(loaded('/src/lib/shell.svelte.ts'));
    let fixedRounds = 0;
    ask.setHostAskTransport({ send: async request => {
      if (request.tools.some(tool => tool.name === 'listCapabilities')) throw new Error('Default Ask unexpectedly offered discovery');
      fixedRounds++;
      return fixedRounds === 1
        ? { stop: 'tool_use', content: [{ type: 'tool_use', id: 'fixed-select', name: 'select', input: { object: 'Earth' } }] }
        : { stop: 'end', content: [{ type: 'text', text: 'Earth selected.' }] };
    } });
    await ask.submitAsk('Select Earth');
    if (window.cosmo.getSelected() !== 'Earth') throw new Error('Default Ask selection was not applied');
    if (fixedRounds !== 2) throw new Error('Default Ask added discovery rounds');
    ask.disposeAsk();
    ask.clearAsk();
    let round = 0;
    const call = (name, input) => ({ stop: 'tool_use', content: [{ type: 'tool_use', id: String(round), name, input }] });
    ask.setHostAskTransport({ send: async () => {
      round++;
      if (round === 1) return call('describeCapabilities', { ids: ['grids.setGridOpacity', 'scene.select'] });
      if (round === 2) return call('invokeCapability', { id: 'grids.setGridOpacity', input: { opacity: 0.5 } });
      if (round === 3) return call('invokeCapability', { id: 'scene.select', input: { object: 'Moon' } });
      return { stop: 'end', content: [{ type: 'text', text: 'Moon is selected. Grid opacity was requested but its state is unverified.' }] };
    } }, {}, 'discovery');
    shell.enableTool('ask'); shell.openTool('ask');
    await ask.submitAsk('Inspect the Moon and grid opacity');
  });
  try { await page.getByText('1 unverified', { exact: false }).first().waitFor({ timeout: 10000 }); }
  catch (error) {
    console.error(await page.evaluate(async () => ({ modules: performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('ask.svelte')), screen: document.body.innerText.slice(-4000), turns: (await import('/src/lib/ask/ask.svelte')).ask.turns })));
    throw error;
  }
  await page.locator('details.ask-actions > summary').click();
  await page.getByText('Selected Moon', { exact: true }).waitFor();
  assert.equal(await page.getByText('invokeCapability', { exact: true }).count(), 0, 'semantic action labels');
  const compact = await page.evaluate(() => ({ horizontalOverflow: document.documentElement.scrollWidth > innerWidth }));
  assert.equal(compact.horizontalOverflow, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('1 unverified', { exact: false }).first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'compact Ask overflow');
  report.askPanel = { fixedDefaultSelection: true, fixedDefaultRounds: 2, discoveryOptIn: true, semanticLabels: true, partialResultVisible: true, desktopAnd390px: true };
  await page.setViewportSize({ width: 1280, height: 900 });

  if (process.env.CAPABILITY_LIVE === '1') for (provider of [anthropicProvider, openaiProvider]) {
    const keyName = provider.name === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!process.env[keyName]) { report.comparisons.push({ provider: provider.name, skipped: 'No configured key' }); continue; }
    for (const mode of ['full', 'discovery']) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 60000 });
      rounds = [];
      const started = performance.now();
      const result = await page.evaluate(async ({ root, mode }) => {
        const { createAgentTools, createCapabilityTools, runAgent } = await import(`/@fs${root}/packages/control/dist/index.js`);
        window.cosmo.setPlaying(false); window.cosmo.setTime({ kind: 'et', et: 0 }); window.cosmo.deselect();
        const tools = (mode === 'full' ? createAgentTools : createCapabilityTools)(window.cosmo);
        const events = [], inputs = new Map();
        const run = await runAgent({ tools, maxSteps: 20, prompt: 'Inspect the activity named Capability inspection fixture: pause, select it, seek its start, present its referenced viewpoint, and report the configured surface datasets for Earth. Finish by reading current state. This is a synthetic test activity, not a mission operation.', transport: { send: request => window.capabilitySend(request) }, onEvent: e => { if (e.type === 'tool') inputs.set(e.id, e.input); if (e.type === 'tool-result') events.push({ name: e.name === 'invokeCapability' ? inputs.get(e.id).id.split('.').at(-1) : e.name, input: inputs.get(e.id), result: e.result }); } });
        const state = tools.inspect();
        tools.dispose();
        return { outcome: run.outcome, events, state, camera: window.cosmo.getCamera(), reply: run.messages.at(-1) };
      }, { root, mode });
      const success = result.outcome.kind === 'done' && result.state.data.selectedActivity?.id === 'capability-inspection'
        && !result.state.data.time.playing && result.events.some(e => e.name === 'getSurfaceData' && e.result.ok)
        && Math.abs(result.state.data.time.et - result.state.data.selectedActivity.start) < 0.001
        && result.events.some(e => e.name === 'selectActivity' && e.result.ok)
        && result.events.some(e => e.name === 'viewpoint' && e.result.ok);
      const verifiedSuccess = success && Math.abs(Math.hypot(...result.camera.position) - 900000) < 1;
      report.comparisons.push({ provider: provider.name, mode, success: verifiedSuccess, latencyMs: Math.round(performance.now() - started), rounds: [...rounds], result });
      console.log(JSON.stringify({ provider: provider.name, mode, success: verifiedSuccess, outcome: result.outcome, rounds: rounds.length, firstInputTokens: rounds[0]?.totalInputTokens, totalInputTokens: rounds.reduce((n, r) => n + r.totalInputTokens, 0), estimatedUsd: rounds.some(r => r.estimatedUsd === null) ? null : rounds.reduce((n, r) => n + r.estimatedUsd, 0) }));
    }
  }
  const output = process.env.CAPABILITY_REPORT ?? '/tmp/capability-discovery-report.json';
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Loaded viewer acceptance passed; report: ${output}`);
  if (report.comparisons.some(r => r.success === false)) process.exitCode = 1;
} finally { await browser.close(); }
