/**
 * Optional real-provider smoke test (#371): NOT for CI (needs the network).
 * Runs the real Lightstreamer transport, CelesTrak fetch, assembler and
 * MissionState in a browser, for ~WAIT_S seconds, and asserts the adapter
 * says only what the feed supports:
 *   - feed ticking  -> status `live`, a sample on MissionState, plausible pose;
 *   - feed frozen   -> NOT `live` (stale/unavailable), no sample on MissionState.
 * Start `npm --prefix apps/viewer run dev` first, then:
 *   node packages/mission-iss/scripts/live-smoke.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const waitS = Number(process.env.WAIT_S ?? 25);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(new URL('?catalog=test-catalogs/iss&test=1', base).href, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ path: path.resolve('node_modules/lightstreamer-client-web/lightstreamer-core.js') });
  const r = await page.evaluate(async ({ waitS, root }) => {
    const core = await import('/@fs/' + root + '/packages/core/src/index.ts');
    const live = await import('/@fs/' + root + '/packages/mission-iss/src/live/source.ts');
    const ch = await import('/@fs/' + root + '/packages/mission-iss/src/live/channels.ts');
    const tr = await import('/@fs/' + root + '/packages/mission-iss/src/live/transport.ts');
    const orb = await import('/@fs/' + root + '/packages/mission-iss/src/live/orbit.ts');
    const ls = window; // the UMD build below defines LightstreamerClient / Subscription globals
    const config = ch.issLiveConfig({ joints: { items: ch.CANDIDATE_JOINT_ITEMS, unit: 'deg' } });
    const feed = live.createLiveIssFeed({
      config,
      transport: tr.lightstreamerTransport(ls, ch.issLiveTransportConfig(config)),
      acceptUnverified: true, // experiment: the mappings are unverified, so the gate must be opened to see samples
    });
    feed.setOrbit(await orb.fetchCelestrakIss(fetch.bind(window)));
    const manager = new core.MissionStateManager();
    manager.addSource(feed.source);
    await new Promise((res) => setTimeout(res, waitS * 1000));
    const status = feed.status();
    const et = core.etFromDate(new Date(status.lastSourceTimeMs ?? Date.now()));
    const out = {
      status,
      attitudeAvailable: manager.availability('ISS-LIVE', 'attitude', et).available,
      attitudeNow: manager.availability('ISS-LIVE', 'attitude', core.etFromDate(new Date())).available,
      position: status.lastSourceTimeMs ? manager.evaluatePosition('ISS-LIVE', et).position : null,
    };
    manager.removeSource('ISS-LIVE');
    return out;
  }, { waitS, root: process.cwd() });
  console.log(JSON.stringify({ state: r.status.state, reason: r.status.reason, ageS: r.status.sourceAgeMs && r.status.sourceAgeMs / 1000, orbit: r.status.orbit.state, counters: r.status.counters, joints: r.status.joints }, null, 1));
  if (r.status.state === 'live') {
    assert.ok(r.attitudeNow, 'live: attitude must be available now');
    const radius = Math.hypot(...r.position);
    assert.ok(radius > 6600 && radius < 6900, `live: ISS radius ${radius} km`);
    console.log('LIVE: feed is ticking; adapter shows it. radius km', radius.toFixed(1));
  } else {
    assert.ok(!r.attitudeNow, 'not live: no attitude may be offered for now');
    console.log(`NOT LIVE (${r.status.state}): feed frozen or down; adapter correctly offers nothing for "now"`);
  }
} finally {
  await browser.close();
}
