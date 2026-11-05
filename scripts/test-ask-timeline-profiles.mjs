/** #359 bounded live Ask acceptance. Requires ASK_PROFILE_LIVE=1 and an approved
 * Anthropic key. Start a viewer with VITE_ASK_ENDPOINT=http://127.0.0.1:8797.
 * Pins normal AND escalation requests to Haiku; provider fallback is disabled.
 * No screenshots or raw model output are committed.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createProxy, anthropicProvider } from '../examples/ask-proxy/server.mjs';
assert.equal(process.env.ASK_PROFILE_LIVE, '1', 'Explicit live inference approval required');
assert.ok(process.env.ANTHROPIC_API_KEY, 'Configured Anthropic key required');
const model = 'claude-haiku-5-5';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5200/';
const output = process.env.ASK_PROFILE_REPORT ?? '/tmp/ask-profile-acceptance.json';
const listing = await fetch('https://api.anthropic.com/v1/models?limit=100', {
  headers: anthropicProvider.headers(process.env.ANTHROPIC_API_KEY), signal: AbortSignal.timeout(30000),
});
assert.ok(listing.ok, `Model availability HTTP ${listing.status}`);
assert.ok((await listing.json()).data.some(m => m.id === model), 'Pinned Haiku must be available');
const usage = [], report = { model, escalationModel: model, fallback: false,
  renderer: 'Chromium SwiftShader', cache: 'enabled, warmth uncontrolled', runs: [] };
const proxy = createProxy({ apiKey: process.env.ANTHROPIC_API_KEY, origins: [new URL(base).origin],
  provider: anthropicProvider, model, escalationModel: model, fallback: false, maxTokens: 1536,
  perMinute: 100, tokenBudget: 600000, costBudgetUsd: 0.5, cache: true,
  fetchImpl: (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, model); assert.equal(body.fallbacks, undefined);
    return fetch(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) });
  }, onUsage: row => { assert.equal(row.model, model); assert.equal(row.requestedModel, model); usage.push(row); },
});
await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(8797, '127.0.0.1', resolve); });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
try {
  for (const scenario of ['profile', 'clearance']) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const payloads = new Map(), rounds = [], errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => {
      if (request.url() !== 'http://127.0.0.1:8797/' || request.method() !== 'POST') return;
      const wire = request.postDataJSON();
      rounds.push(wire.tools.map(t => t.name));
      for (const message of wire.messages) for (const block of message.content) if (block.type === 'tool_result') payloads.set(block.toolUseId, block.content);
    });
    try {
      await page.goto(new URL('?catalog=test-catalogs/rosetta&test=1', base).href, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 });
      await page.evaluate(async () => {
        window.cosmo.setPlaying(false);
        const resource = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path);
        (await import(resource('/src/lib/shell.svelte.ts'))).openTool('ask');
        window.__askProfile = (await import(resource('/src/lib/ask/ask.svelte.ts'))).ask;
      });
      const snapshot = () => page.evaluate(() => {
        const c = window.cosmo;
        return { time: c.getTime(), playing: c.isPlaying(), selected: c.getSelected(), tracked: c.getTracked(), camera: c.getCamera(), window: c.getTimelineWindow() };
      });
      const before = await snapshot();
      const prompts = scenario === 'profile'
        ? ['show a distance profile between Philae and 67P in the timeline', 'not closest approach; I want the profile in the timeline']
        : ["show Philae's height above 67P's physical surface in the timeline", 'I accept a center-to-center distance profile instead; label it as center distance, not physical surface height.'];
      for (const [index, prompt] of prompts.entries()) {
        const usageStart = usage.length, roundsStart = rounds.length;
        console.log(`Running ${scenario} ${index + 1} (${model})`);
        await page.getByRole('textbox', { name: 'Request', exact: true }).fill(prompt);
        await page.getByRole('button', { name: 'Send request', exact: true }).click();
        await page.waitForFunction(n => window.__askProfile.turns.length > n && window.__askProfile.turns.at(-1).status !== 'running', index, { timeout: 240000 });
        const result = await page.evaluate(() => {
          const turn = window.__askProfile.turns.at(-1), c = window.cosmo;
          return { status: turn.status, error: turn.error, reply: turn.reply,
            profiles: c.listProfiles().items.map(p => c.getProfile(p.id)), events: c.listEventQueries().length,
            steps: turn.steps.map(s => ({ id: s.id, name: s.name === 'invokeCapability' ? s.input.id : s.name, input: s.input,
              ok: s.result?.ok, receipt: s.result?.receipt?.status, data: s.result?.ok ? s.result.data : undefined,
              error: s.result && !s.result.ok ? s.result.error : undefined })) };
        });
        const rows = usage.slice(usageStart);
        const factualWarnings = scenario === 'clearance' && index === 0 && /\bno\s+(?:(?:physical|terrain|or|surface)\s+){0,5}models?\b|\bno surface to measure against\b|\blacks (?:a )?(?:terrain|surface) model/i.test(result.reply) ? ['Unsupported claim that the scene has no physical surface model; the catalog supplies DSK geometry.'] : [];
        const run = { scenario, turn: index + 1, prompt, factualWarnings, rounds: rounds.length - roundsStart, result, usage: rows,
          unchangedScene: JSON.stringify(await snapshot()) === JSON.stringify(before),
          delivered: result.steps.map(s => ({ id: s.id, name: s.name, content: payloads.get(s.id) ?? null })) };
        report.runs.push(run); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ scenario, turn: index + 1, rounds: run.rounds, status: result.status, reply: result.reply,
          profiles: result.profiles.map(p => ({ id: p.definition?.id, quantity: p.resolved?.quantity, status: p.status, timeline: p.timeline })), steps: result.steps.map(s => [s.name,s.ok,s.receipt]) }));
        assert.equal(result.status, 'done', result.error);
        assert.equal(run.unchangedScene, true, 'Adding a profile must not move the scene');
        assert.equal(result.events, 0, 'Do not substitute Event Finder');
        assert.ok(!result.steps.some(s => /setTimelineWindow|setTime$/.test(s.name)), 'Do not change the window or epoch just to add a profile');
        assert.ok(result.steps.filter(s => s.name === 'profiles.upsertProfile' && s.receipt).length <= 1, 'Do not retry an accepted partial profile mutation');
        if (scenario === 'clearance' && index === 0) {
          assert.equal(result.profiles.length, 0, 'Physical clearance must not silently become center distance');
          assert.match(result.reply, /surface|clearance|height/i);
        } else {
          assert.equal(result.profiles.length, 1, 'Reuse the same native profile on a correction');
          const profile = result.profiles[0];
          assert.equal(profile.resolved.quantity, 'range');
          assert.deepEqual(profile.resolved.bodies, { observer: 'Philae', target: '67P/Churyumov-Gerasimenko' });
          assert.equal(profile.definition.visible, true); assert.equal(profile.definition.enabled, true);
          assert.equal(profile.timeline.present, true); assert.equal(profile.timeline.traceVisible, true);
          const read = result.steps.find(s => s.name === 'profiles.getProfile' && s.ok);
          assert.ok(read, 'Model must read the actual profile');
          assert.ok(payloads.get(read.id)?.includes('traceVisible'), 'Profile read must be delivered to the provider');
          assert.ok(!payloads.get(read.id)?.includes('result-too-large'));
          const delivered = JSON.parse(payloads.get(read.id));
          assert.equal(delivered.data.resolved.quantity, 'range');
          assert.equal(delivered.data.timeline.present, true);
          assert.equal(delivered.data.timeline.traceVisible, true);
          if (scenario === 'clearance') {
            assert.match(profile.definition.label, /cent(?:er|re)/i);
            assert.match(profile.definition.label, /not.*(?:surface|height)/i);
          }
        }
      }
      assert.deepEqual(errors, []);
      assert.ok(rounds[0].includes('resolve'), 'Use production default fixed Ask tools');
    } finally { await page.close(); }
  }
  assert.ok(usage.length > 0 && usage.every(r => r.model === model));
  console.log(`PASS: functional Haiku-only profile requests, correction, physical-clearance refusal and explicitly accepted center-distance alternative (${usage.length} model rounds)`);
  assert.deepEqual(report.runs.flatMap(r => r.factualWarnings), [], 'Factual acceptance: do not infer absent DSK surface models from null terrain metadata');
} finally {
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  await browser.close(); await new Promise(resolve => proxy.close(resolve));
}
