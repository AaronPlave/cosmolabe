#!/usr/bin/env node
/**
 * Acceptance test for the embeddable workspace, driven through the reference
 * host (examples/embed-host): a plain Vite + TypeScript page that mounts the
 * complete workspace from the built package and supplies two spacecraft,
 * mission activities, time and selection.
 *
 * Every check compares the viewer against the host's closed-form fixtures —
 * positions, frames, quaternions, coverage reasons — or against the page
 * itself (host styles, globals, listeners, workers, WebGL contexts). Run
 * after `npm run build:embed`:
 *
 *   node scripts/test-embed-host.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = path.join(ROOT, 'examples/embed-host');
const PORT = Number(process.env.EMBED_HOST_PORT ?? 5297);
const vite = path.join(ROOT, 'node_modules/.bin/vite');

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

// The host as a consumer ships it: a production build, served statically.
await run(vite, ['build', '--logLevel', 'warn'], { cwd: HOST });
const server = spawn(vite, ['preview', '--port', String(PORT), '--strictPort'], { cwd: HOST, stdio: 'pipe' });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
  server.on('exit', (code) => reject(new Error(`vite preview exited ${code}`)));
});

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
// A request the test aborts on purpose is logged by the browser; that one is expected.
let expectedAborts = 0;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (expectedAborts > 0 && /net::ERR_FAILED/.test(m.text())) { expectedAborts--; return; }
  problems.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

// Count what the page attaches to window/document, the workers it starts and
// the WebGL contexts it makes — before any Cosmolabe code runs.
await page.addInitScript(() => {
  const listeners = new Map();
  const key = (t, type, fn, opts) => `${t === window ? 'window' : 'document'}|${type}|${typeof opts === 'boolean' ? opts : !!opts?.capture}`;
  const ids = new WeakMap(); let next = 0;
  const id = (fn) => { if (!ids.has(fn)) ids.set(fn, ++next); return ids.get(fn); };
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((this === window || this === document) && fn) listeners.set(`${key(this, type, fn, opts)}|${id(fn)}`, type);
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if ((this === window || this === document) && fn) listeners.delete(`${key(this, type, fn, opts)}|${id(fn)}`);
    return remove.call(this, type, fn, opts);
  };
  const workers = [];
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...a) { super(...a); this.__live = true; workers.push(this); }
    terminate() { this.__live = false; return super.terminate(); }
  };
  const contexts = [];
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...a) {
    const ctx = getContext.call(this, kind, ...a);
    if (ctx && /webgl/.test(kind) && !contexts.includes(ctx)) contexts.push(ctx);
    return ctx;
  };
  window.__probe = {
    listeners: () => [...listeners.values()].sort(),
    liveWorkers: () => workers.filter((w) => w.__live).length,
    workers: () => workers.length,
    liveContexts: () => contexts.filter((c) => !c.isContextLost()).length,
  };
});

let passed = 0;
let disposedListeners = [];
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
const assert = (ok, message) => { if (!ok) throw new Error(message); };

/** Evaluate in the page with the host and its viewer in scope. */
const inPage = (fn, arg) => page.evaluate(fn, arg);

/** Seek through the host's control, then wait until both spacecraft states have settled (loaded or known absent). */
async function seek(offset) {
  await inPage(async (s) => {
    const { viewer, T0 } = window.host;
    viewer.control.setPlaying(false);
    viewer.control.setTime({ kind: 'et', et: T0 + s });
    const settled = () => ['SC-1', 'SC-2'].filter((n) => viewer.control.listObjects().includes(n)).every((n) => {
      const st = viewer.control.getObjectState(n);
      return st.positionAvailability.reason !== 'pending' && st.attitudeAvailability?.reason !== 'pending';
    });
    for (let i = 0; i < 200 && !settled(); i++) await new Promise((r) => setTimeout(r, 25));
  }, offset);
}

