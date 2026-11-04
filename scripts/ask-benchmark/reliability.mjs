/**
 * #345 reliability matrix: user-level tasks across catalogs, each judged by
 * the viewer's own state through `checkGoal` over reads the harness records —
 * never by the model's answer or a tool's `ok`. Camera composition is judged by
 * the harness's own projection probe, not by the viewer code under test.
 */
import { checkGoal } from '@cosmolabe/control';

const PSYCHE_CLOSEUP = [
  'show me when psyche is within 10000km of mars',
  'zoom into psyche',
  'frame the scene so psyche and mars are both in view',
  'but keep psyche up close',
  'not true just need to rotate the camera around psyche to see mars',
];

export const reliabilityCases = [
  { id: 'voyager-jupiter', catalog: 'voyagers', prompt: 'show me when voyager 1 flew past jupiter', event: { bodies: ['Voyager 1', 'Jupiter'], pick: 'closest' },
    rubric: 'Computed closest approach (1979-03-05) within the stated searched window; paused at it and framed; no authored viewpoint substituted for computation.' },
  { id: 'cassini-mimas', catalog: 'cassini-soi', prompt: 'show cassini at closest approach to mimas', event: { bodies: ['Cassini', 'Mimas'], pick: 'closest' },
    rubric: 'Closest of all measured candidates in the declared kernel window, not the first chronological one; states the window.' },
  { id: 'psyche-earth-all', catalog: 'psyche', prompt: 'show me all psyche flybys of earth', event: { bodies: ['Psyche', 'Earth'], all: true },
    truth: { bodies: ['Psyche', 'Earth'], window: 'coverage', stepSeconds: 600, noFlybyBeyondKm: 1.496e8 },
    rubric: 'Every local minimum over the pair\'s kernel coverage, counted; deepest-only or a narrower window is not "all". After launch Psyche never comes within 1 AU of Earth (9 minima at a 10-minute sample, closest 1.8e8 km; a 6-hour sample misses 4), so the answer must say none is a close flyby.' },
  { id: 'psyche-mars-closest', catalog: 'psyche', prompt: 'show me the one where psyche is closest to mars', event: { bodies: ['Psyche', 'Mars'], pick: 'closest' },
    rubric: 'Range-ranked closest encounter (2026-05-15), paused, framed.' },
  { id: 'mars-elevation', catalog: 'ingenuity-jezero', prompt: 'color mars terrain by elevation', goal: { kind: 'surface-appearance', body: 'Mars', baseColor: 'elevation' },
    rubric: 'Elevation base colour on Mars; says whether the terrain data is drawn yet (partial when not).' },
  { id: 'ingenuity-pin-point', catalog: 'ingenuity-jezero', turns: ['place a pick marker on the ground where ingenuity currently is', 'can you place a point then'],
    goals: [{ kind: 'ground-point', object: 'Ingenuity', mode: 'pin' }, { kind: 'ground-point', object: 'Ingenuity', mode: 'saved' }],
    rubric: 'Turn 1 transient pin on Mars under Ingenuity; turn 2 one saved, selected point from the pin, pin kept.' },
  { id: 'psyche-mars-closeup', catalog: 'psyche', turns: PSYCHE_CLOSEUP, composition: { anchor: 'Psyche', include: ['Mars'], closeTurn: 1, epochTurn: 0, rangeFactor: 1.5 },
    rubric: 'Ends close to Psyche (within 1.5x the turn-2 close-up range) with Mars in frame at the paused encounter epoch, or states a truthful tradeoff. No flip-flop; no budget stop.' },
  { id: 'voyager-neptune-none', catalog: 'voyagers', prompt: 'show me when voyager 1 flew past neptune', refusal: true, refusalSubject: /neptune/i,
    truth: { bodies: ['Voyager 1', 'Neptune'], window: 'catalog', stepSeconds: 432000, noFlybyBeyondKm: 1.496e8 },
    rubric: 'Voyager 1 never flew past Neptune: say so (a distant range minimum is not a flyby); do not present one as an encounter.' },
];

export const promptsOf = test => test.turns ?? [test.prompt];

/**
 * The exact reads `checkGoal` makes for a goal, so a recorded host can answer
 * them. Given the first pass's `recorded` entries, adds the reads that depend
 * on them (the selected saved feature's layer).
 */
