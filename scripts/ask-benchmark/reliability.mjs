/**
 * #345 reliability matrix: user-level tasks across six catalogs, each judged
 * twice, independently of the model and of Ask's own verdict:
 *
 * - **State**: typed predicates evaluated over viewer reads the harness makes
 *   itself (`judge`), with camera composition from the harness's own projection
 *   of the render camera, plus task-specific truth (independent range sampling).
 * - **Answer**: harness-owned checks of the reply text against that truth:
 *   stated distances and dates, flyby claims, refusals, caveats and counts.
 *
 * Tasks are user requests, not tool scripts; several are paraphrases or
 * multi-turn conversations, and several are negative (no flyby, no such body,
 * a declined approval, an ambiguous reference).
 */
import { evaluate } from '@cosmolabe/control';

const PSYCHE_CLOSEUP = [
  'show me when psyche is within 10000km of mars',
  'zoom into psyche',
  'frame the scene so psyche and mars are both in view',
  'but keep psyche up close',
  'not true just need to rotate the camera around psyche to see mars',
];

/** An encounter task: the closest computed approach, presented, against independently sampled truth. */
const closest = (id, catalog, prompt, [observer, target], { encounter = null, targetRadiusKm, critical = false, rubric } = {}) =>
  ({ id, catalog, turns: [prompt], critical, event: { bodies: [observer, target], pick: 'closest', encounter }, targetRadiusKm,
    truth: { bodies: [observer, target], window: 'coverage', mode: 'closest' }, rubric });