try {
  await page.goto(`http://localhost:${PORT}/?manual`);
  await page.waitForFunction(() => window.host);

  const hostStyle = () => inPage(() => {
    const cs = (sel, props) => { const s = getComputedStyle(document.querySelector(sel)); return props.map((p) => s.getPropertyValue(p)); };
    return JSON.stringify({
      body: cs('body', ['font-family', 'font-size', 'line-height', 'background-color', 'margin']),
      h1: cs('h1', ['font-family', 'font-size', 'letter-spacing']),
      button: cs('header button', ['font-family', 'background-color', 'border-radius', 'box-sizing', 'padding']),
      footer: cs('.host-footer', ['font-family', 'color']),
      title: document.title, href: location.href, history: history.length,
    });
  });
  const before = await hostStyle();
  const bareListeners = await inPage(() => window.__probe.listeners());

  console.log('Mount and lifecycle');
  await check('a mount that fails on a later source releases the earlier one, and a retry mounts clean', async () => {
    const r = await inPage(async () => {
      const { mountCosmolabe } = window.host;
      let unsubscribed = 0;
      const valid = {
        id: 'probe', position: { timeScale: 'TDB', frame: 'J2000', center: 'Earth', positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: 60 },
        subscribe: () => () => { unsubscribed++; },
      };
      const invalid = { id: 'bad', position: { ...valid.position, maxSampleSpacing: -1 } };
      let error = null;
      try { await mountCosmolabe(document.getElementById('viewer'), { missionState: [valid, invalid] }); } catch (e) { error = e.message; }
      const leftovers = { shadow: document.getElementById('viewer').shadowRoot?.childElementCount ?? 0, style: !!document.querySelector('style[data-cosmolabe]') };
      const retry = await mountCosmolabe(document.getElementById('viewer'), { missionState: [valid] });
      await retry.dispose();
      return { error, unsubscribed, leftovers };
    });
    assert(/maxSampleSpacing/.test(r.error ?? ''), `mount did not reject: ${r.error}`);
    // Once for the failed mount, once for the retry's dispose.
    assert(r.unsubscribed === 2, `unsubscribe ran ${r.unsubscribed} times`);
    assert(r.leftovers.shadow === 0 && !r.leftovers.style, JSON.stringify(r.leftovers));
  });
  await check('mounts the complete workspace and reports ready', async () => {
    await inPage(() => window.host.mount());
    const ready = await inPage(() => window.host.seen.ready?.[0]?.objects ?? []);
    assert(['Sun', 'Earth', 'SC-1', 'SC-2'].every((n) => ready.includes(n)), `ready objects: ${ready}`);
    const ui = await inPage(() => {
      const root = document.getElementById('viewer').shadowRoot;
      return { canvas: !!root.querySelector('canvas'), rail: !!root.querySelector('[aria-label="Search commands"]'), timeline: !!root.querySelector('[aria-label="Choose activity"]') };
    });
    assert(ui.canvas && ui.rail && ui.timeline, `workspace pieces present: ${JSON.stringify(ui)}`);
  });
  await check('refuses a second concurrent mount', async () => {
    const message = await inPage(async () => {
      try { await window.host.mountCosmolabe(document.querySelector('.host-footer')); return 'mounted'; } catch (e) { return e.message; }
    });
    assert(/already mounted/.test(message), message);
  });

  console.log('Host-page isolation');
  await check('host typography, controls, title, URL and history are untouched', async () => {
    const after = await hostStyle();
    assert(after === before, `before ${before}\nafter  ${after}`);
  });
  await check('host styles do not reach the workspace', async () => {
    const s = await inPage(() => {
      const b = document.getElementById('viewer').shadowRoot.querySelector('button[aria-label="Search commands"]');
      const cs = getComputedStyle(b);
      return { bg: cs.backgroundColor, font: cs.fontFamily, sizing: cs.boxSizing };
    });
    assert(s.bg !== 'rgb(255, 105, 180)' && !/Georgia/.test(s.font) && s.sizing === 'border-box', JSON.stringify(s));
  });
  await check('no globals written into the host window', async () => {
    const g = await inPage(() => ({ cosmo: 'cosmo' in window, renderer: 'renderer' in window }));
    assert(!g.cosmo && !g.renderer, JSON.stringify(g));
  });
  await check('host keystrokes stay the host\'s', async () => {
    await inPage(() => window.host.viewer.control.setPlaying(false));
    const t0 = await inPage(() => window.host.viewer.control.getTime());
    await page.click('h1');
    for (const key of ['ArrowRight', 'Space', 'KeyW', 'KeyT']) await page.keyboard.press(key);
    await page.waitForTimeout(200);
    const after = await inPage(() => ({ t: window.host.viewer.control.getTime(), playing: window.host.viewer.control.isPlaying() }));
    assert(after.t === t0 && !after.playing, `a host keystroke reached the viewer: ${JSON.stringify(after)} (from ${t0})`);
  });

  console.log('Scientific correctness (against closed-form fixtures)');
  await check('scenario epoch: UTC → ET through the leap-second pathway', async () => {
    const T0 = await inPage(() => window.host.T0);
    // Independently: seconds from the J2000 UTC instant, plus (37 − 32) leap seconds.
    const expected = (Date.parse('2026-03-20T12:00:00Z') - Date.UTC(2000, 0, 1, 11, 58, 55, 816)) / 1000 + 5;
    assert(Math.abs(T0 - expected) < 1e-6, `${T0} vs ${expected}`);
  });
  for (const offset of [1000.5, 2463.25, 5000, 7200, 7230.7, 300]) {
    await check(`positions in their own and in converted frames at T0+${offset}s`, async () => {
      await seek(offset);
      const r = await inPage((s) => {
        const { viewer, T0, fixtures } = window.host;
        const et = T0 + s;
        // ECLIPJ2000 as SPICE defines it: the IAU 1976 obliquity, 84381.448″.
        const eps = (84381.448 / 3600) * Math.PI / 180;
        const toEcl = (v) => [v[0], Math.cos(eps) * v[1] + Math.sin(eps) * v[2], -Math.sin(eps) * v[1] + Math.cos(eps) * v[2]];
        const toEq = (v) => [v[0], Math.cos(eps) * v[1] - Math.sin(eps) * v[2], Math.sin(eps) * v[1] + Math.cos(eps) * v[2]];
        const err = (a, b) => (a ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);
        const sc1 = fixtures.sc1State(et).position, sc2 = fixtures.sc2State(et).position;
        const get = (n, frame) => viewer.control.getObjectState(n, { frame, center: 'Earth' }).position;
        return {
          sc1J2000: err(get('SC-1', 'J2000'), sc1), sc1Ecl: err(get('SC-1', 'ECLIPJ2000'), toEcl(sc1)),
          sc2Ecl: err(get('SC-2', 'ECLIPJ2000'), sc2), sc2J2000: err(get('SC-2', 'J2000'), toEq(sc2)),
          frameMistake: err(toEcl(sc1), sc1),
        };
      }, offset);
      assert(r.sc1J2000 < 1e-3 && r.sc1Ecl < 1e-3, `SC-1 errors (km): ${JSON.stringify(r)}`);
      assert(r.sc2Ecl < 5e-3 && r.sc2J2000 < 5e-3, `SC-2 errors (km): ${JSON.stringify(r)}`);
      assert(r.frameMistake > 100, 'fixture would not expose a frame mistake here');
    });
  }
  await check('attitudes: SC-1 LVLH (scalar-first, ref→body) and SC-2 spin (scalar-last, body→ref)', async () => {
    for (const offset of [1000.5, 3333.3]) {
      await seek(offset);
      const r = await inPage((s) => {
        const { viewer, T0, fixtures } = window.host;
        const et = T0 + s;
        const angle = (a, b) => Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b)));
        const sc1 = viewer.control.getObjectState('SC-1', { frame: 'J2000' });
        const sc2 = viewer.control.getObjectState('SC-2', { frame: 'ECLIPJ2000' });
        const st1 = fixtures.sc1State(et);
        const nadir = st1.position.map((x) => -x);
        const sc2x = fixtures.bodyAxisInReference(fixtures.sc2BodyToReference(et).map((x, k) => (k ? -x : x)), [1, 0, 0]);
        return {
          sc1Z: angle(fixtures.bodyAxisInReference(sc1.attitude, [0, 0, 1]), nadir),
          sc1X: angle(fixtures.bodyAxisInReference(sc1.attitude, [1, 0, 0]), st1.velocity),
          sc2Z: angle(fixtures.bodyAxisInReference(sc2.attitude, [0, 0, 1]), fixtures.SC2_SPIN_AXIS),
          sc2X: angle(fixtures.bodyAxisInReference(sc2.attitude, [1, 0, 0]), sc2x),
          // The same SC-1 axis read in the wrong frame is far off: frames matter for attitude too.
          sc1ZinEcl: angle(fixtures.bodyAxisInReference(viewer.control.getObjectState('SC-1', { frame: 'ECLIPJ2000' }).attitude, [0, 0, 1]), nadir),
        };
      }, offset);
      assert(r.sc1Z < 1e-6 && r.sc1X < 1e-6, `SC-1 axis errors (rad): ${JSON.stringify(r)}`);
      assert(r.sc2Z < 1e-6 && r.sc2X < 1e-6, `SC-2 axis errors (rad): ${JSON.stringify(r)}`);
      assert(r.sc1ZinEcl > 0.01, 'fixture would not expose an attitude frame mistake');
    }
  });

  console.log('Coverage, gaps and availability');
  await check('independent position and attitude gaps, before/after coverage', async () => {
    const at = async (s) => { await seek(s); return inPage(() => ['SC-1', 'SC-2'].map((n) => {
      const st = window.host.viewer.control.getObjectState(n);
      return [n, st.position ? 'P' : st.positionAvailability.reason, st.attitude ? 'A' : st.attitudeAvailability?.reason];
    })); };
    const expect = (got, want, label) => assert(JSON.stringify(got) === JSON.stringify(want), `${label}: ${JSON.stringify(got)}`);
    expect(await at(3750), [['SC-1', 'gap', 'A'], ['SC-2', 'P', 'A']], 'SC-1 position gap');
    expect(await at(5550), [['SC-1', 'P', 'gap'], ['SC-2', 'P', 'A']], 'SC-1 attitude gap');
    expect(await at(8000), [['SC-1', 'P', 'A'], ['SC-2', 'P', 'after-coverage']], 'SC-2 attitude ended, position continues');
    expect(await at(-600), [['SC-1', 'before-coverage', 'before-coverage'], ['SC-2', 'before-coverage', 'before-coverage']], 'before coverage');
  });
  await check('the inspector says why, and draws no stale range', async () => {
    await seek(3750);
    await inPage(() => window.host.viewer.control.select('SC-1'));
    const text = await page.locator('#viewer [data-state-status]').innerText();
    assert(/No samples within 30 s/.test(text) && /Reconstructed/.test(text), text);
  });

  console.log('Activities');
  await check('host activities appear in the existing lanes beside catalog-owned ones', async () => {
    const ids = await inPage(() => window.host.viewer.control.listActivities().map((a) => a.id));
    for (const id of ['catalog-campaign', 'sc1-downlink-1', 'sc1-trim-1', 'sc2-perigee-1', 'sc2-imaging-1']) assert(ids.includes(id), `missing ${id}: ${ids}`);
    await page.locator('#viewer button[aria-label="Expand timeline"]').first().click();
    const marks = await page.locator('#viewer .activity-mark').count();
    await page.locator('#viewer button[aria-label="Collapse timeline"]').first().click();
    assert(marks >= 5, `activity marks: ${marks}`);
  });
  await check('selection, inspector, seeking and navigation through the shared operations', async () => {
    await inPage(() => window.host.viewer.control.selectActivity('sc2-perigee-1'));
    await page.locator('#viewer .inspector').waitFor();
    const inspector = await page.locator('#viewer .inspector').innerText();
    assert(/Perigee pass/.test(inspector), inspector);
    const r = await inPage(() => {
      const c = window.host.viewer.control;
      c.seekActivity('sc1-trim-1');
      const t = c.getTime() - window.host.T0;
      c.navigateActivity('previous');
      return { t, selected: c.getSelectedActivity()?.id, events: window.host.seen.activitySelect.map((e) => e.id) };
    });
    assert(r.t === 4500, `seekActivity landed at T0+${r.t}`);
    assert(r.selected === 'sc1-trim-1' && r.events.includes('sc2-perigee-1'), JSON.stringify(r));
  });
  await check('viewer-driven activity navigation notifies the host', async () => {
    const n = await inPage(() => window.host.seen.activitySelect.length);
    await page.locator('#viewer button[aria-label="Previous activity"]').first().click();
    const r = await inPage(() => ({ events: window.host.seen.activitySelect.slice(-1), time: window.host.seen.time.at(-1) }));
    assert(r.events.length && r.events[0].id && (await inPage(() => window.host.seen.activitySelect.length)) > n, JSON.stringify(r));
    assert(r.time.cause === 'viewer', `seek cause: ${JSON.stringify(r.time)}`);
  });
  await check('replacing a host source never touches catalog records nor reselects a removed ID', async () => {
    const r = await inPage(() => {
      const { viewer, missionPlan } = window.host;
      const c = viewer.control;
      c.selectActivity('sc2-imaging-1');
      viewer.activities.replace('mission-plan', missionPlan().filter((a) => a.id !== 'sc2-imaging-1'));
      const cleared = c.getSelectedActivity()?.id ?? null;
      viewer.activities.replace('mission-plan', missionPlan());
      return { cleared, after: c.getSelectedActivity()?.id ?? null, ids: c.listActivities().map((a) => a.id), last: window.host.seen.activitySelect.at(-1) };
    });
    assert(r.cleared === null && r.after === null && r.last.id === null, JSON.stringify(r));
    assert(r.ids.includes('catalog-campaign') && r.ids.includes('sc2-imaging-1'), JSON.stringify(r.ids));
    const clash = await inPage(() => { try { window.host.viewer.activities.replace('other-tool', [{ ...window.host.missionPlan()[0] }]); return 'accepted'; } catch (e) { return e.message; } });
    assert(/duplicate activity id/.test(clash), `ID clash across owners: ${clash}`);
  });

  console.log('Clock and selection synchronization');
  await check('host seeks are labelled as the host\'s; repeats are not re-processed', async () => {
    const r = await inPage(() => {
      const { viewer, T0, seen } = window.host;
      const n = seen.time.length;
      viewer.control.setTime({ kind: 'et', et: T0 + 1234 });
      viewer.control.setTime({ kind: 'et', et: T0 + 1234 });
      return seen.time.slice(n);
    });
    assert(r.length === 1 && r[0].cause === 'host' && r[0].et === (await inPage(() => window.host.T0 + 1234)), JSON.stringify(r));
  });
  await check('viewer-driven time (keyboard in the focused workspace) is labelled viewer', async () => {
    await page.locator('#viewer canvas').click({ position: { x: 300, y: 40 } });
    const n = await inPage(() => window.host.seen.time.length);
    await page.keyboard.press('ArrowRight');
    const r = await inPage((k) => window.host.seen.time.slice(k), n);
    assert(r.length >= 1 && r.every((e) => e.cause === 'viewer'), JSON.stringify(r));
  });
  await check('playback notifications are coalesced and end on the clock\'s value', async () => {
    const r = await inPage(async () => {
      const { viewer, seen } = window.host;
      const c = viewer.control;
      const n = seen.time.length;
      let frames = 0;
      const tick = () => { frames++; if (c.isPlaying()) requestAnimationFrame(tick); };
      c.setTimeRate(30);
      c.setPlaying(true);
      requestAnimationFrame(tick);
      await new Promise((res) => setTimeout(res, 1500));
      c.setPlaying(false);
      await new Promise((res) => setTimeout(res, 400));
      const events = seen.time.slice(n).filter((e) => e.cause === 'playback');
      return { events: events.length, frames, last: events.at(-1)?.et, now: c.getTime() };
    });
    assert(r.events >= 3 && r.events <= 10 && r.frames > r.events, `coalescing: ${JSON.stringify(r)}`);
    assert(r.last === r.now, `last playback notification ${r.last} vs clock ${r.now}`);
  });
  await check('selection both ways', async () => {
    await inPage(() => window.host.viewer.control.select('SC-2'));
    assert((await page.locator('#selection').innerText()) === 'SC-2', 'host did not see its own select');
    await page.locator('#viewer button[aria-label="Close SC-2"]').click();
    const r = await inPage(() => ({ last: window.host.seen.select.at(-1), selected: window.host.viewer.control.getSelected() }));
    assert(r.last.name === null && r.selected === null, JSON.stringify(r));
  });

  console.log('Source orchestration');
  await check('rapid seeks abort obsolete requests; late answers are discarded', async () => {
    const r = await inPage(async () => {
      const { viewer, archive, archiveSource, T0 } = window.host;
      archive.latencyMs = 600;
      archive.ignoreAbort = true; // a backend that answers anyway
      viewer.missionState.replaceSource(archiveSource(archive, 'sc2')); // empty cache
      const n = archive.log.length;
      viewer.control.setTime({ kind: 'et', et: T0 + 5000 });
      viewer.control.setTime({ kind: 'et', et: T0 + 13000 });
      await new Promise((res) => setTimeout(res, 1500));
      archive.latencyMs = 40;
      archive.ignoreAbort = false;
      const status = viewer.missionState.status('sc2');
      return {
        log: archive.log.slice(n).map((e) => [Math.round(e.start - T0), Math.round(e.end - T0), e.outcome]),
        stale: status.position.loaded.some((w) => w.start <= T0 + 5000 && w.end >= T0 + 5000),
        current: viewer.control.getObjectState('SC-2').positionAvailability.available,
      };
    });
    assert(r.log.some(([a, b, o]) => a <= 5000 && b >= 5000 && o === 'aborted'), `no aborted request: ${JSON.stringify(r.log)}`);
    assert(!r.stale && r.current, JSON.stringify(r));
  });
  await check('source replacement takes effect without a scene rebuild', async () => {
    await seek(2000);
    const r = await inPage(async () => {
      const { viewer, archive, archiveSource, T0, fixtures } = window.host;
      const objects = viewer.control.listObjects().join();
      archive.sc2OffsetM = [2000, 0, 0];
      viewer.missionState.replaceSource(archiveSource(archive, 'sc2', { version: '2' }));
      for (let i = 0; i < 100 && !viewer.control.getObjectState('SC-2').position; i++) await new Promise((res) => setTimeout(res, 25));
      const p = viewer.control.getObjectState('SC-2', { frame: 'ECLIPJ2000' }).position;
      const truth = fixtures.sc2State(T0 + 2000).position;
      archive.sc2OffsetM = [0, 0, 0];
      return { dx: p[0] - truth[0], dyz: Math.hypot(p[1] - truth[1], p[2] - truth[2]), same: viewer.control.listObjects().join() === objects };
    });
    assert(Math.abs(r.dx - 2) < 1e-3 && r.dyz < 1e-3 && r.same, JSON.stringify(r));
  });
  await check('live updates extend coverage; pending, stale and disconnected are distinct', async () => {
    const r = await inPage(async () => {
      const { viewer, archive, live, T0 } = window.host;
      const c = viewer.control;
      const edge = 4 * 3600;
      live.advance(240, archive);
      c.setTime({ kind: 'et', et: T0 + edge + 120 });
      const liveData = c.getObjectState('SC-1').positionAvailability.available;
      const win = c.getTimelineWindow();
      c.setTime({ kind: 'et', et: T0 + edge + 400 });
      const pending = c.getObjectState('SC-1').positionAvailability.reason;
      await new Promise((res) => setTimeout(res, 3300));
      c.setTime({ kind: 'et', et: T0 + edge + 401 });
      const stale = c.getObjectState('SC-1').positionAvailability.reason;
      live.setConnected(false);
      const disconnected = c.getObjectState('SC-1').positionAvailability.reason;
      live.setConnected(true);
      return { liveData, inWindow: win.start <= T0 + edge + 120 && win.end >= T0 + edge + 120, pending, stale, disconnected };
    });
    assert(r.liveData && r.inWindow, JSON.stringify(r));
    assert(r.pending === 'pending' && r.stale === 'stale' && r.disconnected === 'disconnected', JSON.stringify(r));
  });

  console.log('Resizing and scene switching');
  await check('follows its container, including into the compact layout', async () => {
    await page.click('#narrow');
    await page.waitForTimeout(400);
    const narrow = await inPage(() => {
      const root = document.getElementById('viewer').shadowRoot;
      return { w: root.querySelector('canvas').clientWidth, h: root.querySelector('canvas').clientHeight, px: root.querySelector('canvas').width, compact: !!root.querySelector('.compact-dock') };
    });
    await page.click('#narrow');
    await page.waitForTimeout(400);
    const wide = await inPage(() => ({ w: document.getElementById('viewer').shadowRoot.querySelector('canvas').clientWidth, compact: !!document.getElementById('viewer').shadowRoot.querySelector('.compact-dock') }));
    assert(Math.abs(narrow.w - 600) <= 2 && Math.abs(narrow.h - 480) <= 2 && narrow.compact, `narrow ${JSON.stringify(narrow)}`);
    assert(narrow.px === Math.round(narrow.w * (await inPage(() => devicePixelRatio))), `drawing buffer ${narrow.px} for ${narrow.w} CSS px`);
    assert(wide.w > 900 && !wide.compact, `wide ${JSON.stringify(wide)}`);
  });
  await check('switches scenes; sources, activities and subscriptions carry over', async () => {
    const r = await inPage(async () => {
      const { viewer, sceneCatalog, seen } = window.host;
      const n = seen.ready.length;
      await viewer.loadCatalog({ json: sceneCatalog(false), baseUrl: document.baseURI });
      const without = viewer.control.listObjects();
      const acts = viewer.control.listActivities().length;
      await viewer.loadCatalog({ json: sceneCatalog(true), baseUrl: document.baseURI });
      return { without, acts, with: viewer.control.listObjects(), readies: seen.ready.length - n, sources: viewer.missionState.sourceIds() };
    });
    assert(!r.without.includes('SC-2') && r.with.includes('SC-2') && r.readies === 2, JSON.stringify(r));
    assert(r.acts >= 5 && r.sources.join() === 'sc1,sc2', JSON.stringify(r));
    await seek(2463.25);
    const err = await inPage(() => {
      const { viewer, T0, fixtures } = window.host;
      const p = viewer.control.getObjectState('SC-1', { frame: 'J2000' }).position, t = fixtures.sc1State(T0 + 2463.25).position;
      return Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    });
    assert(err < 1e-3, `SC-1 after scene switch: ${err} km`);
  });
  await check('host activities clashing with a newly loaded catalog reject the load, naming the owner', async () => {
    const r = await inPage(async () => {
      const { viewer, sceneCatalog } = window.host;
      await viewer.loadCatalog({ json: { ...sceneCatalog(true), activities: [] }, baseUrl: document.baseURI });
      // Registered while no scene record holds the ID; the next catalog does.
      viewer.activities.replace('clash', [structuredClone(sceneCatalog().activities[0])]);
      let error = null;
      try { await viewer.loadCatalog({ json: sceneCatalog(true), baseUrl: document.baseURI }); } catch (e) { error = { name: e.name, conflicts: e.conflicts }; }
      const ids = viewer.control.listActivities().map((a) => a.id);
      const owners = viewer.activities.owners();
      viewer.activities.remove('clash');
      return { error, ids, owners, objects: viewer.control.listObjects() };
    });
    assert(r.error?.name === 'ActivityConflictError' && r.error.conflicts.length === 1 && r.error.conflicts[0].owner === 'clash', JSON.stringify(r.error));
    // The scene is up, the catalog's record and the other owners' are shown, the clashing owner is not.
    assert(r.objects.includes('SC-2') && r.ids.filter((id) => id === 'catalog-campaign').length === 1 && r.ids.includes('sc2-perigee-1'), JSON.stringify(r));
    assert(r.owners.includes('clash') && r.owners.includes('mission-plan'), JSON.stringify(r.owners));
  });

  console.log('Disposal and remount');
  await check('dispose releases everything and leaves the page as it found it', async () => {
    const r = await inPage(async () => {
      const { viewer } = window.host;
      await viewer.dispose();
      await new Promise((res) => setTimeout(res, 100));
      const shadow = document.getElementById('viewer').shadowRoot;
      return {
        shadowChildren: shadow.childElementCount,
        globalStyle: !!document.querySelector('style[data-cosmolabe]'),
        liveWorkers: window.__probe.liveWorkers(), workers: window.__probe.workers(),
        liveContexts: window.__probe.liveContexts(),
        listeners: window.__probe.listeners(),
      };
    });
    await inPage(() => { window.host.viewer = null; });
    assert(r.shadowChildren === 0 && !r.globalStyle, JSON.stringify(r));
    assert(r.liveWorkers === 0, `workers still running: ${r.liveWorkers} of ${r.workers}`);
    assert(r.liveContexts === 0, `WebGL contexts not released: ${r.liveContexts}`);
    // Svelte's runtime registers one document 'reset' listener the first time
    // any component binds a form value, and keeps it for the page's life. It
    // is inert for host forms and does not grow with remounts (checked below).
    const extra = r.listeners.filter((l, i) => r.listeners.indexOf(l) === i && r.listeners.filter((x) => x === l).length > bareListeners.filter((x) => x === l).length);
    const leaked = extra.filter((l) => l !== 'reset');
    disposedListeners = r.listeners;
    assert(leaked.length === 0, `window/document listeners left: ${leaked.join(', ')} (bare page: ${bareListeners.join(', ')})`);
    assert((await hostStyle()) === before, 'host page changed after dispose');
  });
  await check('remounts clean: fresh panels, selection and timeline; data correct', async () => {
    const r = await inPage(async () => {
      const v = await window.host.mount();
      return { selected: v.control.getSelected(), activity: v.control.getSelectedActivity()?.id ?? null, objects: v.control.listObjects() };
    });
    assert(r.selected === null && r.activity === null && r.objects.includes('SC-2'), JSON.stringify(r));
    await seek(1000.5);
    const err = await inPage(() => {
      const { viewer, T0, fixtures } = window.host;
      const p = viewer.control.getObjectState('SC-1', { frame: 'J2000' }).position, t = fixtures.sc1State(T0 + 1000.5).position;
      return Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    });
    assert(err < 1e-3, `SC-1 after remount: ${err} km`);
    await inPage(() => window.host.viewer.dispose());
    const again = await inPage(() => window.__probe.listeners());
    assert(again.join() === disposedListeners.join(), `listeners after a second mount cycle: ${again} vs ${disposedListeners}`);
    await inPage(() => window.host.mount());
  });

  // Dispose A while its catalog request is held, mount B, then let A's request
  // finish: A must not tear down, report into, or otherwise touch B.
  for (const outcome of ['resolves', 'rejects']) {
    await check(`a disposed mount's late catalog ${outcome === 'resolves' ? 'answer' : 'failure'} and old handles never touch the next mount`, async () => {
      let held, onHit;
      const hit = new Promise((resolve) => { onHit = resolve; });
      await page.route('**/delayed-catalog.json', (route) => { held = route; onHit(); });
      await inPage(async () => {
        await window.host.viewer.dispose();
        const a = await window.host.mountCosmolabe(document.getElementById('viewer'));
        window.__oldViewer = a;
        window.__oldLoad = a.loadCatalog('delayed-catalog.json').then(() => 'resolved', (e) => e.message);
      });
      await hit;
      await inPage(async () => {
        await window.__oldViewer.dispose();
        await window.host.mount();
      });
      await seek(1000.5);
      const before = await inPage(() => ({ t: window.host.viewer.control.getTime(), sel: window.host.viewer.control.getSelected() }));
      if (outcome === 'resolves') {
        const body = JSON.stringify(await inPage(() => window.host.sceneCatalog(false)));
        await held.fulfill({ contentType: 'application/json', body });
      } else {
        expectedAborts++;
        await held.abort('failed');
      }
      await page.unroute('**/delayed-catalog.json');
      const r = await inPage(async () => {
        const old = window.__oldViewer, v = window.host.viewer;
        const oldLoad = await window.__oldLoad;
        await new Promise((res) => setTimeout(res, 300));
        const attempts = {
          setTime: () => old.control.setTime({ kind: 'et', et: window.host.T0 + 50 }),
          select: () => old.control.select('SC-2'),
          track: () => old.control.track('SC-2'),
          on: () => old.control.on('time', () => {}),
          getTime: () => old.control.getTime(),
          addSource: () => old.missionState.addSource({ id: 'x', position: { timeScale: 'TDB', frame: 'J2000', center: 'Earth', positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: 60 } }),
          removeActivities: () => old.activities.remove('mission-plan'),
          loadCatalog: () => old.loadCatalog({ json: window.host.sceneCatalog(false) }),
        };
        const refused = [];
        for (const [name, fn] of Object.entries(attempts)) {
          try { const p = fn(); if (p?.then) await p; } catch (e) { if (/disposed/.test(e.message)) refused.push(name); }
        }
        const { T0, fixtures } = window.host;
        const p = v.control.getObjectState('SC-1', { frame: 'J2000' }).position, truth = fixtures.sc1State(T0 + 1000.5).position;
        return {
          oldLoad, refused, attempted: Object.keys(attempts),
          t: v.control.getTime(), sel: v.control.getSelected(), tracked: v.control.getTracked(),
          objects: v.control.listObjects(), activities: v.control.listActivities().map((a) => a.id),
          err: Math.hypot(p[0] - truth[0], p[1] - truth[1], p[2] - truth[2]),
          liveContexts: window.__probe.liveContexts(),
          loadError: !!document.getElementById('viewer').shadowRoot.textContent.match(/Couldn't load/),
        };
      });
      assert(/disposed/.test(r.oldLoad), `old load settled as: ${r.oldLoad}`);
      assert(r.refused.join() === r.attempted.join(), `old handle accepted: ${r.attempted.filter((n) => !r.refused.includes(n))}`);
      assert(r.t === before.t && r.sel === before.sel && r.tracked !== 'SC-2', `new mount changed: ${JSON.stringify(r)} vs ${JSON.stringify(before)}`);
      assert(r.objects.includes('SC-2') && r.activities.includes('sc2-perigee-1') && r.err < 1e-3, JSON.stringify(r));
      assert(r.liveContexts === 1 && !r.loadError, `scene torn down or error shown: ${JSON.stringify(r)}`);
    });
  }

  await check('no console errors or page errors', async () => {
    assert(problems.length === 0, problems.join('\n'));
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
