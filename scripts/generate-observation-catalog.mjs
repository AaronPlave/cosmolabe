#!/usr/bin/env node
// Writes apps/viewer/test-catalogs/cassini-observations.json — real Cassini ISS
// observations of SOI (2004 DOY 183–185) as a **Cosmographia-format**
// observation catalog (issue #28, Phase 2).
//
// The output is Cosmographia's own schema: one `class: "observation"` item per
// archive campaign and target, body-fixed on the target, with a
// `type: "Observations"` geometry whose `groups` are the real frames. That the
// adapter's output is Cosmographia's format is the superset claim, and it is
// testable: the file should open unmodified in Cosmographia, `require`ing
// cassini-soi.json for the bodies, sensors and kernels. The one addition is
// `geometry.campaign` — the archive's opaque observation name, carried verbatim
// for grouping; Cosmographia ignores keys it does not know.
//
// Sources, in order of preference:
//
//   --opus     Ask OPUS (`api/data.json`, through @cosmolabe/interop's `opus`
//              adapter) for Cassini ISS frames in the window, with
//              `CASSINIobsname` as the campaign and time1/time2 as each frame's
//              exposure window. Needs the network.
//   (default)  The committed Phase-1 archive fixture
//              (packages/core/src/__tests__/__fixtures__/pds-geometry-soi.json),
//              which carries each frame's OPUS ID, IMAGE_MID_TIME, observation
//              name and target from the same RMS-node tables. Offline and
//              hermetic. Exposure windows are not in the fixture, so each
//              frame is its mid-time instant: one footprint per frame.
//
// Idempotent; exits nonzero if it produced nothing. Not wired into CI.
//
// Run: node scripts/generate-observation-catalog.mjs [--opus]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(repoRoot, 'apps/viewer/test-catalogs/cassini-observations.json');
const FIXTURE = resolve(repoRoot, 'packages/core/src/__tests__/__fixtures__/pds-geometry-soi.json');

/** Archive instrument → the Sensor body cassini-soi.json defines for it. */
const SENSORS = { ISSNA: 'ISS NAC', ISSWA: 'ISS WAC', 'Cassini ISS NAC': 'ISS NAC', 'Cassini ISS WAC': 'ISS WAC' };
/** Footprint colours per sensor, matching the frusta in cassini-soi.json. */
const COLORS = { 'ISS NAC': [0.2, 0.6, 1.0], 'ISS WAC': [1.0, 0.6, 0.2] };
/** Archive target → catalog body name (the ones cassini-soi.json defines). */
const BODY = (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();

/** `2004-183T03:11:40.291` (PDS3 day-of-year) or ISO calendar → ISO 8601
 *  calendar UTC with an explicit `Z`. The designator is what this repo's
 *  catalogs require (catalog-time-strings.test.ts): a naive string is local
 *  time to any reader that cannot reach str2et. */
function cosmoTime(s) {
  const doy = /^(\d{4})-(\d{3})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  if (doy) {
    const d = new Date(Date.UTC(Number(doy[1]), 0, Number(doy[2])));
    return `${d.toISOString().slice(0, 10)}T${doy[3]}Z`;
  }
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?$/.exec(s);
  if (iso) return `${iso[1]}T${iso[2]}Z`;
  throw new Error(`unreadable time ${JSON.stringify(s)}`);
}

/** Frames as `{ id, sensor, target, start, end, campaign }`. */
function fromFixture() {
  const { rows } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  return {
    source: 'packages/core/src/__tests__/__fixtures__/pds-geometry-soi.json (PDS RMS node COISS_2004 tables)',
    frames: rows.map((r) => ({
      id: r.opusId,
      sensor: SENSORS[r.instrument],
      target: BODY(r.target),
      start: cosmoTime(r.utcMid),
      end: cosmoTime(r.utcMid),
      campaign: r.observationId,
    })),
  };
}

async function fromOpus() {
  const { opus } = await import('../packages/interop/dist/index.js');
  const frames = [];
  for (let startObs = 1; ; startObs += 1000) {
    const page = await opus.search({
      params: { instrument: 'Cassini ISS', time1: '2004-07-01T00:00:00', time2: '2004-07-04T00:00:00' },
      campaignColumn: 'CASSINIobsname',
      limit: 1000,
      startObs,
    });
    for (const o of page) {
      const sensor = /NAC|n\d/i.test(o.id) ? 'ISS NAC' : 'ISS WAC';
      if (!o.target) continue;
      frames.push({
        id: o.id,
        sensor,
        target: BODY(o.target),
        start: cosmoTime(o.startTime),
        end: cosmoTime(o.stopTime ?? o.startTime),
        campaign: o.campaign,
      });
    }
    if (page.length < 1000) break;
  }
  return { source: 'OPUS api/data.json (Cassini ISS, 2004-07-01 .. 07-04)', frames };
}

const { source, frames } = process.argv.includes('--opus') ? await fromOpus() : fromFixture();
const KNOWN = new Set(['Saturn', 'Mimas', 'Enceladus', 'Tethys', 'Dione', 'Rhea', 'Titan', 'Hyperion', 'Iapetus', 'Phoebe']);

// One observation item per (campaign, sensor, target), groups in time order.
const items = new Map();
for (const f of frames) {
  if (!f.sensor || !KNOWN.has(f.target)) continue;
  const key = `${f.campaign ?? f.id}\u0000${f.sensor}\u0000${f.target}`;
  if (!items.has(key)) items.set(key, { ...f, groups: [] });
  const item = items.get(key);
  if (!item.groups.some((g) => g.startTime === f.start)) item.groups.push({ startTime: f.start, endTime: f.end, obsRate: 0 });
}
if (items.size === 0) {
  console.error('generate-observation-catalog: produced no observations');
  process.exit(1);
}

const sorted = [...items.values()]
  .map((it) => ({ ...it, groups: it.groups.sort((a, b) => a.startTime.localeCompare(b.startTime)) }))
  .sort((a, b) => a.groups[0].startTime.localeCompare(b.groups[0].startTime) || a.target.localeCompare(b.target));

const catalog = {
  name: 'Cassini ISS Observations (SOI)',
  description:
    `Real Cassini ISS frames of Saturn orbit insertion, 2004 DOY 183-185, as Cosmographia observations. ` +
    `Source: ${source}. Generated by scripts/generate-observation-catalog.mjs. PDS data are public domain.`,
  version: '1.0',
  require: ['cassini-soi.json'],
  defaultTime: '2004-07-02T09:30:00Z',
  items: sorted.map((it) => ({
    class: 'observation',
    name: `${it.campaign} (${it.sensor} → ${it.target})`,
    startTime: it.groups[0].startTime,
    endTime: it.groups[it.groups.length - 1].endTime,
    center: it.target,
    trajectoryFrame: { type: 'BodyFixed', body: it.target },
    bodyFrame: { type: 'BodyFixed', body: it.target },
    label: { visible: false },
    geometry: {
      type: 'Observations',
      sensor: it.sensor,
      groups: it.groups,
      footprintColor: COLORS[it.sensor],
      footprintOpacity: 0.3,
      showResWithColor: false,
      sideDivisions: 8,
      alongTrackDivisions: 1,
      shadowVolumeScaleFactor: 1.75,
      fillInObservations: true,
      campaign: it.campaign,
    },
  })),
};

writeFileSync(OUT, JSON.stringify(catalog, null, 2) + '\n');
const groups = sorted.reduce((n, it) => n + it.groups.length, 0);
console.log(`wrote ${OUT}: ${sorted.length} observation items, ${groups} frames, from ${source}`);