export const reliabilityCases = [
  closest('voyager-jupiter', 'voyagers', 'show me when voyager 1 flew past jupiter', ['Voyager 1', 'Jupiter'], { encounter: true, targetRadiusKm: 71492, critical: true,
    rubric: 'Computed closest approach (1979-03-05), a flyby inside Jupiter\'s sphere of influence; paused at it and framed; no authored viewpoint substituted.' }),
  closest('voyager2-neptune', 'voyagers', "take me to voyager 2's closest pass by neptune", ['Voyager 2', 'Neptune'], { encounter: true, targetRadiusKm: 24764,
    rubric: 'Paraphrase. Computed closest approach 1989-08-25, a real flyby.' }),
  closest('cassini-mimas', 'cassini-soi', 'show cassini at closest approach to mimas', ['Cassini', 'Mimas'], { targetRadiusKm: 198.2, critical: true,
    rubric: 'Closest of all measured candidates in the declared kernel window, not the first chronological one; states the window.' }),
  closest('cassini-titan', 'cassini-soi', 'when did cassini get nearest to titan? show me', ['Cassini', 'Titan'], { targetRadiusKm: 2574.7,
    rubric: 'Paraphrase on another moon; closest of all measured candidates in the loaded window.' }),
  closest('psyche-mars-closest', 'psyche', 'show me the one where psyche is closest to mars', ['Psyche', 'Mars'], { encounter: true, targetRadiusKm: 3389.5, critical: true,
    rubric: 'Range-ranked closest encounter (2026-05-15), paused, framed.' }),
  { id: 'psyche-mars-threshold', catalog: 'psyche', turns: ['show me when psyche is within 10000km of mars'], event: { bodies: ['Psyche', 'Mars'], thresholdKm: 10000 },
    rubric: 'A 10,000 km search threshold, not a 10,000 km camera range: the presented result is within 10,000 km.' },
  { id: 'psyche-earth-all', catalog: 'psyche', turns: ['show me all psyche flybys of earth'], critical: true, event: { bodies: ['Psyche', 'Earth'], all: true },
    truth: { bodies: ['Psyche', 'Earth'], window: 'coverage', mode: 'minima', stepSeconds: 600 }, noFlyby: true, flybySubject: /earth/i,
    rubric: 'Every local minimum over the pair\'s kernel coverage (9 at a 10-minute sample, closest 1.8e8 km); none is a flyby, and the answer must say so.' },
  { id: 'voyager-neptune-none', catalog: 'voyagers', turns: ['show me when voyager 1 flew past neptune'], critical: true, refusal: /neptune/i, flybySubject: /neptune|voyager 1/i, flybyExempt: /voyager 2/i,
    truth: { bodies: ['Voyager 1', 'Neptune'], window: 'catalog', mode: 'closest' }, noFlyby: true,
    rubric: 'Voyager 1 never flew past Neptune: say so; never present the distant 3.5e9 km minimum as an encounter.' },
  { id: 'psyche-jupiter-none', catalog: 'psyche', turns: ["show me psyche's flyby of jupiter"], refusal: /jupiter/i, noFlyby: true, flybySubject: /jupiter/i,
    rubric: 'Jupiter is not in this scene: say so; nothing presented.' },
  { id: 'mars-elevation', catalog: 'ingenuity-jezero', turns: ['color mars terrain by elevation'],
    goal: () => [{ p: 'state', read: 'getSurfaceAppearance', args: ['Mars'], path: 'settings.baseColor', equals: 'elevation' }, { p: 'ready', kind: 'terrain', body: 'Mars' }],
    rubric: 'Elevation base colour on Mars; says whether the terrain data is drawn yet (partial when not).' },
  { id: 'ingenuity-pin-point', catalog: 'ingenuity-jezero', turns: ['place a pick marker on the ground where ingenuity currently is', 'can you place a point then'], critical: true,
    goals: [() => [{ p: 'probeUnder', object: 'Ingenuity' }, { p: 'probeDrawn' }], () => [{ p: 'featureSelected' }, { p: 'featureUnder', object: 'Ingenuity' }, { p: 'probeUnder', object: 'Ingenuity' }]],
    rubric: 'Turn 1 transient pin on Mars under Ingenuity; turn 2 one saved, selected point from the pin, in a visible layer; pin kept.' },
  { id: 'psyche-mars-closeup', catalog: 'psyche', turns: PSYCHE_CLOSEUP, critical: true, composition: { anchor: 'Psyche', include: ['Mars'], closeTurn: 1, epochTurn: 0, rangeFactor: 1.5 },
    rubric: 'Ends close to Psyche (within 1.5x the turn-2 close-up range) with Mars in frame at the paused encounter epoch, or states a truthful tradeoff.' },
  { id: 'earth-moon-switch', catalog: 'earth-moon', turns: ['pause time and select the moon', 'now select earth instead'],
    goals: [() => [{ p: 'selected', object: 'Moon' }, { p: 'paused', value: true }], () => [{ p: 'selected', object: 'Earth' }, { p: 'paused', value: true }]],
    rubric: 'The later request replaces the selection and keeps the pause.' },
  { id: 'earth-moon-measure', catalog: 'earth-moon', turns: ['measure the distance between the earth and the moon'], measure: ['Earth', 'Moon'],
    rubric: 'A saved, visible Earth–Moon distance measurement; any distance stated is the actual centre distance now.' },
  { id: 'earth-moon-bookmark', catalog: 'earth-moon', turns: ['save the current view as a bookmark called Launch View'],
    goal: () => [{ p: 'state', read: 'listBookmarks', path: '[name=Launch View].name', equals: 'Launch View' }],
    rubric: 'One session bookmark named Launch View.' },
  { id: 'bookmark-delete-declined', catalog: 'earth-moon', turns: ['save the current view as a bookmark called Launch View', 'delete the Launch View bookmark'], approvals: 'decline',
    goals: [() => [{ p: 'state', read: 'listBookmarks', path: '[name=Launch View].name', equals: 'Launch View' }], () => [{ p: 'state', read: 'listBookmarks', path: '[name=Launch View].name', equals: 'Launch View' }]],
    declined: true, rubric: 'Deletion asks for approval; the person declines; the bookmark remains and the answer says it was not deleted.' },
  { id: 'cassini-nac', catalog: 'cassini-soi', turns: ["show me what cassini's narrow angle camera sees"],
    goal: () => [{ p: 'state', read: 'getInstrument', path: 'sensor', equals: 'ISS NAC' }],
    rubric: 'The ISS NAC synthetic feed is open; a synthetic scene view, not calibrated imagery.' },
  { id: 'voyager-hide-trajectories', catalog: 'voyagers', turns: ['hide all the trajectory lines'],
    goal: () => [{ p: 'state', read: 'getViewerState', path: 'layers.trajectories', equals: false }],
    rubric: 'The trajectories layer is off.' },
  { id: 'ingenuity-flight5', catalog: 'ingenuity-jezero', turns: ["take me to the start of ingenuity's fifth flight and hold it there"], activity: 'ingenuity:flight:5',
    goal: ctx => [{ p: 'activity', id: 'ingenuity:flight:5' }, { p: 'paused', value: true }, ...(ctx.activityStart !== undefined ? [{ p: 'epoch', et: ctx.activityStart }] : []), { p: 'inView', object: 'Ingenuity' }],
    rubric: 'Flight 5 selected, paused at its start, Ingenuity in view; timing provenance is estimated.' },
  { id: 'moonfall-landing', catalog: 'moonfall-shackleton', turns: ['Take me to the MoonFall landing site near Shackleton and pause time.'],
    goal: () => [{ p: 'place', id: 'moon:mission:moonfall-sites/psr-landing' }, { p: 'paused', value: true }], synthetic: true,
    rubric: 'The PSR landing waypoint; says it is a synthetic demonstration, not a real operation.' },
  { id: 'mars-inventory', catalog: 'ingenuity-jezero', turns: ['List the imagery available on Mars with each layer\'s attribution. Do not move the camera or time.'], unchanged: true,
    rubric: 'Read-only: the view and clock are unchanged.' },
  { id: 'unresolved-viewpoint', catalog: 'earth-moon', turns: ['Show that viewpoint.'], unchanged: true, asks: true,
    rubric: 'No viewpoint was mentioned before: ask which, without changing the scene.' },
];