export function goalReads(goal, recorded = []) {
  switch (goal.kind) {
    case 'camera-composition': return [['getViewComposition', [[goal.anchor, ...goal.include]]]];
    case 'event-presentation': return [['getEventVisualization', []], ['getEventResultPage', [goal.query, { order: 'range-ascending', limit: 1 }]], ['listEventResults', [goal.query, { limit: 100 }]]];
    case 'surface-appearance': return [['getSurfaceAppearance', [goal.body]], ['getReadiness', [{ kind: 'terrain', body: goal.body }]]];
    case 'ground-point': {
      const sel = recorded.find(([m]) => m === 'getSelectedGeographicFeature')?.[2];
      return [['projectGroundPoint', [goal.object, 'rendered']], ['getProbePoint', []], ['getSelectedGeographicFeature', []], ['listGeographicLayers', []],
        ...(sel?.layer ? [['listGeographicFeatures', [sel.layer, { limit: 100 }]]] : [])];
    }
    default: throw new Error(`unknown goal ${goal.kind}`);
  }
}

const key = (method, args) => `${method}${JSON.stringify(args)}`;

/** A ViewerControl that answers only the recorded reads; anything else is unobserved. */
export function recordedHost(entries) {
  const values = new Map(entries.map(([method, args, value]) => [key(method, args), value]));
  const methods = new Set(entries.map(([method]) => method));
  return new Proxy({}, { get: (_t, method) => methods.has(method) ? (...args) => values.get(key(method, args)) : undefined });
}

/** The goal a turn is judged by, given what the harness observed before judging. */
export function turnGoal(test, turn, context) {
  if (test.goals) return test.goals[turn] ?? null;
  const last = turn === promptsOf(test).length - 1;
  if (!last) return null;
  if (test.goal) return test.goal;
  if (test.event && context.query) return { kind: 'event-presentation', query: context.query, ...(test.event.pick ? { pick: test.event.pick } : {}) };
  if (test.composition) {
    const c = test.composition;
    return { kind: 'camera-composition', anchor: c.anchor, include: c.include, paused: true,
      ...(context.closeRangeKm ? { maxAnchorRangeKm: context.closeRangeKm * c.rangeFactor } : {}),
      ...(context.epoch !== undefined ? { et: context.epoch } : {}) };
  }
  return null;
}

/** Judge one turn from recorded reads. */
export function judgeTurn(goal, entries) {
  return goal ? checkGoal(recordedHost(entries), goal) : null;
}

/** State checks for a whole run; `turns` carry `status`, `report` and, for events, `eventQuery`. */
export function scoreReliability(test, turns) {
  const checks = {}, last = turns.at(-1);
  checks.finished = turns.every(t => t.status === 'done');
  if (test.event) {
    const bodies = Object.values(last?.eventQuery?.bodies ?? {}).map(b => String(b).toLowerCase());
    checks.participants = test.event.bodies.every(b => bodies.includes(b.toLowerCase()));
    if (test.event.all) {
      // "All" means every local minimum over the pair's whole supported coverage: not deepest-only, not a
      // narrower window the model picked, and as many as an independent sample finds there.
      const q = last?.eventQuery, truth = last?.truth;
      // Unset scope is the solver's LOCMIN default (closest-approach.ts); only 'global' is deepest-only.
      checks.allMinimaScope = !!q && (q.scope === 'local' || q.scope === null || q.scope === undefined);
      checks.searchComplete = q?.searchComplete === true;
      checks.coversWindow = !!q?.window && !!truth?.windows?.length && q.window.start <= Math.min(...truth.windows.map(w => w.start)) + test.truth.stepSeconds
        && q.window.end >= Math.max(...truth.windows.map(w => w.end)) - test.truth.stepSeconds;
      checks.completeMinima = !!truth && truth.available >= 0.99 * truth.samples && q?.total === truth.minima;
      // Distant range minima are not flybys: when every one is beyond the threshold, the answer must say so.
      if (test.truth.noFlybyBeyondKm) checks.distanceCaveat = !!truth && (truth.closestMinimumKm === null || truth.closestMinimumKm <= test.truth.noFlybyBeyondKm || NEGATION.test(last?.reply ?? ''));
    }
    else checks.goal = last?.report?.status === 'met';
  }
  turns.forEach((t, i) => { if (t.report && !test.event) checks[`goal${turns.length > 1 ? i + 1 : ''}`] = t.report.status === 'met'; });
  if (test.refusal) {
    // The premise must actually be false, nothing presented as an encounter, and the answer must say no.
    checks.premiseFalse = !!last?.truth && last.truth.minKm !== null && last.truth.minKm > test.truth.noFlybyBeyondKm;
    checks.noEncounterPresented = !last?.eventQuery?.presented;
    checks.refusalStated = NEGATION.test(last?.reply ?? '') && (!test.refusalSubject || test.refusalSubject.test(last?.reply ?? ''));
  }
  const partial = turns.some(t => t.report?.status === 'partial') && Object.entries(checks).every(([k, v]) => v || k.startsWith('goal'));
  return { checks, passed: Object.values(checks).every(Boolean), partial,
    factual: { verdict: 'pending-review', rubric: test.rubric } };
}

