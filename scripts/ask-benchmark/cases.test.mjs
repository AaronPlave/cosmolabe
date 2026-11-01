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
