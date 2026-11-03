/** #334 deterministic UI-state coverage; fixture turns never call a provider. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const output = process.env.ASK_STATUS_OUTPUT ?? '/tmp/297-ask-status-ui';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } }), errors = [], states = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5797/'}?catalog=test-catalogs/cassini-soi`);
  await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 });
  await page.evaluate(async () => {
    const resource = path => performance.getEntriesByType('resource').map(e => e.name).find(u => new URL(u).pathname === path);
    window.__askUI = await import(resource('/src/lib/ask/ask.svelte.ts'));
    window.__askUI.setHostAskTransport({ request: async () => { throw new Error('Fixture UI must never call a provider'); } });
    const shell = await import(resource('/src/lib/shell.svelte.ts'));
    shell.enableTool('ask');
    shell.openTool('ask');
  });
  assert.equal(await page.locator('.ask-status').count(), 0, 'idle has no progress');
  for (const state of ['research', 'action', 'approval', 'completed', 'refused', 'cancelled']) {
    await page.evaluate(state => {
      const m = window.__askUI;
      const base = { fresh: null, notes: [], error: null, errorCode: null };
      const step = { id: 's', name: 'invokeCapability', input: { id: state === 'approval' ? 'bookmarks.removeBookmark' : 'events.runEventQuery' }, result: null };
      m.ask.turns = [
        { ...base, id: 1, prompt: 'What does this distance mean?', status: 'done', steps: [], reply: 'This fixture explains centre-to-centre distance. It measures between body centres, rather than altitude above a reference surface.\n\nThe actual searched window and loaded trajectory coverage bound the interpretation. Physical terrain clearance needs separate surface evidence.' },
        { ...base, id: 2, prompt: 'Show the encounter and pause there.', status: ['research','action','approval'].includes(state) ? 'running' : state === 'completed' ? 'done' : state === 'refused' ? 'refusal' : 'cancelled',
          steps: state === 'research' ? [] : [{ ...step, result: ['research','action','approval'].includes(state) ? null : state === 'completed' ? { ok: true, summary: 'Search completed' } : { ok: false, code: 'refused', error: 'Declined' } }],
          reply: state === 'completed' ? 'The encounter is selected and the clock is paused.\n\nThis is a fixture answer for checking the rendered transcript; no solver or provider was invoked.' : '' },
      ];
      m.askApproval.pending = state === 'approval' ? { kind: 'authoring', operation: 'bookmarks.removeBookmark', input: '{"name":"Here"}' } : null;
    }, state);
    const turn = page.locator('.ask-turn').last();
    await turn.locator('.ask-status').waitFor();
    assert.equal(await turn.locator('.ask-status').count(), 1);
    const status = await turn.locator('.ask-status').innerText();
    assert.ok(!/Working/.test(await turn.innerText()), 'no duplicate generic status');
    if (state === 'approval') assert.equal(status, 'Approval needed');
    if (state === 'action') assert.equal(status, 'Running Event Finder…');
    assert.equal(await turn.locator('.ask-actions[open]').count(), 0, 'history stays collapsed');
    const geometry = await page.locator('.ask-turn').first().evaluate(el => {
      const p = el.querySelector('.ask-prompt'), a = el.querySelector('.ask-answer');
      const pb = p.getBoundingClientRect(), ab = a.getBoundingClientRect();
      return { prompt: { x: pb.x, right: pb.right, width: pb.width }, answer: { x: ab.x, right: ab.right, width: ab.width }, surface: getComputedStyle(p).backgroundColor };
    });
    assert.ok(geometry.prompt.x > geometry.answer.x && geometry.prompt.width < geometry.answer.width);
    assert.ok(Math.abs(geometry.prompt.right - geometry.answer.right) < 2);
    assert.notEqual(geometry.surface, 'rgba(0, 0, 0, 0)');
    states.push({ state, status, geometry });
    if (['action','approval','completed'].includes(state)) await page.screenshot({ path: `${output}/${state}.png` });
  }
  // Reproduce a model-generated disclosure without trusting model HTML.
  await page.evaluate(() => {
    const turn = window.__askUI.ask.turns.at(-1);
    turn.status = 'done'; turn.steps = [];
    turn.prompt = 'Show me when Psyche spacecraft is in eclipse by 16 Psyche.';
    turn.reply = "I can't compute this eclipse: the loaded kernels report no occultation coverage. No search ran.\n<details>\n<summary>Details</summary>\nOccultation options queried for **Psyche**, the Sun and 16 Psyche.\n\nCoverage is unavailable; the earlier closest-approach result still stands.\n<img src=x onerror=alert(1)>\n</details>";
  });
  const disclosure = page.locator('.ask-turn').last().locator('.ask-answer-details');
  await disclosure.waitFor();
  assert.equal(await disclosure.getAttribute('open'), null);
  assert.equal(await disclosure.locator('summary').innerText(), 'Details');
  assert.equal(await disclosure.locator('div').isVisible(), false);
  assert.equal(await page.locator('.ask-answer img, .ask-answer script').count(), 0);
  await disclosure.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await disclosure.locator('div').isVisible(), true);
  assert.ok((await disclosure.innerText()).includes('Coverage is unavailable'));
  assert.ok(!(await page.locator('.ask-answer').last().innerText()).includes('<details>'));
  await page.screenshot({ path: `${output}/answer-details-open.png` });
  await disclosure.locator('summary').click();
  assert.equal(await disclosure.locator('div').isVisible(), false);
  await page.screenshot({ path: `${output}/answer-details-closed.png` });
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/report.json`, JSON.stringify({ fixtureOnly: true, states, answerDetails: { collapsedByDefault: true, keyboardOpened: true, clickClosed: true, htmlInert: true }, errors }, null, 2) + '\n');
} finally { await browser.close(); }