const NEGATION = /\b(not|no|never|couldn'?t|cannot|can'?t|unable|unavailable|hidden|isn'?t|wasn'?t|didn'?t|only partly|partial)\b/i;

/** complete / correctly-refused / partial / incorrect / timed-out / interrupted / budget-stopped / error. */
export function classify(test, run) {
  if (run.failure === 'viewer-or-task-timeout') return 'timed-out';
  const last = run.result?.turns?.at(-1);
  if (!last || run.failure) return 'harness-error';
  if (['cancelled', 'superseded', 'stale'].includes(last.status)) return 'interrupted';
  if (last.status === 'error') return /budget|rate_limited/.test(last.errorCode ?? '') ? 'budget-stopped' : 'error';
  if (test.refusal) return run.score.passed ? 'correctly-refused' : 'incorrect';
  if (run.score.passed) return 'complete';
  // A failed state with an answer that sounds like success is its own, worse, class.
  if (suspectedFalseSuccess(run)) return 'false-success';
  return run.score.partial ? 'partial' : 'incorrect';
}

/** An answer that sounds like success over a failed state check: flagged for review, not auto-judged. */
export const suspectedFalseSuccess = (run) => !!run.result && !run.score?.passed && run.result.turns.at(-1)?.status === 'done'
  && !NEGATION.test(run.result.turns.at(-1).reply ?? '');

/** Wilson 95% interval for k successes in n trials. */
export function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function percentile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
}

/** Per arm × model × mode: first-attempt success with uncertainty, classes, rounds, latency, tokens. */
export function summarizeReliability(report) {
  const groups = new Map();
  for (const run of report.runs.filter(r => r.reliability)) {
    const id = `${run.arm}/${run.model}/${run.mode}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(run);
  }
  return [...groups].map(([id, runs]) => {
    const [arm, model, mode] = id.split('/');
    const complete = runs.filter(r => ['complete', 'correctly-refused'].includes(r.classification)).length;
    const classes = Object.fromEntries([...new Set(runs.map(r => r.classification))].map(c => [c, runs.filter(r => r.classification === c).length]));
    const failedChecks = {};
    for (const r of runs) for (const [k, v] of Object.entries(r.score?.checks ?? {})) if (!v) failedChecks[`${r.task}:${k}`] = (failedChecks[`${r.task}:${k}`] ?? 0) + 1;
    const rounds = runs.map(r => r.rounds.length), latency = runs.map(r => r.latencyMs), raw = runs.map(r => r.usage?.rawProcessed ?? NaN);
    const knownCost = runs.every(r => typeof r.usage?.estimatedUsd === 'number');
    return { arm, model, mode, samples: runs.length, firstAttemptSuccess: complete, successRate: runs.length ? complete / runs.length : null,
      wilson95: wilson(complete, runs.length), classes, failedChecks, suspectedFalseSuccess: runs.filter(r => r.suspectedFalseSuccess).length,
      // Answers given while the viewer's own end-of-request check said the goal did not hold.
      contradictedByViewerCheck: runs.filter(r => r.result?.turns?.some(t => t.status === 'done' && t.verification?.some(v => v.status === 'unmet'))).length,
      unchecked: runs.filter(r => r.result?.turns?.some(t => t.status === 'done' && t.wrote && (t.unverified || !t.verification))).length,
      rounds: { total: rounds.reduce((a, b) => a + b, 0), p50: percentile(rounds, 0.5), p95: percentile(rounds, 0.95) },
      latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) },
      rawTokens: { total: raw.filter(Number.isFinite).reduce((a, b) => a + b, 0), p50: percentile(raw, 0.5), p95: percentile(raw, 0.95) },
      estimatedUsd: knownCost ? runs.reduce((n, r) => n + r.usage.estimatedUsd, 0) : null, actualBilledUsd: null };
  });
}