export const promptsOf = test => test.turns;

/** The predicates a turn is judged by, given what the harness observed before judging. */
export function turnPredicates(test, turn, ctx) {
  const last = turn === test.turns.length - 1;
  if (test.goals) return test.goals[turn]?.(ctx) ?? null;
  if (!last) return null;
  if (test.goal) return test.goal(ctx);
  if (test.event && !test.event.all && ctx.query) {
    return [{ p: 'eventSelected', query: ctx.query, ...(test.event.pick ? { pick: 'closest' } : {}), ...(test.event.encounter ? { encounter: true } : {}) },
      { p: 'paused', value: true }, { p: 'eventEpoch', query: ctx.query }, { p: 'eventFramed', query: ctx.query }];
  }
  if (test.composition) {
    const c = test.composition;
    return [{ p: 'inView', object: c.anchor }, ...c.include.flatMap(o => [{ p: 'inView', object: o }, { p: 'legible', object: o }]), { p: 'paused', value: true },
      ...(ctx.closeRangeKm ? [{ p: 'range', object: c.anchor, maxKm: ctx.closeRangeKm * c.rangeFactor }] : []), ...(ctx.epoch !== undefined ? [{ p: 'epoch', et: ctx.epoch }] : [])];
  }
  return null;
}

const key = (method, args) => `${method}${JSON.stringify(args)}`;

/**
 * Evaluate predicates over reads fetched by `read([method, args][])` (from the
 * page), whatever reads they need: evaluation is repeated until it asks for
 * nothing new. `getViewComposition` is answered by the harness's own probe.
 */
export async function judge(predicates, read, methods) {
  const cache = new Map();
  for (let pass = 0; pass < 8; pass++) {
    const misses = [];
    const host = new Proxy({}, { get: (_t, m) => typeof m === 'string' && methods.has(m) ? (...args) => {
      const k = key(m, args);
      if (cache.has(k)) return cache.get(k);
      misses.push([m, args]);
      return undefined;
    } : undefined });
    const report = evaluate(host, predicates, { reads: methods });
    if (!misses.length) return report;
    for (const [m, args, value] of await read(misses)) cache.set(key(m, args), value);
  }
  throw new Error('judge did not converge');
}

// ── Answer checks: the harness's own, against its own truth ──

