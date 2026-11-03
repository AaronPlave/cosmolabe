import { expect, it } from 'vitest';
import { reliabilityCases, goalReads, recordedHost, turnGoal, judgeTurn, scoreReliability, classify, suspectedFalseSuccess, wilson, summarizeReliability } from './reliability.mjs';

const closeup = reliabilityCases.find(c => c.id === 'psyche-mars-closeup');
const probe = (marsInView, rangeKm = 0.06) => ({ et: 5, playing: false, tracked: 'Psyche', objects: [
  { object: 'Psyche', available: true, inView: true, rangeKm, occlusion: null },
  { object: 'Mars', available: true, inView: marsInView, rangeKm: 10_000, occlusion: null }] });

it('covers the issue\'s literal requests across at least three catalogs, with negative and multi-turn cases', () => {
  const prompts = reliabilityCases.flatMap(c => c.turns ?? [c.prompt]);
  for (const literal of ['show me when voyager 1 flew past jupiter', 'show cassini at closest approach to mimas', 'show me all psyche flybys of earth',
    'show me the one where psyche is closest to mars', 'place a pick marker on the ground where ingenuity currently is', 'can you place a point then']) expect(prompts).toContain(literal);
  expect(new Set(reliabilityCases.map(c => c.catalog)).size).toBeGreaterThanOrEqual(3);
  expect(reliabilityCases.some(c => c.refusal)).toBe(true);
  expect(closeup.turns).toHaveLength(5);
});

it('judges the close-up from the harness probe: close AND Mars in view AND epoch held', () => {
  const goal = turnGoal(closeup, 4, { closeRangeKm: 0.06, epoch: 5 });
  expect(goal).toMatchObject({ kind: 'camera-composition', anchor: 'Psyche', maxAnchorRangeKm: 0.09, et: 5, paused: true });
  expect(turnGoal(closeup, 2, {})).toBeNull();
  const reads = good => goalReads(goal).map(([m, a]) => [m, a, probe(good)]);
  expect(judgeTurn(goal, reads(true)).status).toBe('met');
  expect(judgeTurn(goal, reads(false)).status).toBe('unmet');
  // Pulled back to show both is not "keep Psyche up close".
  expect(judgeTurn(goal, goalReads(goal).map(([m, a]) => [m, a, probe(true, 500)])).status).toBe('unmet');
});

it('answers only recorded reads; anything unrecorded is unobservable', () => {
  const host = recordedHost([['getProbePoint', [], null]]);
  expect(host.getProbePoint()).toBeNull();
  expect(host.getSurfaceAppearance).toBeUndefined();
});

it('needs the right participants and a met goal, and classifies honestly', () => {
  const test = reliabilityCases.find(c => c.id === 'voyager-jupiter');
  const turn = { status: 'done', reply: 'Here is the flyby.', eventQuery: { bodies: { observer: 'Voyager 1', target: 'Saturn' } }, report: { status: 'met' } };
  const run = { result: { turns: [turn] }, score: scoreReliability(test, [turn]) };
  expect(run.score.checks.participants).toBe(false);
  // A failed state with an answer that sounds successful is tracked as its own class.
  expect(suspectedFalseSuccess(run)).toBe(true);
  expect(classify(test, run)).toBe('false-success');
  turn.reply = 'I could not find a Jupiter encounter.';
  expect(classify(test, run)).toBe('incorrect');
  turn.eventQuery.bodies.target = 'Jupiter';
  run.score = scoreReliability(test, [turn]);
  expect(classify(test, run)).toBe('complete');
  turn.report = { status: 'partial' };
  run.score = scoreReliability(test, [turn]);
  expect(classify(test, run)).toBe('partial');
  expect(classify(test, { failure: 'viewer-or-task-timeout' })).toBe('timed-out');
  expect(classify(test, { result: { turns: [{ status: 'error', errorCode: 'budget_exhausted' }] }, score: {} })).toBe('budget-stopped');
});

it('reports success with a Wilson interval and per-check failures', () => {
  expect(wilson(0, 0)).toEqual([null, null]);
  const [lo, hi] = wilson(19, 20);
  expect(lo).toBeGreaterThan(0.75);
  expect(hi).toBeLessThanOrEqual(1);
  const runs = [0, 1].map(i => ({ reliability: true, arm: 'B', model: 'm', mode: 'fixed', task: 't', classification: i ? 'complete' : 'incorrect',
    score: { checks: { goal: !!i } }, rounds: [{}, {}], latencyMs: 1000 * (i + 1), usage: { rawProcessed: 20000, estimatedUsd: 0.01 } }));
  const [row] = summarizeReliability({ runs });
  expect(row).toMatchObject({ samples: 2, firstAttemptSuccess: 1, successRate: 0.5, failedChecks: { 't:goal': 1 }, rounds: { total: 4 }, estimatedUsd: 0.02, actualBilledUsd: null });
});

it('"all flybys" needs every local minimum an independent sample finds, not just some results', () => {
  const test = reliabilityCases.find(c => c.id === 'psyche-earth-all');
  const turn = { status: 'done', reply: 'Found 2.', eventQuery: { bodies: { observer: 'Psyche', target: 'Earth' }, scope: 'local', searchComplete: true, total: 2 },
    truth: { samples: 100, available: 100, minima: 3 } };
  expect(scoreReliability(test, [turn]).checks.completeMinima).toBe(false);
  turn.eventQuery.total = 3;
  expect(scoreReliability(test, [turn]).passed).toBe(true);
  turn.eventQuery.scope = 'global';
  expect(scoreReliability(test, [turn]).checks.allMinimaScope).toBe(false);
  delete turn.truth;
  expect(scoreReliability(test, [{ ...turn, eventQuery: { ...turn.eventQuery, scope: 'local' } }]).checks.completeMinima).toBe(false);
});

it('a refusal passes only with a false premise, nothing presented and a stated no', () => {
  const test = reliabilityCases.find(c => c.id === 'voyager-neptune-none');
  const turn = { status: 'done', reply: 'Voyager 1 never flew past Neptune; only Voyager 2 did.', eventQuery: null, truth: { minKm: 4.4e9 } };
  expect(scoreReliability(test, [turn]).passed).toBe(true);
  // Silence is not a refusal.
  expect(scoreReliability(test, [{ ...turn, reply: 'Here is the view.' }]).checks.refusalStated).toBe(false);
  expect(scoreReliability(test, [{ ...turn, eventQuery: { presented: true } }]).passed).toBe(false);
  expect(scoreReliability(test, [{ ...turn, truth: undefined }]).checks.premiseFalse).toBe(false);
});
