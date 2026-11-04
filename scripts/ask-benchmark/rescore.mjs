/** Rescore saved reports with the current judging (no provider calls) and merge them: node rescore.mjs out.json in1.json in2.json ... */
import { readFileSync, writeFileSync } from 'node:fs';
import { reliabilityCases, scoreReliability, classify, suspectedFalseSuccess, summarizeReliability } from './reliability.mjs';

const [out, ...inputs] = process.argv.slice(2);
const reports = inputs.map(f => JSON.parse(readFileSync(f, 'utf8')));
const runs = reports.flatMap(r => r.runs).filter(r => r.reliability).map(run => {
  const test = reliabilityCases.find(c => c.id === run.task);
  if (!test || !run.result) return run;
  const score = scoreReliability(test, run.result.turns);
  const next = { ...run, score };
  return { ...next, classification: classify(test, next), suspectedFalseSuccess: suspectedFalseSuccess(next) };
});
const usd = reports.reduce((n, r) => n + (r.totalUsage?.estimatedUsd ?? 0), 0);
const merged = { version: 1, sources: reports.map(r => r.source), models: [...new Set(reports.flatMap(r => r.models))], runs, estimatedUsd: usd };
merged.reliabilitySummary = summarizeReliability(merged);
writeFileSync(out, JSON.stringify(merged, null, 2) + '\n');
for (const s of merged.reliabilitySummary) console.log(JSON.stringify({ model: s.model, ok: s.firstAttemptSuccess, n: s.samples, classes: s.classes, falseSuccess: s.falseSuccess, askVerifiedButFailed: s.askVerifiedButFailed }));
console.log('estimated USD', usd.toFixed(3));
