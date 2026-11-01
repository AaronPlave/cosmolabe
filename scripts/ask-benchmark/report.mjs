import { createHash } from 'node:crypto';

/** Compact public observations without retaining repeated inventories/state. */
export function compactReport(report) {
  if (report.observations) return report;
  const observations = {};
  const ids = new Map();
  const runs = report.runs.map(run => {
    if (!run.result) return run;
    const { stable: _stable, ...state } = run.result.state;
    const steps = run.result.steps.map(step => {
      const { observation, ...rest } = step;
      if (observation === undefined) return rest;
      const key = JSON.stringify(observation);
      let id = ids.get(key);
      if (!id) { id = `o${ids.size + 1}`; ids.set(key, id); observations[id] = observation; }
      return { ...rest, observationRef: id };
    });
    return { ...run, result: { ...run.result, state, steps } };
  });
  return { ...report, runs, observations };
}

export function cellId(run) { return `${run.task}/${run.model}/${run.mode}/${run.repeat}`; }

export function summarizeReport(report, reviews = {}) {
  const groups = [];
  for (const model of report.models) for (const mode of ['fixed', 'discovery']) {
    const runs = report.runs.filter(r => r.model === model && r.mode === mode);
    const reviewed = run => reviews[cellId(run)]?.verdict ?? 'pending-review';
    const knownCost = runs.every(r => r.usage?.estimatedUsd !== null && r.usage?.estimatedUsd !== undefined);
    groups.push({ model, mode, samples: runs.length, statePassed: runs.filter(r => r.score?.passed).length,
      factualPassed: runs.filter(r => reviewed(r) === 'pass').length,
      factualPartial: runs.filter(r => reviewed(r) === 'partial').length,
      factualFailed: runs.filter(r => reviewed(r) === 'fail').length,
      factualPending: runs.filter(r => reviewed(r) === 'pending-review').length,
      fullyVerified: runs.filter(r => r.score?.passed && reviewed(r) === 'pass').length,
      requests: runs.reduce((n, r) => n + r.rounds.length, 0),
      latencyMs: runs.reduce((n, r) => n + (r.latencyMs ?? 0), 0),
      rawProcessed: runs.reduce((n, r) => n + (r.usage?.rawProcessed ?? 0), 0),
      estimatedUsd: knownCost ? runs.reduce((n, r) => n + r.usage.estimatedUsd, 0) : null,
      actualBilledUsd: null });
  }
  return groups;
}

/** Bind human reviews to the exact retained evidence, including answer text. */
export function reportDigest(report) {
  const { review: _review, summary: _summary, ...evidence } = compactReport(report);
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
