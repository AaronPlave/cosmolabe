/** Paid loaded-viewer benchmark for #332. Plan only unless ASK_BENCHMARK_LIVE=1.
 * Keys stay in Node. Output contains public projections and final answers only;
 * never provider messages, signed reasoning, request headers or raw catalogs.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createProxy, anthropicProvider } from '../examples/ask-proxy/server.mjs';
import { cases, scoreState, summarizeUsage } from './ask-benchmark/cases.mjs';

const models = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
const repetitions = Number(process.env.ASK_BENCHMARK_REPETITIONS ?? 1);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const selected = cases.filter(c => !process.env.ASK_BENCHMARK_CASES || process.env.ASK_BENCHMARK_CASES.split(',').includes(c.id));
assert.ok(selected.length);
const report = { version: 1, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  started: new Date().toISOString(), models, repetitions, tasks: selected.map(c => c.id),
  renderer: 'Chromium SwiftShader; software WebGL, no physical GPU acceptance',
  initialState: 'Catalog default ET/viewpoint; deselected; rate 0 to freeze ET; playback on for pause/cancel tasks, paused otherwise',
  prompt: 'Unmodified shipped Ask prompts; max output 1536; thinking/effort unspecified (provider defaults); no fallback',
  cache: { enabled: true, ttl: '5m', warmth: 'uncontrolled shared provider cache; fresh browser/scene/conversation per cell', order: 'task outer; model/mode order reversed on alternating tasks and repetitions' },
  limits: { rawTokens: 8_000_000, estimatedUsd: 4, note: 'subsequent-request guards, not account limits; cancelled upstream usage may be unobservable' },
  actualBilling: 'Not observable through Messages API/key; actualBilledUsd stays null, including cancelled requests.', runs: [] };
if (process.env.ASK_BENCHMARK_LIVE !== '1') {
  console.log(JSON.stringify({ ...report, plan: selected }, null, 2));
  process.exit(0);
}
assert.ok(process.env.ANTHROPIC_API_KEY, 'Configured Anthropic key required');
const headers = anthropicProvider.headers(process.env.ANTHROPIC_API_KEY);
const available = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers, signal: AbortSignal.timeout(30000) });
assert.ok(available.ok, `Model availability HTTP ${available.status}`);
const listing = await available.json();
assert.ok(!listing.has_more, 'Availability list must be complete');
report.availability = { checked: new Date().toISOString(), models: listing.data.map(m => m.id).filter(id => models.includes(id)) };
assert.ok(models.every(id => report.availability.models.includes(id)), 'Both reviewed model IDs must be available');
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5299/';
const output = process.env.ASK_BENCHMARK_REPORT ?? '/tmp/ask-benchmark.json';
const allUsage = [];
function cellProxy(model, cellUsage) {
  let upstreamLatencyMs = null, outputCalls = [];
  return createProxy({ apiKey: process.env.ANTHROPIC_API_KEY, origins: [new URL(base).origin],
    provider: { ...anthropicProvider, fromResponse: reply => {
      const wire = anthropicProvider.fromResponse(reply);
      outputCalls = wire?.content.filter(c => c.type === 'tool_use').map(c => c.name === 'invokeCapability' ? c.input.id : c.name) ?? [];
      return wire;
    } },
    // A fixed-model proxy per fresh cell. Closing it drains/aborts its requests
    // before the next cell; late usage cannot be attributed to another model.
    model, maxTokens: 1536, perMinute: 1000, cache: true,
    tokenBudget: report.limits.rawTokens, costBudgetUsd: report.limits.estimatedUsd,
    fetchImpl: async (url, options) => {
      const totals = summarizeUsage(allUsage);
      assert.ok(totals.rawProcessed < report.limits.rawTokens && (!allUsage.length || totals.estimatedUsd !== null && totals.estimatedUsd < report.limits.estimatedUsd), 'Benchmark budget exhausted');
      const started = performance.now();
      const response = await fetch(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) });
      upstreamLatencyMs = Math.round(performance.now() - started);
      return response;
    },
    onUsage: row => { const projected = { ...row, upstreamLatencyMs, outputCalls }; cellUsage.push(projected); allUsage.push(projected); },
  });
}
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  for (let repeat = 0; repeat < repetitions; repeat++) for (const [index, test] of selected.entries()) {
    const cells = models.flatMap(model => ['fixed', 'discovery'].map(mode => ({ model, mode })));
    if ((index + repeat) % 2) cells.reverse();
    for (const { model, mode } of cells) {
      const cellUsage = [];
      const proxy = cellProxy(model, cellUsage);
      await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(8799, '127.0.0.1', resolve); });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const rounds = [];
      let cancel = null;
      // Cancellation occurs at a real transport boundary after a write, before
      // another model request is forwarded. No hidden paid reply or retry.
      await page.route('http://127.0.0.1:8799/', async route => {
        const request = route.request().postDataJSON();
        if (test.cancel && await page.evaluate(() => window.__askBench?.ask.turns.at(-1)?.steps.some(s => s.result?.ok && ['setPlaying', 'select', 'viewpoint', 'frameObject'].includes((s.name === 'invokeCapability' ? s.input.id : s.name).split('.').at(-1))))) {
          cancel = await page.evaluate(async () => {
            const before = await window.__benchSnapshot();
            window.__askBench.stopAsk();
            return { afterWrite: true, before };
          });
          return route.abort();
        }
        rounds.push({ discoveryOffered: request.tools.some(t => t.name === 'listCapabilities'), tools: request.tools.length, schemaChars: JSON.stringify(request.tools).length,
          lastResultCodes: request.messages.at(-1)?.content.filter(c => c.type === 'tool_result').map(c => { try { return JSON.parse(c.content).code ?? null; } catch { return 'invalid-json'; } }) ?? [],
          describedSchemas: request.messages.flatMap(m => m.content).filter(c => c.type === 'tool_use' && c.name === 'describeCapabilities').length });
        await route.continue();
      });
      const run = { task: test.id, repeat, model, mode, order: report.runs.length, rounds, result: null };
      report.runs.push(run);
      try {
        console.log(`Running ${test.id} ${model} ${mode}`);
        await page.goto(`${base}?catalog=test-catalogs/${test.catalog}&test=1&askMode=${mode}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 });
        await page.evaluate(async ({ test }) => {
          const loaded = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path);
          window.__askBench = await import(loaded('/src/lib/ask/ask.svelte.ts'));
          const stateModule = await import(loaded('/src/lib/viewer-state.svelte.ts'));
          const shell = await import(loaded('/src/lib/shell.svelte.ts'));
          shell.openTool('ask');
          // Identical deterministic initial clock and selection across all cells.
          const c = window.cosmo;
          c.setTimeRate(0); c.setPlaying(!!(test.paused || test.cancel)); c.deselect();
          window.__benchSnapshot = async () => {
            const activity = c.getSelectedActivity(), place = c.getSelectedPlace();
            const camera = c.getCamera();
            const state = { assetsReady: window.__cosmolabe?.assetsReady ?? null, selected: c.getSelected(), tracked: c.getTracked(), et: c.getTime(), playing: c.isPlaying(), camera,
              activity: activity ? { id: activity.id, start: activity.start, end: activity.end } : null,
              place: place ? { ref: place.ref, name: place.name } : null };
            state.stable = { selected: state.selected, tracked: state.tracked, et: state.et, playing: state.playing, camera, activity: state.activity, place: state.place };
            if (test.frame) {
              const ctx = stateModule.getRenderer().getContext(), bm = ctx.getBodyMesh('Ingenuity'), cam = ctx.camera;
              if (bm) {
                const point = bm.position.clone().project(cam);
                const distance = bm.position.distanceTo(cam.position);
                const fraction = bm.displayRadius * ctx.scaleFactor / (distance * Math.tan(cam.fov * Math.PI / 360));
                state.framing = { ndc: point.toArray(), viewportFraction: fraction,
                  inView: Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && point.z >= -1 && point.z <= 1,
                  occupiesViewport: fraction > 0.01 && fraction < 1 };
              }
            }
            return state;
          };
        }, { test });
        const initial = await page.evaluate(() => window.__benchSnapshot());
        run.initialState = initial.stable;
        const started = performance.now();
        await page.getByRole('textbox', { name: 'Request', exact: true }).fill(test.prompt);
        await page.getByRole('button', { name: 'Send request', exact: true }).click();
        await page.waitForFunction(() => window.__askBench.ask.turns.length && window.__askBench.ask.turns.at(-1).status !== 'running', null, { timeout: 240000 });
        run.latencyMs = Math.round(performance.now() - started);
        run.result = await page.evaluate(async () => {
          const turn = window.__askBench.ask.turns.at(-1);
          return { status: turn.status, errorCode: turn.errorCode, reply: turn.reply, state: await window.__benchSnapshot(),
            steps: turn.steps.map(s => ({ name: s.name === 'invokeCapability' ? s.input.id : s.name, ok: s.result?.ok ?? null,
              describedIds: s.name === 'describeCapabilities' ? s.input.ids : undefined,
              receipt: s.result?.receipt?.status ?? null, code: s.result && !s.result.ok ? s.result.code : null,
              // Only model-facing public metadata, never raw control inventories.
              observation: s.result?.ok && /describeScene|getImagery|getSurfaceData|getActivity|listActivities/.test(s.name === 'invokeCapability' ? s.input.id : s.name) ? s.result.data : undefined })) };
        });
        if (cancel) {
          await page.waitForTimeout(500);
          const late = await page.evaluate(() => window.__benchSnapshot());
          run.result.cancel = { afterWrite: true, unchanged: JSON.stringify(late.stable) === JSON.stringify(cancel.before.stable) };
        }
        run.score = scoreState(test, initial, run.result);
        run.score.checks.modelIdentity = cellUsage.length > 0 && cellUsage.every(row => row.model === model);
        run.score.checks.toolMode = rounds[0]?.discoveryOffered === (mode === 'discovery');
        run.score.passed = Object.values(run.score.checks).every(Boolean);
        run.cacheFirstRequest = cellUsage[0]?.cacheReadTokens > 0 ? 'observed-cache-read' : 'no-observed-cache-read';
        run.usage = summarizeUsage(cellUsage);
        run.requestUsage = cellUsage.map(({ requestedModel, model, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, estimatedUsd, stop, fallback, upstreamLatencyMs, outputCalls }) => ({ requestedModel, model, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, estimatedUsd, stop, fallback, upstreamLatencyMs, outputCalls }));
        console.log(JSON.stringify({ task: test.id, model, mode, statePassed: run.score.passed, rounds: rounds.length, estimatedUsd: run.usage.estimatedUsd }));
      } catch (error) {
        // Store a fixed diagnostic, not arbitrary provider/browser error text.
        run.failure = error.name === 'TimeoutError' ? 'viewer-or-task-timeout' : 'harness-error';
        run.usage = summarizeUsage(cellUsage);
        console.error(`${test.id}: ${error.name}: ${error.message.slice(0, 250)}`);
      } finally {
        writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        await context.close();
        await new Promise(resolve => proxy.close(resolve));
      }
    }
  }
} finally {
  report.finished = new Date().toISOString();
  report.totalUsage = summarizeUsage(allUsage);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(`Report: ${output}`);
if (report.runs.some(r => r.failure)) process.exitCode = 1;
