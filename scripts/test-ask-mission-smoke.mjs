/** Bounded real-catalog release smoke, not a benchmark. Requires an explicitly
 * configured key and dev viewer with VITE_ASK_ENDPOINT=http://127.0.0.1:8798.
 * Exercises the regular Ask panel and dev URL override, never an embed host.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createProxy, anthropicProvider } from '../examples/ask-proxy/server.mjs';

assert.equal(process.env.ASK_MISSION_LIVE, '1', 'Set ASK_MISSION_LIVE=1 to explicitly run paid inference');
assert.ok(process.env.ANTHROPIC_API_KEY, 'Configured Anthropic key required');
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5298/';
const usage = [];
const model = anthropicProvider.defaultModel;
const proxy = createProxy({ apiKey: process.env.ANTHROPIC_API_KEY, origins: [new URL(base).origin],
  provider: anthropicProvider, model, maxTokens: 1536, perMinute: 60,
  tokenBudget: 600000, costBudgetUsd: 0.5, cache: true, onUsage: row => usage.push(row),
});
await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(8798, '127.0.0.1', resolve); });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { model, cache: 'existing proxy prompt caching enabled; runs sequential, provider cache may be warm',
  renderer: 'Chromium SwiftShader', limits: { rawTokens: 600000, estimatedUsd: 0.5, maxOutputTokensPerRound: 1536 }, runs: [] };
function verifyMissionState(catalog, result) {
  const successful = name => result.steps.some(step => step.ok && step.name.split('.').at(-1) === name);
  if (catalog === 'ingenuity-jezero') {
    assert.equal(result.state.activity?.id, 'ingenuity:flight:12');
    assert.ok(Math.abs(result.state.activity.end - result.state.activity.start - 169.5) < 0.001);
    assert.equal(result.state.playing, false);
    assert.ok(Math.abs(result.state.et - result.state.activity.start) < 0.001);
    assert.equal(result.state.tracked, 'Ingenuity');
    assert.ok(successful('frameObject'));
    const inventory = result.steps.find(step => step.ok && step.name.split('.').at(-1) === 'getImagery')?.inventory;
    assert.equal(inventory?.layers.length, 4);
  } else {
    assert.equal(result.state.place?.ref, 'moon:mission:moonfall-sites/psr-landing');
    assert.ok(successful('gotoPlace'));
    const inventory = result.steps.find(step => step.ok && step.name.split('.').at(-1) === 'getSurfaceData')?.inventory;
    assert.ok(inventory?.terrain?.configured && inventory?.cubeImagery?.configured);
    assert.equal(inventory?.cubeImagery?.runtime.coversView, null);
  }
  // State/inventory assertions do not score the factual quality of the answer.
}

try {
  for (const scenario of [
    { catalog: 'ingenuity-jezero', prompt: "Show me Ingenuity's longest flight by duration, pause at its start, frame the helicopter, and tell me what imagery is available on Mars." },
    { catalog: 'moonfall-shackleton', prompt: 'Take me to the MoonFall landing site near Shackleton, explain which terrain and imagery datasets are available, and tell me whether they\'re actually loaded.' },
  ]) for (const mode of ['fixed', 'discovery']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const offered = [];
    page.on('request', request => {
      if (request.url().startsWith('http://127.0.0.1:8798') && request.method() === 'POST') {
        offered.push(request.postDataJSON().tools.map(tool => tool.name));
      }
    });
    const startUsage = usage.length;
    try {
      console.log(`Loading ${scenario.catalog} (${mode})`);
      await page.goto(`${base}?entry=examples/${scenario.catalog}&test=1&askMode=${mode}`, { waitUntil: 'domcontentloaded' });
      try { await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 }); }
      catch (error) { console.error((await page.locator('body').innerText()).slice(0, 1200)); throw error; }
      console.log(`Loaded ${scenario.catalog} (${mode})`);
      await page.evaluate(async () => {
        const url = performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === '/src/lib/shell.svelte.ts');
        const shell = await import(url);
        shell.openTool('ask');
      });
      await page.locator(`[data-ask-mode="${mode}"]`).waitFor();
      await page.getByRole('textbox', { name: 'Request', exact: true }).fill(scenario.prompt);
      const started = performance.now();
      await page.getByRole('button', { name: 'Send request', exact: true }).click();
      await page.evaluate(async () => {
        const url = performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === '/src/lib/ask/ask.svelte.ts');
        window.__askSmoke = (await import(url)).ask;
      });
      await page.waitForFunction(() => window.__askSmoke.turns.length > 0 && window.__askSmoke.turns.at(-1).status !== 'running', null, { timeout: 240000 });
      const result = await page.evaluate(async () => {
        const url = performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === '/src/lib/ask/ask.svelte.ts');
        const { ask } = await import(url);
        const turn = ask.turns.at(-1), control = window.cosmo;
        const activity = control.getSelectedActivity(), place = control.getSelectedPlace();
        return { status: turn.status, error: turn.error, reply: turn.reply,
          state: { activity: activity ? { id: activity.id, name: activity.name, start: activity.start, end: activity.end } : null,
            place: place ? { ref: place.ref, name: place.name, body: place.body } : null,
            et: control.getTime(), playing: control.isPlaying(), selected: control.getSelected(), tracked: control.getTracked(), camera: control.getCamera() },
          steps: turn.steps.map(step => ({ name: step.name === 'invokeCapability' ? step.input.id : step.name,
            ok: step.result?.ok, status: step.result?.receipt?.status ?? null,
            code: step.result && !step.result.ok ? step.result.code : null,
            summary: step.result?.ok ? step.result.summary : step.result?.error,
            // Read inventories already pass the model-facing public projection.
            inventory: /getSurfaceData|getImagery/.test(step.name === 'invokeCapability' ? step.input.id : step.name) && step.result?.ok ? step.result.data : undefined,
          })) };
      });
      assert.equal(offered[0]?.includes('listCapabilities'), true, 'both modes reach the shared catalog');
      assert.equal(offered[0]?.includes('resolve'), mode === 'fixed', 'fixed retains familiar direct schemas');
      const rows = usage.slice(startUsage);
      const run = { catalog: scenario.catalog, mode, prompt: scenario.prompt, latencyMs: Math.round(performance.now() - started),
        modelRounds: offered.length, usage: rows, result };
      report.runs.push(run);
      console.log(JSON.stringify({ catalog: scenario.catalog, mode, status: result.status, rounds: offered.length,
        rawTokens: rows.reduce((n, row) => n + row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens, 0),
        estimatedUsd: rows.some(row => row.estimatedUsd === null) ? null : rows.reduce((n, row) => n + row.estimatedUsd, 0),
        state: { ...result.state, camera: undefined }, reply: result.reply }));
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'compact panel fits');
      assert.equal(result.status, 'done');
      verifyMissionState(scenario.catalog, result);
    } finally { await context.close(); }
  }
} finally {
  writeFileSync(process.env.ASK_MISSION_REPORT ?? '/tmp/ask-mission-smoke.json', JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  await new Promise(resolve => proxy.close(resolve));
}
