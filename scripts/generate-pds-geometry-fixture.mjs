#!/usr/bin/env node
// Regenerates packages/core/src/__tests__/__fixtures__/pds-geometry-soi.json —
// the archived Cassini ISS geometry the PDS oracle test checks cosmolabe's
// SPICE composition against (issue #28, Phase 1).
//
// Source: the PDS Ring-Moon Systems Node's geometry metadata for volume
// COISS_2004 — `COISS_2004_saturn_summary.tab` and `_moon_summary.tab` for the
// geometry, joined to the volume index (`COISS_2004_index.tab`) for each
// frame's times and observation name. These are the tables OPUS ingests for its
// Cassini ISS surface-geometry fields (each row carries its OPUS ID), computed
// by the node's `oops` toolkit: an independent *composition* (frame chain,
// aberration convention, body shape, sub-point definition) over the same
// SPICE kernels, which is the point.
//
// Only the nine columns the labels describe as "independent of the field of
// view" are kept — sub-observer/sub-solar points, centre distance and phase.
// Those need no camera pointing, so the oracle needs no CK.
//
// Idempotent: rows are sorted, and the `generated` stamp is carried over from
// the existing file when the rows have not changed. Exits nonzero if it
// produced no rows or the per-target counts differ from EXPECTED_COUNTS — an
// upstream change has to be looked at, not silently absorbed. The provenance
// records the SHA-256 of every source table and of the SPK the rows are meant
// to be checked against, so a fixture/kernel mismatch is detectable (the test
// checks it). Not wired into CI — the committed fixture is the test
// input, so the oracle stays hermetic and offline.
//
// Run: node scripts/generate-pds-geometry-fixture.mjs

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(repoRoot, 'packages/core/src/__tests__/__fixtures__/pds-geometry-soi.json');

const VOLUME = 'COISS_2004';
const BASE = `https://pds-rings.seti.org/holdings/metadata/COISS_2xxx/${VOLUME}/${VOLUME}`;

// Coverage of packages/spice/test-kernels/cassini/040909R_SCPSE_04183_04185_subset.bsp
// (made by scripts/make-cassini-soi-recon-spk.mjs). PDS3 index times are
// UTC day-of-year strings, so a lexical compare on the `YYYY-DDD` prefix works.
const SPK = 'packages/spice/test-kernels/cassini/040909R_SCPSE_04183_04185_subset.bsp';
const DAY_FIRST = '2004-183';
const DAY_LAST = '2004-185';

// Bodies with an ephemeris in that SPK (699 and 601–609). The archive also has
// rows for Pan, Prometheus, Pallene and Epimetheus, which the SCPSE kernel does
// not carry — dropped here so the test never has to skip a row.
const TARGETS = new Set([
  'SATURN', 'MIMAS', 'ENCELADUS', 'TETHYS', 'DIONE', 'RHEA', 'TITAN', 'HYPERION', 'IAPETUS', 'PHOEBE',
]);

/** PDS3 label column name → fixture field. */
const GEOMETRY_COLUMNS = {
  SUB_OBSERVER_PLANETOCENTRIC_LATITUDE: 'subObserverLatPc',
  SUB_OBSERVER_PLANETOGRAPHIC_LATITUDE: 'subObserverLatPg',
  SUB_OBSERVER_IAU_LONGITUDE: 'subObserverLonW',
  SUB_SOLAR_PLANETOCENTRIC_LATITUDE: 'subSolarLatPc',
  SUB_SOLAR_PLANETOGRAPHIC_LATITUDE: 'subSolarLatPg',
  SUB_SOLAR_IAU_LONGITUDE: 'subSolarLonW',
  CENTER_DISTANCE: 'distanceKm',
  CENTER_PHASE_ANGLE: 'phaseDeg',
};
const NULL_CONSTANT = -999;

/** Rows per target the oracle test pins. Changing them is a deliberate edit. */
const EXPECTED_COUNTS = {
  SATURN: 299, TITAN: 197, IAPETUS: 9, ENCELADUS: 3, MIMAS: 2, RHEA: 2, DIONE: 1, TETHYS: 1,
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** Source file name → SHA-256 of the bytes actually read. */
const sourceHashes = {};

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  sourceHashes[url.slice(url.lastIndexOf('/') + 1)] = sha256(buf);
  return buf.toString('latin1');
}

/** Column layout from a PDS3 label: NAME → { start (0-based), bytes, real }. */
function parseLabel(label, url) {
  const cols = new Map();
  let cur = null;
  for (const line of label.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'OBJECT' && value === 'COLUMN') cur = {};
    else if (key === 'END_OBJECT' && value === 'COLUMN' && cur) {
      cols.set(cur.NAME, { start: Number(cur.START_BYTE) - 1, bytes: Number(cur.BYTES), real: /REAL|INTEGER/.test(cur.DATA_TYPE) });
      cur = null;
    } else if (cur) cur[key] = value.replace(/"/g, '');
  }
  if (cols.size === 0) throw new Error(`${url}: no COLUMN objects in label`);
  return cols;
}

