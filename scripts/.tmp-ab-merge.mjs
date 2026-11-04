import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { summarizeReliability, wilson } from './ask-benchmark/reliability.mjs';
const INVALID = new Set(['timed-out', 'harness-error', 'error']);
const cells = new Map();
for (const dir of ['/private/tmp/claude-502/-Users-aplave-code-cosmolabe/e6070d8e-c4e3-4d38-bb62-966534208014/scratchpad/ab-old', '/private/tmp/claude-502/-Users-aplave-code-cosmolabe/e6070d8e-c4e3-4d38-bb62-966534208014/scratchpad/ab']) for (const f of readdirSync(dir).filter(f => /^r\d-.*\.json$/.test(f)).sort()) {
  const rep = Number(f[1]); let report; try { report = JSON.parse(readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
  for (const r of report.runs) { if (!r.reliability || r.failure || INVALID.has(r.classification)) continue;
    const k = [rep, r.arm, r.model, r.mode, r.task].join('|'); if (!cells.has(k)) cells.set(k, { ...r, rep }); }
}
const runs = [...cells.values()];
writeFileSync('/private/tmp/claude-502/-Users-aplave-code-cosmolabe/e6070d8e-c4e3-4d38-bb62-966534208014/scratchpad/ab-merged.json', JSON.stringify({ runs }, null, 1));
console.log('cells', runs.length);
const pct = v => v === null ? '-' : (100 * v).toFixed(0) + '%';
console.log('\nOVERALL arm/model/mode: success [wilson95] | false-success | p50/p95 rounds | p50/p95 latency s | $ total');
for (const s of summarizeReliability({ runs }).sort((a, b) => (a.model + a.mode + a.arm).localeCompare(b.model + b.mode + b.arm)))
  console.log(s.arm, s.model.slice(7, 13), s.mode.padEnd(9), s.firstAttemptSuccess + '/' + s.samples, pct(s.successRate), '[' + s.wilson95.map(pct).join('-') + ']', '| FS', s.classes['false-success'] ?? 0, '| rounds', s.rounds.p50 + '/' + s.rounds.p95, '| lat', Math.round(s.latencyMs.p50 / 1000) + '/' + Math.round(s.latencyMs.p95 / 1000), '| $' + s.estimatedUsd?.toFixed(2), '| contradicted', s.contradictedByViewerCheck, 'unchecked', s.unchecked);
console.log('\nPER TASK (successes of 5) arm A vs B, cols: sonnet-fixed sonnet-disc haiku-fixed haiku-disc');
const ok = r => ['complete', 'correctly-refused'].includes(r.classification);
for (const task of [...new Set(runs.map(r => r.task))]) {
  const row = arm => ['claude-sonnet-5-5|fixed', 'claude-sonnet-5-5|discovery', 'claude-haiku-5-5|fixed', 'claude-haiku-5-5|discovery'].map(mm => { const [m, mode] = mm.split('|'); const rs = runs.filter(r => r.task === task && r.arm === arm && r.model === m && r.mode === mode); return rs.filter(ok).length + '/' + rs.length; }).join(' ');
  console.log(task.padEnd(21), 'A', row('A'), ' | B', row('B'));
}
console.log('\nPOOLED by arm (all models/modes):');
for (const arm of ['A', 'B']) { const rs = runs.filter(r => r.arm === arm); const k = rs.filter(ok).length; const fs = rs.filter(r => r.classification === 'false-success').length;
  console.log(arm, k + '/' + rs.length, pct(k / rs.length), '[' + wilson(k, rs.length).map(pct).join('-') + ']', 'false-success', fs, '$' + rs.reduce((a, r) => a + (r.usage?.estimatedUsd ?? 0), 0).toFixed(2)); }
console.log('\nFIXED mode pooled by arm:');
for (const arm of ['A', 'B']) { const rs = runs.filter(r => r.arm === arm && r.mode === 'fixed'); const k = rs.filter(ok).length; console.log(arm, k + '/' + rs.length, pct(k / rs.length), '[' + wilson(k, rs.length).map(pct).join('-') + ']'); }
console.log('\nCLASSES by arm:'); for (const arm of ['A', 'B']) { const c = {}; for (const r of runs.filter(r => r.arm === arm)) c[r.classification] = (c[r.classification] ?? 0) + 1; console.log(arm, JSON.stringify(c)); }
