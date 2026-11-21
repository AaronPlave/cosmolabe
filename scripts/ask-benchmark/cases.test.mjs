import { expect, it } from 'vitest';
import { cases, scoreState, summarizeUsage, poseMatches, modelVisibleResults } from './cases.mjs';
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
  expect(summarizeReport(compact, { 't/a/fixed/0': { verdict: 'excluded' } })[0]).toMatchObject({ samples: 0, excluded: 1, fullyVerified: 0, factualPending: 0 });
});

it('binds reviews to actual answer evidence and preserves the digest after compaction', () => {
  const report = { runs: [{ result: { state: {}, reply: 'first', steps: [] } }] };
  const digest = reportDigest(report);
  expect(reportDigest({ ...compactReport(report), review: {}, summary: [] })).toBe(digest);
  report.runs[0].result.reply = 'changed';
  expect(reportDigest(report)).not.toBe(digest);
});

it('excludes clock-anchored next-flight diagnostics from quality and usage denominators', () => {
  const test = cases.find(c => c.id === 'ambiguous-flight');
  const score = scoreState(test, {}, { status: 'done', state: {}, steps: [] });
  expect(score.excluded).toBe(true);
  const report = { models: ['a'], runs: [{ model: 'a', mode: 'fixed', score, rounds: [{}], usage: { estimatedUsd: 1 } }] };
  expect(summarizeReport(report)[0]).toMatchObject({ samples: 0, excluded: 1, statePassed: 0, requests: 0, estimatedUsd: 0 });
});
it('requires the authored camera direction and target as well as selection', () => {
  const expected = { position: [900000, 0, 0], target: [0, 0, 0], up: [0, 1, 0] };
  expect(poseMatches({ ...expected, position: [0, 900000, 0] }, expected)).toBe(false);
  expect(poseMatches({ ...expected, target: [0, 10, 0] }, expected)).toBe(false);
  expect(poseMatches({ ...expected, position: [900000.1, 0, 0] }, expected)).toBe(true);
  const test = cases.find(c => c.id === 'landing-site');
  const result = { status: 'done', state: { place: { ref: test.place }, playing: false }, steps: [] };
  expect(scoreState(test, {}, result).passed).toBe(false);
  result.state.navigation = { targetMatches: true, nearDestination: true };
  expect(scoreState(test, {}, result).passed).toBe(true);
  result.state.navigation.targetMatches = false;
  expect(scoreState(test, {}, result).passed).toBe(false);
});
it('does not equate an underlying inventory success with a model-visible read', () => {
  const visible = modelVisibleResults([{ content: [
    { type: 'tool_result', toolUseId: 'large', content: JSON.stringify({ code: 'result-too-large', partial: true }) },
    { type: 'tool_result', toolUseId: 'ok', content: JSON.stringify({ data: { layers: [] } }) },
  ] }]);
  const test = cases.find(c => c.id === 'mars-inventory');
  const result = { status: 'done', state: { stable: {} }, steps: [{ name: 'getImagery', ok: true, modelVisible: visible.get('large') }] };
  expect(scoreState(test, { stable: {} }, result).checks.inventoryRead).toBe(false);
  result.steps[0].modelVisible = visible.get('ok');
  expect(scoreState(test, { stable: {} }, result).checks.inventoryRead).toBe(true);
  delete result.steps[0].modelVisible;
  expect(scoreState(test, { stable: {} }, result).checks.inventoryRead).toBe(false);
});

it('retains representative historical camera evidence against catalog-derived expectations', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('../../docs/benchmarks/ask/2026-11-01-summary.json', import.meta.url), 'utf8'));
  for (const check of fixture.cameraChecks) {
    expect(check.samples).toBe(4);
    if (check.task !== 'landing-site') expect(poseMatches(check.observed, check.expected)).toBe(true);
    else {
      const distance = a => Math.hypot(...a.map((v, i) => v - check.expected.target[i]));
      expect(distance(check.observed.target)).toBeLessThan(check.targetToleranceKm);
      expect(distance(check.observed.position)).toBeGreaterThanOrEqual(check.eyeDistanceKm[0]);
      expect(distance(check.observed.position)).toBeLessThanOrEqual(check.eyeDistanceKm[1]);
    }
  }
});
