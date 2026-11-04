/** Paid loaded-viewer benchmark for #332. Plan only unless ASK_BENCHMARK_LIVE=1.
 * Keys stay in Node. Output contains public projections and final answers only;
 * never provider messages, signed reasoning, request headers or raw catalogs.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createProxy, anthropicProvider } from '../examples/ask-proxy/server.mjs';
import { cases, scoreState, summarizeUsage, poseMatches, modelVisibleResults } from './ask-benchmark/cases.mjs';
import { reliabilityCases, promptsOf, goalReads, turnGoal, judgeTurn, scoreReliability, classify, suspectedFalseSuccess, summarizeReliability } from './ask-benchmark/reliability.mjs';

const list = (name, all) => (process.env[name] ? process.env[name].split(',').filter(v => all.includes(v)) : all);
const models = list('ASK_BENCHMARK_MODELS', ['claude-sonnet-5-5', 'claude-haiku-5-5']);
const modes = list('ASK_BENCHMARK_MODES', ['fixed', 'discovery']);
// A/B (#345): the arm is which viewer build answers (CL_VIEWER_URL). A = a pre-#345 checkout, B = this one.
const arm = process.env.ASK_BENCHMARK_ARM ?? 'B';
const suite = process.env.ASK_BENCHMARK_SUITE ?? 'all';
const repetitions = Number(process.env.ASK_BENCHMARK_REPETITIONS ?? 1);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const pool = [...(suite === 'reliability' ? [] : cases), ...(suite === 'legacy' ? [] : reliabilityCases.map(c => ({ ...c, reliability: true })))];
const selected = pool.filter(c => !process.env.ASK_BENCHMARK_CASES || process.env.ASK_BENCHMARK_CASES.split(',').includes(c.id));
assert.ok(selected.length && models.length && modes.length);
const report = { version: 1, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  started: new Date().toISOString(), arm, viewer: process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5299/', models, modes, repetitions, tasks: selected.map(c => c.id),
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
assert.ok(models.every(id => report.availability.models.includes(id)), 'Every reviewed model ID must be available');
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
    const cells = models.flatMap(model => modes.map(mode => ({ model, mode })));
    if ((index + repeat) % 2) cells.reverse();
    for (const { model, mode } of cells) {
      const cellUsage = [];
      const proxy = cellProxy(model, cellUsage);
      await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(8799, '127.0.0.1', resolve); });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const rounds = [];
      let cancel = null;
      const visibleResults = new Map();
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
        for (const [id, visible] of modelVisibleResults(request.messages)) visibleResults.set(id, visible);
        rounds.push({ discoveryOffered: request.tools.some(t => t.name === 'listCapabilities'), tools: request.tools.length, schemaChars: JSON.stringify(request.tools).length,
          lastResultCodes: request.messages.at(-1)?.content.filter(c => c.type === 'tool_result').map(c => { try { return JSON.parse(c.content).code ?? null; } catch { return 'invalid-json'; } }) ?? [],
          describedSchemas: request.messages.flatMap(m => m.content).filter(c => c.type === 'tool_use' && c.name === 'describeCapabilities').length });
        await route.continue();
      });
      const run = { task: test.id, repeat, model, mode, arm, ...(test.reliability ? { reliability: true } : {}), order: report.runs.length, rounds, result: null };
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
            if (test.viewpoint) {
              const renderer = stateModule.getRenderer();
              // This case uses the fixed-rotation Earth catalog viewpoint.
              const vp = renderer.cameraController.getViewpoint(test.viewpoint);
              state.navigation = { expectedPose: vp ? { position: vp.position.toArray().map(v => v / renderer.scaleFactor), target: vp.target.toArray().map(v => v / renderer.scaleFactor), up: vp.up.toArray() } : null };
            }
            if (test.place) {
              // Resolve the catalog anchor without navigating. Compare in render
              // coordinates, including the body's current frame and translation.
              const renderer = stateModule.getRenderer(), ctx = renderer.getContext();
              const place = stateModule.vs.places?.byRef.get(test.place);
              if (place?.feature.geometry.type === 'Point') {
                const places = await import(loaded('/src/lib/places.ts'));
                const coords = places.placeNavigationCoordinates(place);
                const resolved = stateModule.resolveCoordinateTarget({ bodyName: place.layer.body, ...coords, latitude: 'planetocentric', longitudeDirection: 'east' });
                const bm = ctx.getBodyMesh(place.layer.body);
                if (resolved.ok && bm) {
                  const v = resolved.target.positionKm;
                  const target = bm.position.clone().set(v[0], v[2], -v[1]).multiplyScalar(ctx.scaleFactor).applyQuaternion(bm.mesh.quaternion).add(bm.position);
                  state.navigation = { targetErrorKm: renderer.cameraController.controls.target.distanceTo(target) / ctx.scaleFactor,
                    eyeDistanceKm: ctx.camera.position.distanceTo(target) / ctx.scaleFactor };
                  state.navigation.targetMatches = state.navigation.targetErrorKm < 0.5;
                  state.navigation.nearDestination = state.navigation.eyeDistanceKm >= 0.1 && state.navigation.eyeDistanceKm <= 5;
                }
              }
            }
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
          // #345 oracle: the harness's own projection of the actual render camera,
          // independent of the viewer's getViewComposition under test.
          window.__probeComposition = names => {
            const r = stateModule.getRenderer(), cam = r.camera, s = r.scaleFactor;
            cam.updateMatrixWorld();
            const eye = cam.position.clone();
            const spheres = r.getBodyNames().map(n => r.getBodyMesh(n)).filter(b => b?.visible && b.hasMeasuredRadius)
              .map(b => { const rel = b.getWorldPosition(eye.clone()).sub(eye); const range = rel.length() / s; return { name: b.body.name, dir: rel.normalize(), range, ang: Math.asin(Math.min(1, b.displayRadius / range)) }; });
            const objects = names.map(object => {
              const bm = r.getBodyMesh(object);
              if (!bm) return { object, available: false, inView: false, rangeKm: null, occlusion: null };
              const world = bm.getWorldPosition(eye.clone()), rel = world.clone().sub(eye), rangeKm = rel.length() / s, dir = rel.clone().normalize();
              const radiusKm = bm.hasMeasuredRadius ? bm.displayRadius : null, ang = radiusKm ? Math.asin(Math.min(1, radiusKm / rangeKm)) : 0;
              const p = world.clone().project(cam), front = world.clone().applyMatrix4(cam.matrixWorldInverse).z < 0;
              let occlusion = null, nearest = Infinity;
              for (const o of spheres) if (o.name !== object && o.range < rangeKm && o.range < nearest && o.dir.angleTo(dir) < o.ang) { nearest = o.range; occlusion = { by: o.name, kind: o.dir.angleTo(dir) + ang <= o.ang ? 'full' : 'partial' }; }
              return { object, available: true, drawEnabled: bm.visible, rangeKm, radiusKm, ndc: front ? [p.x, p.y] : null, inView: front && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1, occlusion };
            });
            return { et: r.timeController.et, playing: r.timeController.playing, tracked: r.cameraController.trackedBody?.body.name ?? null, objects };
          };
          window.__benchReads = reads => reads.map(([method, args]) => {
            try { return [method, args, method === 'getViewComposition' ? window.__probeComposition(...args) : JSON.parse(JSON.stringify(c[method](...args) ?? null))]; }
            catch { return [method, args, null]; }
          });
          window.__benchEvent = () => {
            const v = c.getEventVisualization(), search = c.getEventSearch(), id = v.selected?.query ?? search.query;
            if (!id) return null;
            const info = c.getEventQueryInfo(id), page = c.getEventResultPage(id, { limit: 1 });
            const q = info.definition?.query;
            return { id, kind: q?.kind ?? null, bodies: q?.bodies ?? {}, window: q?.window ?? null, scope: q?.params?.scope ?? null, maxRangeKm: q?.params?.maxRangeKm ?? null,
              searchComplete: search.query === id && search.status === 'complete', total: page.total, presented: !!v.selected };
          };
          // Independent ground truth: range between two objects sampled through the viewer's own
          // state reads over the given windows, its local minima counted. No Event Finder code and
          // nothing the model chose (window, range cap) is involved.
          window.__benchRange = (a, b, windows, step) => {
            const range = et => { const p = c.getObjectState(a, { time: { kind: 'et', et }, center: b })?.position; return p ? Math.hypot(...p) : NaN; };
            let samples = 0, minima = 0, closestMinimumKm = null;
            const finite = [];
            for (const { start, end } of windows) {
              const n = Math.min(20000, Math.ceil((end - start) / step));
              const r = Array.from({ length: n + 1 }, (_, i) => range(start + (end - start) * i / n));
              for (let i = 1; i < n; i++) if (r[i] < r[i - 1] && r[i] <= r[i + 1]) { minima++; closestMinimumKm = Math.min(closestMinimumKm ?? Infinity, r[i]); }
              samples += n + 1;
              finite.push(...r.filter(Number.isFinite));
            }
            return { windows, samples, available: finite.length, minima, closestMinimumKm, minKm: finite.length ? Math.min(...finite) : null };
          };
        }, { test });
        const initial = await page.evaluate(() => window.__benchSnapshot());
        run.initialState = initial.stable;
        const started = performance.now();
        if (test.reliability) {
          // Same conversation, fresh scene: each turn is sent, finished and judged before the next.
          const context = {};
          run.result = { turns: [] };
          for (const [i, prompt] of promptsOf(test).entries()) {
            const turnStarted = performance.now();
            await page.getByRole('textbox', { name: 'Request', exact: true }).fill(prompt);
            await page.getByRole('button', { name: 'Send request', exact: true }).click();
            await page.waitForFunction(n => window.__askBench.ask.turns.length === n && window.__askBench.ask.turns.at(-1).status !== 'running', i + 1, { timeout: 240000 });
            const turn = await page.evaluate(() => { const t = window.__askBench.ask.turns.at(-1);
              return { prompt: t.prompt, status: t.status, errorCode: t.errorCode, reply: t.reply, stats: t.stats, verification: t.verification ?? null, unverified: !!t.unverified,
                wrote: t.steps.some(s => s.result?.ok && !/^(describe|get|list|resolve|search|check|find)/.test((s.name === 'invokeCapability' ? s.input.id : s.name).split('.').at(-1))),
                steps: t.steps.map(s => ({ name: s.name === 'invokeCapability' ? s.input.id : s.name, ok: s.result?.ok ?? null, receipt: s.result?.receipt?.status ?? null, code: s.result && !s.result.ok ? s.result.code : null })) }; });
            turn.latencyMs = Math.round(performance.now() - turnStarted);
            if (test.composition?.epochTurn === i) context.epoch = await page.evaluate(() => window.cosmo.getTime());
            if (test.composition?.closeTurn === i) context.closeRangeKm = (await page.evaluate(n => window.__probeComposition([n]), test.composition.anchor)).objects[0].rangeKm;
            if (test.event || test.refusal) { turn.eventQuery = await page.evaluate(() => window.__benchEvent()); context.query = turn.eventQuery?.id; }
            if (test.truth && i === promptsOf(test).length - 1) {
              // Over the window the request implies, fixed by the case rather than by the model's query:
              // every loaded-kernel coverage window of the pair inside the catalog, or the catalog's window.
              const w = await page.evaluate(t => {
                const o = window.cosmo.getEventSearchOptions(t.window === 'coverage' ? { kind: 'closest-approach', bodies: { observer: t.bodies[0], target: t.bodies[1] } } : undefined);
                if (t.window !== 'coverage') return [o.catalogWindow];
                return (o.coverage?.windows ?? []).map(x => ({ start: Math.max(x.start, o.catalogWindow.start), end: Math.min(x.end, o.catalogWindow.end) })).filter(x => x.end > x.start);
              }, test.truth);
              turn.truth = await page.evaluate(([t, w]) => window.__benchRange(t.bodies[0], t.bodies[1], w, t.stepSeconds), [test.truth, w]);
            }
            const goal = turnGoal(test, i, context);
            if (goal) {
              turn.goal = goal;
              turn.report = judgeTurn(goal, await page.evaluate(reads => window.__benchReads(reads), goalReads(goal)));
            }
            run.result.turns.push(turn);
            if (turn.status !== 'done') break; // a stopped conversation is the observation; do not keep spending
          }
          run.latencyMs = Math.round(performance.now() - started);
          run.score = scoreReliability(test, run.result.turns);
          run.classification = classify(test, run);
          run.suspectedFalseSuccess = suspectedFalseSuccess(run);
          run.usage = summarizeUsage(cellUsage);
          run.requestUsage = cellUsage.map(({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, estimatedUsd, upstreamLatencyMs, outputCalls }) => ({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, estimatedUsd, upstreamLatencyMs, outputCalls }));
          console.log(JSON.stringify({ task: test.id, arm, model, mode, classification: run.classification, rounds: rounds.length, rawTokens: run.usage.rawProcessed, estimatedUsd: run.usage.estimatedUsd }));
          continue;
        }
        await page.getByRole('textbox', { name: 'Request', exact: true }).fill(test.prompt);
        await page.getByRole('button', { name: 'Send request', exact: true }).click();
        await page.waitForFunction(() => window.__askBench.ask.turns.length && window.__askBench.ask.turns.at(-1).status !== 'running', null, { timeout: 240000 });
        run.latencyMs = Math.round(performance.now() - started);
        run.result = await page.evaluate(async () => {
          const turn = window.__askBench.ask.turns.at(-1);
          return { status: turn.status, errorCode: turn.errorCode, reply: turn.reply, state: await window.__benchSnapshot(),
            steps: turn.steps.map(s => ({ id: s.id, name: s.name === 'invokeCapability' ? s.input.id : s.name, ok: s.result?.ok ?? null,
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
        for (const step of run.result.steps) { step.modelVisible = visibleResults.get(step.id) ?? null; delete step.id; }
        if (test.viewpoint) run.result.state.navigation.poseMatches = poseMatches(run.result.state.camera, run.result.state.navigation.expectedPose);
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
        if (test.reliability) { run.classification = classify(test, run); run.suspectedFalseSuccess = false; }
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
  report.reliabilitySummary = summarizeReliability(report);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(`Report: ${output}`);
if (report.runs.some(r => r.failure)) process.exitCode = 1;
