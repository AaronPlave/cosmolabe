import { expect, it } from 'vitest';
import { reliabilityCases, turnPredicates, judge, scoreReliability, answerChecks, classify, suspectedFalseSuccess, wilson, summarizeReliability, distancesKm, dates } from './reliability.mjs';

const task = id => reliabilityCases.find(c => c.id === id);
const closeup = task('psyche-mars-closeup');
// The shape the harness's own projection probe returns (benchmark-ask.mjs __probeComposition).
const probe = (marsInView, rangeKm = 0.06, marsKm = 10_000) => ({ fovDeg: 45, aspect: 1.6, et: 5, playing: false, tracked: 'Psyche', objects: [
  { object: 'Psyche', available: true, drawEnabled: true, inView: true, rangeKm, radiusKm: 0.0005, angularRadiusDeg: 0.5, ndc: [0, 0], occlusion: null },
  { object: 'Mars', available: true, drawEnabled: true, inView: marsInView, rangeKm: marsKm, radiusKm: 3389.5, angularRadiusDeg: Math.asin(Math.min(1, 3389.5 / marsKm)) * 180 / Math.PI, ndc: marsInView ? [0.3, 0.2] : null, occlusion: null }] });
/** A page stand-in: answers reads from a table, as the harness's page reads would. */
const page = table => async reads => reads.map(([m, a]) => [m, a, table[m]?.(...a) ?? null]);
const methods = new Set(['getViewComposition', 'getTime', 'isPlaying', 'listBookmarks', 'getViewerState']);

it('covers the issue\'s literal requests, paraphrases, negatives and multi-turn cases across at least four catalogs', () => {
  const prompts = reliabilityCases.flatMap(c => c.turns);
  for (const literal of ['show me when voyager 1 flew past jupiter', 'show cassini at closest approach to mimas', 'show me all psyche flybys of earth',
    'show me the one where psyche is closest to mars', 'place a pick marker on the ground where ingenuity currently is', 'can you place a point then']) expect(prompts).toContain(literal);
  expect(reliabilityCases.length).toBeGreaterThanOrEqual(20);
  expect(new Set(reliabilityCases.map(c => c.catalog)).size).toBeGreaterThanOrEqual(4);
  expect(reliabilityCases.filter(c => c.refusal).length).toBeGreaterThanOrEqual(2);
  expect(reliabilityCases.filter(c => c.turns.length > 1).length).toBeGreaterThanOrEqual(4);
  expect(reliabilityCases.filter(c => c.critical).length).toBeGreaterThanOrEqual(6);
  expect(closeup.turns).toHaveLength(5);
});

it('judges the close-up from the harness probe, fetching whatever reads the predicates need', async () => {
  const goal = turnPredicates(closeup, 4, { closeRangeKm: 0.06, epoch: 5 });
  expect(goal).toEqual(expect.arrayContaining([{ p: 'range', object: 'Psyche', maxKm: 0.09 }, { p: 'epoch', et: 5 }, { p: 'paused', value: true }]));
  expect(turnPredicates(closeup, 2, {})).toBeNull();
  const scene = (p) => page({ getViewComposition: () => p, getTime: () => 5, isPlaying: () => false });
  expect((await judge(goal, scene(probe(true)), methods)).status).toBe('met');
  expect((await judge(goal, scene(probe(false)), methods)).status).toBe('unmet');
  // Mars 5.7 million km away is in frame but only a few pixels across.
  expect((await judge(goal, scene(probe(true, 0.06, 5.7e6)), methods)).status).toBe('partial');
  // Pulled back to show both is not "keep Psyche up close".
  expect((await judge(goal, scene(probe(true, 500)), methods)).status).toBe('unmet');
});

it('state predicates read any registered read: a bookmark kept after a declined delete', async () => {
  const goal = turnPredicates(task('bookmark-delete-declined'), 1, {});
  expect((await judge(goal, page({ listBookmarks: () => [{ name: 'Launch View' }] }), methods)).status).toBe('met');
  expect((await judge(goal, page({ listBookmarks: () => [] }), methods)).status).toBe('unmet');
});

it('needs the right participants, the true closest result and a met goal, and classifies honestly', () => {
  const test = task('voyager-jupiter');
  const truth = { minKm: 348_900, minEt: -656_000_000, minUtc: '1979-03-05T12:05:00Z' };
  const turn = { status: 'done', reply: 'Here is the flyby.', truth, eventQuery: { bodies: { observer: 'Voyager 1', target: 'Saturn' }, selectedRangeKm: 348_900, selectedEt: -656_000_000 }, report: { status: 'met' } };
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
  // The first chronological result is not the closest.
  run.score = scoreReliability(test, [{ ...turn, eventQuery: { ...turn.eventQuery, selectedRangeKm: 9e6 } }]);
  expect(run.score.checks.truthRange).toBe(false);
  turn.report = { status: 'partial' };
  run.score = scoreReliability(test, [turn]);
  expect(classify(test, run)).toBe('partial');
  expect(classify(test, { failure: 'viewer-or-task-timeout' })).toBe('timed-out');
  expect(classify(test, { result: { turns: [{ status: 'error', errorCode: 'budget_exhausted' }] }, score: {} })).toBe('budget-stopped');
});

