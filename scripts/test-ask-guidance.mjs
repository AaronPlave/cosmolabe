/** Loaded explicit-starter/coverage/Stop regressions for #379. No external model calls.
 * CL_VIEWER_URL must point to this checkout's viewer. Optional captures stay local. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5299/';
const output = process.env.ASK_GUIDANCE_EVIDENCE;
if (output) mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const evidence = [];
try {
  for (const [catalog, subject] of [['earth-moon', 'Moon'], ['iss', 'ISS'], ['oem-ingest', 'Cassini'], ['europa-clipper', 'Europa Clipper']]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    let externalCalls = 0;
    await page.route('http://127.0.0.1:8799/**', route => { externalCalls++; return route.abort(); });
    await page.goto(`${base}?catalog=test-catalogs/${catalog}&test=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 });
    await page.evaluate(async () => {
      const loaded = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path);
      window.__state = await import(loaded('/src/lib/viewer-state.svelte.ts'));
      window.__ask = await import(loaded('/src/lib/ask/ask.svelte.ts'));
      const shell = await import(loaded('/src/lib/shell.svelte.ts'));
      window.__starterRequests = 0;
      window.__ask.setHostAskTransport({send: async () => {window.__starterRequests++;return {content:[{type:'text',text:'Local starter check.'}],stop:'end'};}});
      window.cosmo.setTimeRate(0); window.cosmo.setPlaying(false); window.cosmo.deselect(); shell.openTool('ask');
    });
    const snapshot = () => page.evaluate(() => { const c = window.cosmo; return { et: c.getTime(), selected: c.getSelected(), tracked: c.getTracked(), camera: c.getCamera(), turns: window.__ask.ask.turns.length }; });
    const initial = await snapshot();
    assert.equal(await page.locator('.ask-log').count(),0,'no empty transcript padding above the composer');
    await page.getByRole('button', { name: 'Try a question' }).click();
    const baseline = await page.evaluate(() => window.__ask.askExamples());
    const help = await page.evaluate(() => window.__ask.askHelp());
    assert.ok(help.categories.length > 0);
    assert.ok(help.authority.includes('Missing measurements'));
    const observed = await page.evaluate(() => window.__ask.askHelp());
    assert.deepEqual(observed.examples, baseline);
    assert.deepEqual(await snapshot(), initial);
    await page.evaluate(name => window.cosmo.select(name), subject);
    await page.waitForFunction(() => document.querySelector('[aria-label="Scene examples"]') === null);
    await page.getByRole('button', { name: 'Try a question' }).click();
    const examples = await page.evaluate(() => window.__ask.askExamples());
    const before = await snapshot();
    assert.equal(await page.evaluate(() => window.__starterRequests),0,'opening help makes no model call');
    const textbox=page.getByRole('textbox',{name:'Request',exact:true});
    const smallHeight=await textbox.evaluate(el=>el.clientHeight);
    await textbox.fill('A longer question about this scene. '.repeat(30));
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Request"]').clientHeight > 100);
    assert.ok(await textbox.evaluate(el=>el.clientHeight)>smallHeight,'composer grows with the prompt');
    await textbox.fill('Keep this draft');
    assert.ok(examples.length > 0 && examples.length <= 5);
    if (output) await page.screenshot({ path: `${output}/${catalog}-examples.png` });
    await page.getByRole('button', { name: `Ask: ${examples[0].label}`, exact: true }).click();
    await page.waitForFunction(() => window.__ask.ask.turns.at(-1)?.status === 'done');
    assert.equal(await page.evaluate(() => window.__ask.ask.turns.at(-1).prompt),examples[0].prompt);
    assert.equal(await page.evaluate(() => window.__starterRequests),1,'explicit starter click submits exactly once');
    assert.equal(await page.getByRole('textbox',{name:'Request',exact:true}).inputValue(),'Keep this draft');
    assert.deepEqual(await snapshot(),{...before,turns:before.turns+1},'the scripted starter response makes no scene mutation');
    assert.equal(externalCalls, 0);
    if (catalog === 'oem-ingest') {
      const coverage = await page.evaluate(() => {
        const c = window.cosmo, u = window.__state.getSceneUniverse(), trajectory = u.getBody('Cassini').trajectory;
        const first = trajectory.startTime, last = trajectory.endTime;
        const reads = [first - 1, first, (first + last) / 2, last, last + 1].map(et => ({ et, state: c.getObjectState('Cassini', { time: { kind: 'et', et }, center: 'Saturn' }) }));
        c.upsertProfile({ id: 'coverage-regression', label: 'Coverage', profile: { quantity: 'range', bodies: { observer: 'Cassini', target: 'Saturn' } }, enabled: true, visible: true });
        return { reads, samples: c.sampleProfileData('coverage-regression', { start: first - 1, end: last + 1, count: 5 }),
          display: [first - 1, last + 1].map(et => u.absolutePositionOf('Cassini', et, 'display')) };
      });
      assert.equal(coverage.reads[0].state.position, null); assert.equal(coverage.reads[4].state.position, null);
      assert.equal(coverage.reads[0].state.positionAvailability.reason, 'before-coverage');
      assert.equal(coverage.reads[4].state.positionAvailability.reason, 'after-coverage');
      for (const r of coverage.reads.slice(1, 4)) assert.equal(r.state.positionAvailability.available, true);
      assert.equal(coverage.samples.missing, 2); assert.equal(coverage.samples.status, 'partial');
      assert.ok(coverage.display.flat().every(Number.isFinite));
      evidence.push({ catalog, examples, baseline, coverage });
    } else evidence.push({ catalog, examples, baseline });
    if (catalog === 'earth-moon') {
      // Local scripted transport: apply one selection, hold the next reply,
      // click real Stop, then deliver a late attempted mutation.
      await page.evaluate(() => {
        let release;
        const late = new Promise(resolve => { release = resolve; });
        window.__release = () => release({ content: [{ type: 'tool_use', id: 'late', name: 'invokeCapability', input: { id: 'scene.select', input: { object: 'Sun' } } }], stop: 'tool_use' });
        let round = 0;
        window.__ask.setHostAskTransport({ send: () => ++round === 1 ? Promise.resolve({ content: [
          { type: 'tool_use', id: 'goal', name: 'checkGoal', input: { require: [] } },
          { type: 'tool_use', id: 'first', name: 'invokeCapability', input: { id: 'scene.select', input: { object: 'Moon' } } }
        ], stop: 'tool_use' }) : late });
        void window.__ask.submitAsk('Local Stop regression');
      });
      await page.waitForFunction(() => window.__ask.ask.turns.at(-1)?.steps.some(s => s.id === 'first' && s.result?.ok));
      await page.getByRole('button', { name: 'Stop request', exact: true }).click();
      const stopped = await snapshot();
      await page.evaluate(() => window.__release());
      await page.waitForTimeout(500);
      assert.deepEqual(await snapshot(), stopped);
      assert.equal((await page.evaluate(() => window.__ask.ask.turns.at(-1).status)), 'cancelled');
      evidence.at(-1).stop = { lateMutationRejected: true, stopped };
    }
    await context.close();
  }
  if (output) writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ catalogs: evidence.length, externalModelCalls: 0, explicitStarterSubmitsOnce: true, openingHelpCalls: 0, sourceBoundaries: true, stop: true }));
} finally { await browser.close(); }
