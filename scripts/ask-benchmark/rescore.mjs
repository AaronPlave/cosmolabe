/** Rescore saved reports with the current judging (no provider calls) and merge them: node rescore.mjs out.json in1.json in2.json ... */
import { readFileSync, writeFileSync } from 'node:fs';
import { reliabilityCases, scoreReliability, classify, suspectedFalseSuccess, summarizeReliability } from './reliability.mjs';

const [out, ...inputs] = process.argv.slice(2);
const reports = inputs.map(f => JSON.parse(readFileSync(f, 'utf8')));
const runs = reports.flatMap(r => {
  // The harness's own spend cap stops a run with a bare transport error: a budget stop, not an attempt.
  const capped = (r.totalUsage?.estimatedUsd ?? 0) >= 0.99 * r.limits.estimatedUsd;
  return r.runs.map(run => ({ ...run, capped, source: r.source, started: r.started }));
}).filter(r => r.reliability).map(run => {
  const test = reliabilityCases.find(c => c.id === run.task);
  if (!test || !run.result) return run;
  const score = scoreReliability(test, run.result.turns);
  const next = { ...run, score };
  const last = run.result.turns.at(-1);
  const stopped = run.capped && last?.status === 'error' && !last.errorCode;
  return { ...next, classification: stopped ? 'budget-stopped' : classify(test, next), suspectedFalseSuccess: !stopped && suspectedFalseSuccess(next) };
});
const usd = reports.reduce((n, r) => n + (r.totalUsage?.estimatedUsd ?? 0), 0);
const merged = { version: 1, sources: reports.map(r => r.source), models: [...new Set(reports.flatMap(r => r.models))], runs, estimatedUsd: usd };
merged.reliabilitySummary = summarizeReliability(merged);
writeFileSync(out, JSON.stringify(merged, null, 2) + '\n');
console.log('budget-stopped (excluded):', runs.filter(r => r.classification === 'budget-stopped').length);
for (const s of merged.reliabilitySummary) console.log(JSON.stringify({ model: s.model, ok: s.firstAttemptSuccess, n: s.samples, classes: s.classes, falseSuccess: s.falseSuccess, askVerifiedButFailed: s.askVerifiedButFailed }));
console.log('estimated USD', usd.toFixed(3));