it('checks the answer against truth: distances, dates, flyby claims, counts', () => {
  expect(distancesKm('3.48 billion km, 349,000 km, 1.2 AU').map(d => Math.round(d.km))).toEqual([3480000000, 349000, 179517445]);
  expect(dates('on March 5, 1979 (1979-03-05)')).toEqual(['1979-03-05', '1979-03-05']);
  const test = task('voyager-jupiter');
  const truth = { minKm: 348_900, minUtc: '1979-03-05T12:05:00Z' };
  expect(answerChecks(test, [{ reply: 'Voyager 1 flew past Jupiter on March 5, 1979, at about 349,000 km from its centre.', truth }]).ok).toBe(true);
  // Altitude above the cloud tops is range minus Jupiter's radius: also a published quantity.
  expect(answerChecks(test, [{ reply: 'about 277,400 km above Jupiter', truth }]).ok).toBe(true);
  expect(answerChecks(test, [{ reply: 'at 206,700 km on March 8, 1979', truth }]).issues).toEqual(['distance 206,700 km', 'date 1979-03-08']);
  const all = task('psyche-earth-all');
  const allTruth = { minKm: 1.8e8, closestMinimumKm: 1.8e8, minima: 9 };
  expect(answerChecks(all, [{ reply: 'There are 9 closest approaches; none is a flyby, the nearest 180 million km.', truth: allTruth }]).ok).toBe(true);
  expect(answerChecks(all, [{ reply: 'Psyche has 5 flybys of Earth.', truth: allTruth }]).issues).toEqual(expect.arrayContaining(['count 5 (truth 9)', expect.stringMatching(/^flyby claim/)]));
});

it('"all flybys" needs every local minimum an independent sample finds, not just some results', () => {
  const test = task('psyche-earth-all');
  const coverage = { start: 0, end: 1e8 };
  const turn = { status: 'done', reply: 'Found 3 closest approaches; none comes closer than 1.2 AU, so none is a flyby.', eventQuery: { bodies: { observer: 'Psyche', target: 'Earth' }, scope: 'local', window: coverage, searchComplete: true, total: 2 },
    truth: { windows: [coverage], samples: 100, available: 100, minima: 3, closestMinimumKm: 1.8e8, minKm: 1.8e8 } };
  expect(scoreReliability(test, [turn]).checks.completeMinima).toBe(false);
  turn.eventQuery.total = 3;
  expect(scoreReliability(test, [turn]).passed).toBe(true);
  turn.eventQuery.scope = 'global';
  expect(scoreReliability(test, [turn]).checks.allMinimaScope).toBe(false);
  turn.eventQuery.scope = null; // the solver's LOCMIN default
  expect(scoreReliability(test, [turn]).checks.allMinimaScope).toBe(true);
  turn.eventQuery.window = { start: 0, end: 5e7 };
  expect(scoreReliability(test, [turn]).checks.coversWindow).toBe(false);
});

it('a refusal passes only with a false premise, nothing presented and a stated no without a flyby claim', () => {
  const test = task('voyager-neptune-none');
  const turn = { status: 'done', reply: 'Voyager 1 never flew past Neptune; only Voyager 2 did.', eventQuery: null, truth: { minKm: 4.4e9 } };
  expect(scoreReliability(test, [turn]).passed).toBe(true);
  expect(scoreReliability(test, [{ ...turn, reply: 'Here is the view.' }]).checks.answerFactual).toBe(false);
  expect(scoreReliability(test, [{ ...turn, eventQuery: { presented: true } }]).passed).toBe(false);
  expect(scoreReliability(test, [{ ...turn, truth: { minKm: 5e4 } }]).checks.premiseFalse).toBe(false);
});

it('reports success with a Wilson interval, per-task rates and per-check failures', () => {
  expect(wilson(0, 0)).toEqual([null, null]);
  const [lo, hi] = wilson(19, 20);
  expect(lo).toBeGreaterThan(0.75);
  expect(hi).toBeLessThanOrEqual(1);
  const runs = [0, 1].map(i => ({ reliability: true, arm: 'B', model: 'm', mode: 'fixed', task: 't', classification: i ? 'complete' : 'incorrect',
    score: { checks: { goal: !!i } }, rounds: [{}, {}], latencyMs: 1000 * (i + 1), usage: { rawProcessed: 20000, estimatedUsd: 0.01 } }));
  const [row] = summarizeReliability({ runs });
  expect(row).toMatchObject({ samples: 2, firstAttemptSuccess: 1, successRate: 0.5, failedChecks: { 't:goal': 1 }, perTask: { t: { n: 2, ok: 1 } }, rounds: { total: 4 }, estimatedUsd: 0.02, actualBilledUsd: null });
});

it('a refusal may state another spacecraft\'s real flyby, and a catalog name is not a claim', () => {
  const v1 = task('voyager-neptune-none'), truth = { minKm: 3.48e9, minUtc: '1985-04-09T20:23:23Z' };
  const reply = 'Voyager 1 did not fly past Neptune; its closest approach was 3,477,735,829 km on 1985-04-09, not a flyby. Voyager 2 did. Its closest approach was a flyby at 29,269 km.';
  expect(answerChecks(v1, [{ reply, truth, result: { facts: [{ kind: 'event-result', rangeKm: 29269, utc: '1989-08-25T03:55:00Z' }] } }]).issues).toEqual([]);
  expect(answerChecks(v1, [{ reply: 'Voyager 1 flew past Neptune at 3.48 billion km.', truth }]).issues).toEqual(expect.arrayContaining([expect.stringMatching(/^flyby claim/), 'does not say no']));
  const pj = task('psyche-jupiter-none');
  expect(answerChecks(pj, [{ reply: 'Jupiter is not in this scene. The scene does include a Mars flyby viewpoint.' }]).issues).toEqual([]);
});
