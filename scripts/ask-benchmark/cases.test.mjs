import { expect, it } from 'vitest';
import { cases, scoreState, summarizeUsage } from './cases.mjs';
it('does not turn successful host returns into verified framing or answer acceptance', () => {
  const test = cases.find(c => c.id === 'exact-flight');
  const result = { status: 'done', state: { activity: { id: test.activity, start: 5 }, et: 5, playing: false, tracked: 'Ingenuity' }, steps: [{ name: 'frameObject', ok: true }] };
  expect(scoreState(test, {}, result).passed).toBe(false);
  result.state.framing = { inView: true, occupiesViewport: true };
  expect(scoreState(test, {}, result)).toMatchObject({ passed: true, factual: { verdict: 'pending-review' } });
});
it('keeps cost unknown when any answered-model price is unknown and counts cached raw tokens', () => {
  const rows = [{ requestedModel: 'a', model: 'b', inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 20, outputTokens: 5, estimatedUsd: null }];
  expect(summarizeUsage(rows)).toMatchObject({ rawProcessed: 135, estimatedUsd: null, actualBilledUsd: null, requestedModels: ['a'], answeredModels: ['b'] });
  expect(summarizeUsage([]).estimatedUsd).toBeNull();
});
it('requires cancellation after a write and no late mutation', () => {
  const test = cases.find(c => c.cancel);
  expect(scoreState(test, {}, { status: 'cancelled', state: {}, steps: [], cancel: { afterWrite: true, unchanged: false } }).passed).toBe(false);
});

import { compactReport, summarizeReport, reportDigest } from './report.mjs';
it('deduplicates observations and never counts pending answer reviews as verified success', () => {
  const observation = { coversView: null };
  const report = { models: ['a'], runs: [{ task: 't', model: 'a', mode: 'fixed', repeat: 0, score: { passed: true }, rounds: [],
    result: { state: { stable: { duplicate: true }, selected: 'Earth' }, steps: [{ observation }, { observation }] }, usage: { estimatedUsd: null } }] };
  const compact = compactReport(report);
  expect(Object.keys(compact.observations)).toHaveLength(1);
  expect(compact.runs[0].result.steps[0].observationRef).toBe(compact.runs[0].result.steps[1].observationRef);
  expect(summarizeReport(compact)[0]).toMatchObject({ statePassed: 1, fullyVerified: 0, factualPending: 1, estimatedUsd: null });
});

it('binds reviews to actual answer evidence and preserves the digest after compaction', () => {
  const report = { runs: [{ result: { state: {}, reply: 'first', steps: [] } }] };
  const digest = reportDigest(report);
  expect(reportDigest({ ...compactReport(report), review: {}, summary: [] })).toBe(digest);
  report.runs[0].result.reply = 'changed';
  expect(reportDigest(report)).not.toBe(digest);
});