/** Read named columns out of a fixed-width PDS3 table. */
async function readTable(stem, names) {
  const cols = parseLabel(await get(`${BASE}_${stem}.lbl`), `${BASE}_${stem}.lbl`);
  for (const n of names) if (!cols.has(n)) throw new Error(`${BASE}_${stem}.lbl: no column ${n}`);
  const text = await get(`${BASE}_${stem}.tab`);
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const row = {};
      for (const n of names) {
        const c = cols.get(n);
        const raw = line.slice(c.start, c.start + c.bytes).trim().replace(/^"|"$/g, '').trim();
        row[n] = c.real ? Number(raw) : raw;
      }
      return row;
    });
}

const INDEX_COLUMNS = ['FILE_SPECIFICATION_NAME', 'IMAGE_MID_TIME', 'START_TIME', 'INSTRUMENT_ID', 'OBSERVATION_ID'];
const SUMMARY_COLUMNS = ['FILE_SPECIFICATION_NAME', 'OPUS_ID', 'TARGET_NAME', ...Object.keys(GEOMETRY_COLUMNS)];

const index = await readTable('index', INDEX_COLUMNS);
// Index rows name the .IMG, summary rows the .LBL; the stem is the join key.
const stem = (spec) => spec.replace(/\.(IMG|LBL)$/i, '');
const byFile = new Map(index.map((r) => [stem(r.FILE_SPECIFICATION_NAME), r]));

const rows = [];
for (const table of ['saturn_summary', 'moon_summary']) {
  for (const g of await readTable(table, SUMMARY_COLUMNS)) {
    if (!TARGETS.has(g.TARGET_NAME)) continue;
    const i = byFile.get(stem(g.FILE_SPECIFICATION_NAME));
    if (!i) throw new Error(`${table}: ${g.FILE_SPECIFICATION_NAME} has no index row`);
    const day = i.START_TIME.slice(0, 8);
    if (day < DAY_FIRST || day > DAY_LAST) continue;
    // NULL_CONSTANT: no SPICE pointing, or the body is not in the field of view.
    if (Object.keys(GEOMETRY_COLUMNS).some((k) => g[k] === NULL_CONSTANT)) continue;
    const row = {
      opusId: g.OPUS_ID,
      target: g.TARGET_NAME,
      utcMid: i.IMAGE_MID_TIME,
      instrument: i.INSTRUMENT_ID,
      observationId: i.OBSERVATION_ID,
    };
    for (const [col, field] of Object.entries(GEOMETRY_COLUMNS)) row[field] = g[col];
    rows.push(row);
  }
}
// A total order: an image can target more than one body, and (utcMid, target)
// ties are broken by opusId rather than left to the engine's sort.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
rows.sort((a, b) => cmp(a.utcMid, b.utcMid) || cmp(a.target, b.target) || cmp(a.opusId, b.opusId));

const counts = {};
for (const r of rows) counts[r.target] = (counts[r.target] ?? 0) + 1;
if (rows.length === 0) {
  console.error(`generate-pds-geometry-fixture: no rows for ${VOLUME} ${DAY_FIRST}..${DAY_LAST}`);
  process.exit(1);
}
const countKeys = new Set([...Object.keys(counts), ...Object.keys(EXPECTED_COUNTS)]);
const countDiffs = [...countKeys].filter((t) => counts[t] !== EXPECTED_COUNTS[t]);
if (countDiffs.length > 0) {
  console.error(
    'generate-pds-geometry-fixture: per-target counts changed — ' +
      countDiffs.map((t) => `${t} ${EXPECTED_COUNTS[t] ?? 0} → ${counts[t] ?? 0}`).join(', ') +
      '. Check the archive, then update EXPECTED_COUNTS and the test together.',
  );
  process.exit(1);
}

const serializedRows = rows.map((r) => JSON.stringify(r));
let generated = new Date().toISOString().slice(0, 10);
if (existsSync(OUT)) {
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  if (JSON.stringify(prev.rows) === JSON.stringify(rows)) generated = prev.provenance.generated;
}

const provenance = {
  source: 'PDS Ring-Moon Systems Node, Cassini ISS geometry metadata (the tables behind OPUS surface geometry)',
  urls: ['index', 'saturn_summary', 'moon_summary'].map((t) => `${BASE}_${t}.tab`),
  sha256: Object.fromEntries(Object.entries(sourceHashes).sort(([a], [b]) => cmp(a, b))),
  spk: { path: SPK, sha256: sha256(readFileSync(resolve(repoRoot, SPK))) },
  columns: Object.fromEntries(Object.entries(GEOMETRY_COLUMNS).map(([col, field]) => [field, col])),
  conventions:
    'Longitudes are IAU WEST (increase toward the west). Planetocentric latitude is that of the ' +
    'line from body centre toward the observer/Sun (an intercept, not the near point). ' +
    'Values are at IMAGE_MID_TIME (UTC). Distance in km, angles in degrees, 3-decimal precision.',
  window: `${DAY_FIRST} .. ${DAY_LAST} (UTC, by START_TIME)`,
  generator: 'scripts/generate-pds-geometry-fixture.mjs',
  generated,
  license: 'PDS data are public domain.',
};

const body =
  '{\n' +
  `  "provenance": ${JSON.stringify(provenance, null, 2).replace(/\n/g, '\n  ')},\n` +
  '  "rows": [\n' +
  serializedRows.map((r) => `    ${r}`).join(',\n') +
  '\n  ]\n}\n';
writeFileSync(OUT, body);
console.log(`Wrote ${OUT}: ${rows.length} rows ${JSON.stringify(counts)}`);