const NEGATION = /\b(not|no|never|none|couldn'?t|cannot|can'?t|unable|unavailable|hidden|isn'?t|wasn'?t|didn'?t|doesn'?t|only partly|partial)\b/i;
const FLYBY = /\b(fly-?bys?|flew (?:past|by)|swing-?bys?|close (?:flyby|pass|encounter)|encounters?)\b/i;
const AU_KM = 1.495978707e8;
const SCALE = { thousand: 1e3, million: 1e6, billion: 1e9 };
const DISTANCE = /(?<![\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(?:e|[×x]\s*10\^?)\s*([+-]?\d+))?\s*(thousand|million|billion)?\s*(km|kilomet(?:er|re)s?|AU|astronomical units?)\b/gi;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DATE = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b|\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/g;
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

export function distancesKm(text) {
  return [...text.matchAll(DISTANCE)].map(m => {
    const base = Number(m[1].replace(/,/g, '')) * (m[2] ? 10 ** Number(m[2]) : 1) * (m[3] ? SCALE[m[3].toLowerCase()] : 1);
    return { text: m[0], km: /^a/i.test(m[4]) ? base * AU_KM : base };
  });
}
export function dates(text) {
  return [...text.matchAll(DATE)].map(m => m[1] ? `${m[1]}-${m[2]}-${m[3]}`
    : m[4] ? `${m[6]}-${String(MONTHS.indexOf(m[4].toLowerCase()) + 1).padStart(2, '0')}-${m[5].padStart(2, '0')}`
      : `${m[9]}-${String(MONTHS.indexOf(m[8].toLowerCase()) + 1).padStart(2, '0')}-${m[7].padStart(2, '0')}`);
}
/**
 * A sentence that presents a flyby of the task's subject. Names quoted from
 * the catalog ("Mars Flyby (2026-05-15)") are not claims, and neither is a
 * true statement about another spacecraft (`exempt`) in the same or the
 * previous sentence ("Voyager 2 did. Its closest approach ... is a flyby").
 */
const flybyClaim = (text, subject, exempt) => {
  const sentences = text.replace(/["“][^"”]*["”]/g, '').split(/(?<=[.!?;])\s+/);
  // A question ("show you that encounter?") offers; it does not claim.
  return sentences.find((s, i) => FLYBY.test(s) && !NEGATION.test(s) && !/\?\s*$/.test(s) && (!subject || subject.test(s) || /\b(it|its|this|that)\b/i.test(s))
    && !(exempt && [s, sentences[i - 1] ?? '', sentences[i - 2] ?? ''].some(x => exempt.test(x))));
};
const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * Whether the final answer is factually consistent with the harness's truth.
 * Only what the answer states is checked; prose with nothing checkable passes.
 */
export function answerChecks(test, turns) {
  const last = turns.at(-1), reply = last?.reply ?? '';
  const issues = [];
  const truth = last?.truth, q = last?.eventQuery;
  // Numbers the viewer published count when its closest result agrees with the harness's truth (the state checks say whether it does).
  const facts = (last?.result?.facts ?? []).filter(f => f.kind === 'event-result');
  const windows = (last?.result?.facts ?? []).filter(f => f.kind === 'event-window');
  const allowedKm = [AU_KM, test.event?.thresholdKm, truth?.minKm, truth?.closestMinimumKm, truth && truth.minKm - (test.targetRadiusKm ?? 0),
    q?.selectedRangeKm, q?.selectedRangeKm && q.selectedRangeKm - (test.targetRadiusKm ?? 0), q?.selectedAltitudeKm, q?.soiKm, last?.measuredKm,
    ...facts.flatMap(f => [f.rangeKm, f.altitudeKm, f.thresholdKm])].filter(v => typeof v === 'number' && v > 0);
  if (test.event || test.truth || test.measure) for (const d of distancesKm(reply)) if (!allowedKm.some(k => Math.abs(d.km - k) <= 0.05 * k + 1)) issues.push(`distance ${d.text}`);
  // Dates inside quoted catalog names ("V2 Neptune (1989-08-25)") are labels, not claims.
  const unquoted = reply.replace(/["“][^"”]*["”]/g, '');
  const allowedDays = [truth?.minUtc, q?.selectedUtc, q?.windowUtc?.start, q?.windowUtc?.end, ...facts.map(f => f.utc), ...windows.flatMap(w => [w.startUtc, w.endUtc])].filter(Boolean);
  if (allowedDays.length) for (const d of dates(unquoted)) if (!allowedDays.some(k => days(k, d) <= 1)) issues.push(`date ${d}`);
  if (test.noFlyby) { const claim = flybyClaim(reply, test.flybySubject, test.flybyExempt); if (claim) issues.push(`flyby claim: ${claim.slice(0, 100)}`); }
  if (test.noFlyby && test.event?.all && !NEGATION.test(reply)) issues.push('no caveat that these are not flybys');
  if (test.event?.all && truth) {
    const count = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:local\s+)?(?:closest approaches|approaches|minima|passes|times|close approaches|range minima|(?:Earth )?fly-?bys|encounters)/i.exec(reply);
    if (count) { const n = Number(count[1]) || WORDS[count[1].toLowerCase()]; if (n !== truth.minima) issues.push(`count ${n} (truth ${truth.minima})`); }
  }
  if (test.refusal && !(NEGATION.test(reply) && test.refusal.test(reply))) issues.push('does not say no');
  if (test.declined && !(NEGATION.test(reply) || /\b(nothing|still|remains|kept|declined)\b/i.test(reply))) issues.push('does not say the deletion did not happen');
  if (test.synthetic && !/synthetic|demo|fictional|not (?:a )?real|illustrative/i.test(reply)) issues.push('does not say the site is synthetic');
  if (test.asks && !/\?/.test(reply)) issues.push('does not ask which');
  return { ok: issues.length === 0, issues };
}

/** State and answer checks for a whole run. Turns carry `status`, `report`, events `eventQuery`, and truth. */
export function scoreReliability(test, turns) {
  const checks = {}, last = turns.at(-1);
  checks.finished = turns.length === test.turns.length && turns.every(t => t.status === 'done');
  turns.forEach((t, i) => { if (t.report) checks[`goal${turns.length > 1 ? i + 1 : ''}`] = t.report.status === 'met'; });
  if (test.event) {
    const q = last?.eventQuery;
    const bodies = Object.values(q?.bodies ?? {}).map(b => String(b).toLowerCase());
    checks.participants = test.event.bodies.every(b => bodies.includes(b.toLowerCase()));
    if (test.event.pick === 'closest' && last?.truth) {
      // The presented result is the true closest approach: range within 1%, epoch within an hour of independent sampling.
      // Not farther than the closest the harness's own sampling finds (the solver may refine deeper); when they agree, at the same epoch.
      checks.truthRange = typeof q?.selectedRangeKm === 'number' && q.selectedRangeKm <= 1.01 * last.truth.minKm;
      checks.truthEpoch = typeof q?.selectedEt === 'number' && (Math.abs(q.selectedRangeKm - last.truth.minKm) > 0.01 * last.truth.minKm || Math.abs(q.selectedEt - last.truth.minEt) <= 3600);
    }
    // Within the threshold: a closest approach measured inside it, or a distance search whose own threshold is it.
    if (test.event.thresholdKm) checks.threshold = q?.presented === true && ((typeof q.selectedRangeKm === 'number' && q.selectedRangeKm <= test.event.thresholdKm)
      || (q.kind === 'distance-range' && typeof q.params?.distanceKm === 'number' && q.params.distanceKm <= test.event.thresholdKm && q.params.relation !== 'above'));
    if (test.event.all) {
      const truth = last?.truth;
      checks.allMinimaScope = !!q && (q.scope === 'local' || q.scope === null || q.scope === undefined);
      checks.searchComplete = q?.searchComplete === true;
      checks.coversWindow = !!q?.window && !!truth?.windows?.length && q.window.start <= Math.min(...truth.windows.map(w => w.start)) + test.truth.stepSeconds
        && q.window.end >= Math.max(...truth.windows.map(w => w.end)) - test.truth.stepSeconds;
      checks.completeMinima = !!truth && truth.available >= 0.99 * truth.samples && q?.total === truth.minima;
    }
  }
  if (test.refusal) {
    checks.premiseFalse = !last?.truth || (last.truth.minKm !== null && last.truth.minKm > 1e8);
    checks.noEncounterPresented = !last?.eventQuery?.presented;
  }
  if (test.measure) checks.measurement = last?.measurement === true;
  if (test.unchanged) checks.unchanged = last?.unchanged === true;
  if (test.declined) checks.approvalAsked = (last?.approvals ?? 0) > 0;
  const answer = answerChecks(test, turns);
  checks.answerFactual = answer.ok;
  const partial = turns.some(t => t.report?.status === 'partial') && Object.entries(checks).every(([k, v]) => v || k.startsWith('goal'));
  return { checks, passed: Object.values(checks).every(Boolean), partial, answerIssues: answer.issues, rubric: test.rubric };
}

/** complete / correctly-refused / partial / incorrect / false-success / timed-out / interrupted / budget-stopped / error. */
export function classify(test, run) {
  if (run.failure === 'viewer-or-task-timeout') return 'timed-out';
  const last = run.result?.turns?.at(-1);
  if (!last || run.failure) return 'harness-error';
  if (['cancelled', 'superseded', 'stale'].includes(last.status)) return 'interrupted';
  if (last.status === 'error') return /budget|rate_limited/.test(last.errorCode ?? '') ? 'budget-stopped' : 'error';
  if (run.score.passed) return test.refusal ? 'correctly-refused' : 'complete';
  if (suspectedFalseSuccess(run)) return 'false-success';
  return run.score.partial ? 'partial' : 'incorrect';
}

/**
 * Success claimed over a failure: the state is wrong and the answer does not
 * say so, or the answer states a fact the truth contradicts.
 */
export const suspectedFalseSuccess = (run) => {
  if (!run.result || run.score?.passed || run.result.turns.at(-1)?.status !== 'done') return false;
  const reply = run.result.turns.at(-1).reply ?? '';
  const stateFailed = Object.entries(run.score.checks).some(([k, v]) => !v && k !== 'answerFactual');
  return (stateFailed && !NEGATION.test(reply)) || run.score.answerIssues.some(i => /^(distance|date|flyby claim|count)/.test(i));
};

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

/** Per model × mode: first-attempt success with uncertainty, classes, failures, latency, tokens, cost. */
export function summarizeReliability(report) {
  const groups = new Map();
  // A harness budget stop is not an attempt: counted apart, not in the rate.
  for (const run of report.runs.filter(r => r.reliability && r.classification !== 'budget-stopped')) {
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
    const perTask = {};
    for (const r of runs) { const t = (perTask[r.task] ??= { n: 0, ok: 0 }); t.n++; if (['complete', 'correctly-refused'].includes(r.classification)) t.ok++; }
    const rounds = runs.map(r => r.rounds.length), latency = runs.map(r => r.latencyMs), raw = runs.map(r => r.usage?.rawProcessed ?? NaN);
    const knownCost = runs.every(r => typeof r.usage?.estimatedUsd === 'number');
    return { arm, model, mode, samples: runs.length, firstAttemptSuccess: complete, successRate: runs.length ? complete / runs.length : null,
      wilson95: wilson(complete, runs.length), classes, failedChecks, perTask, falseSuccess: runs.filter(r => r.classification === 'false-success').length,
      // Ask's own verdicts, against the harness's.
      askVerified: runs.filter(r => r.result?.turns?.at(-1)?.result?.status === 'verified').length,
      askVerifiedButFailed: runs.filter(r => r.result?.turns?.at(-1)?.result?.status === 'verified' && !r.score?.passed).length,
      answersReplaced: runs.filter(r => r.result?.turns?.some(t => t.result?.answerIssues?.length)).length,
      rounds: { total: rounds.reduce((a, b) => a + b, 0), p50: percentile(rounds, 0.5), p95: percentile(rounds, 0.95) },
      latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) },
      rawTokens: { total: raw.filter(Number.isFinite).reduce((a, b) => a + b, 0), p50: percentile(raw, 0.5), p95: percentile(raw, 0.95) },
      estimatedUsd: knownCost ? runs.reduce((n, r) => n + r.usage.estimatedUsd, 0) : null, actualBilledUsd: null };
  });
}
