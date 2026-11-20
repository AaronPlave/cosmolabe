/**
 * What a finished Ask request comes to, for the person (#381): one line on what
 * the viewer now shows or did, the single most consequential limitation, and
 * whether the answer is the viewer's own account rather than the model's.
 * Everything else the loop reports (every check, raw ET, slot names) is kept
 * for Action details. Built from the typed result and facts, never from the
 * model's prose.
 */
import type { AskTurn } from './ask.svelte';
import { tally } from './ask.svelte';

export interface TurnPresentation {
  /** The outcome in the person's terms, or null while the request runs. */
  readonly outcome: string | null;
  readonly interpretation: string | null;
  readonly measurements: readonly { quantity: string; value: string; utc: string | null; context: string }[];
  /** The one limitation that changes what the person should believe, or null. */
  readonly limitation: { readonly text: string; readonly tone: 'warning' | 'muted' } | null;
  /** Why the shown answer is the viewer's account instead of the model's, or null. */
  readonly hostAccount: string | null;
  /** Every check, change and unobservable result, one line each, for Action details. */
  readonly diagnostics: readonly string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A failing check in the person's terms: what could not be done, not which predicate read false. */
export function plainFailure(slot: string, detail: string): string {
  const [kind, name] = slot.split(':');
  switch (kind) {
    case 'view': return `${name} is not in view (${detail})`;
    case 'legible': return `${name} is too small to make out`;
    case 'range': return `${name} is not at the requested distance (${detail})`;
    case 'clock': return `The clock is not at the requested time (${detail})`;
    case 'playing': return `Playback did not stay ${detail.includes('paused') ? 'running' : 'paused'}`;
    case 'event': return `The result shown is not the one asked for (${detail})`;
    case 'eventEpoch': return 'The clock is not at the selected result';
    case 'eventFramed': return /not drawn/.test(detail) ? `Shown at the right time, but ${detail.split(', ').filter(d => /not drawn/.test(d)).join(', ')}` : `The result's objects are not both in view (${detail})`;
    case 'eventDrawn': return 'The selected result is not drawn yet';
    case 'eventRun': return `The search did not run as asked (${detail})`;
    case 'tracked': return `The camera is ${detail}, not following the requested object`;
    case 'selected': return `The selection is wrong: ${detail}`;
    default: return detail;
  }
}

export function presentTurn(turn: AskTurn, formatTime: (et: number) => string): TurnPresentation {
  const r = turn.result;
  if (turn.status === 'running' || !r) return { measurements: [], interpretation: null, outcome: null, limitation: null, hostAccount: null, diagnostics: [] };
  const checks = r.report?.checks ?? [];
  const diagnostics = [
    ...checks.map(c => `${c.slot}: ${c.ok === null ? 'unobserved' : c.ok ? 'ok' : 'unmet'} · ${c.detail}`),
    ...r.unobservable.map(u => `not observable · ${u}`),
    ...r.changes.map(c => `goal · ${c}`),
    ...(r.escalated ? [`answered by the escalation model: ${r.escalated}`] : []),
    ...r.answerIssues.map(i => `answer contradicted facts · ${i}`),
  ];

  // The event the viewer presents, named from its own ranked result.
  const selected = /result (\S+) selected/.exec(checks.find(c => c.slot === 'event' && c.ok)?.detail ?? '')?.[1];
  const event = r.facts.filter(f => f.kind === 'event-result').find(f => f.id === selected);
  const clock = /ET ([-\d.]+)/.exec(checks.find(c => c.slot === 'clock' && c.ok)?.detail ?? '')?.[1];
  const paused = checks.some(c => c.slot === 'playing' && c.ok && c.detail === 'paused');
  const counts = tally(turn);
  let outcome: string;
  if (event) {
    const kind = event.rangeLocation === 'coverage-boundary' ? 'coverage-boundary maximum' : event.extremum === 'maximum' ? 'farthest point' : event.encounter === true ? 'flyby' : 'closest approach';
    outcome = `Showing ${kind}${paused ? ' · paused' : ''}`;
  } else if (clock && Number.isFinite(Number(clock))) outcome = `${paused ? 'Paused' : 'Clock'} at ${formatTime(Number(clock))}`;
  else if (r.status === 'no-change') outcome = turn.status === 'done' ? 'No viewer changes' : 'Request stopped';
  else outcome = `${plural(counts.done + counts.partial, 'viewer change')}${r.status === 'verified' ? ', checked' : r.status === 'unverified' ? '; not all could be checked' : ''}`;

  // Numerical evidence leads; ordinary chat/no-data keeps its natural prose.
  // One latest result per pair supports comparisons without reviving old views.
  const byPair = new Map<string, Extract<typeof r.facts[number], { kind: 'event-result' }>>();
  for (const f of r.facts) if (f.kind === 'event-result' && f.rangeKm !== null) {
    const key = `${f.observer}/${f.target}`, prior = byPair.get(key);
    if (!prior || prior.query !== f.query || (f.extremum === 'maximum' ? f.rangeKm > prior.rangeKm! : f.rangeKm < prior.rangeKm!)) byPair.set(key, f);
  }
  if (event?.rangeKm !== null && event?.rangeKm !== undefined) byPair.set(`${event.observer}/${event.target}`, event);
  const measurements: TurnPresentation['measurements'][number][] = [...byPair.values()].slice(-3).map(f => ({
    quantity: `${f.observer ?? '?'} → ${f.target ?? '?'} · ${f.rangeLocation === 'coverage-boundary' ? 'Coverage-boundary maximum' : f.extremum === 'maximum' ? 'Maximum center range' : 'Minimum center range'}`,
    value: `${Number(f.rangeKm!.toPrecision(6)).toLocaleString('en-US', { maximumSignificantDigits: 6 })} km`,
    utc: f.utc?.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC') ?? null,
    context: f.rangeLocation === 'coverage-boundary' ? 'Largest evaluated range · coverage boundary' : f.extremum === 'maximum' ? 'Largest computed turning point · searched coverage' : 'Closest computed approach · searched coverage',
  }));
  const distance = r.facts.filter(f => f.kind === 'place-distance').at(-1);
  if (distance?.km !== null && distance?.km !== undefined) measurements.push({ quantity: `${distance.object} → ${distance.placeName ?? 'Mapped reference point'} · Straight-line distance`, value: `${Number(distance.km.toPrecision(6))} km`, utc: distance.utc?.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC') ?? null, context: `${distance.frame ?? 'Frame withheld'} · ${distance.datum?.verticalDatum ?? 'reference'} datum · available at this epoch` });

  let limitation: TurnPresentation['limitation'] = null;
  const failing = checks.filter(c => c.ok === false && !c.soft);
  if (r.status === 'failed' && failing.length) limitation = { tone: 'warning', text: plainFailure(failing[0].slot, failing[0].detail) };
  else if (r.status === 'partial') limitation = { tone: 'muted', text: `Not yet observed: ${checks.filter(c => c.ok !== true).map(c => c.detail).join('; ')}` };
  else if (r.status === 'unverified') limitation = { tone: 'muted', text: `Not checked in the viewer: ${[...r.unobservable.map(u => u.replace(/^[^:]+: /, '')), ...checks.filter(c => c.ok !== true).map(c => c.detail)].join('; ')}` };

  // A boundary winner is already the selected native result.
  const edge = r.facts.filter(f => f.kind === 'range-edge').at(-1) ?? [...byPair.values()].find(f => f.rangeLocation === 'coverage-boundary');
  if (!limitation && edge) limitation = { tone: 'warning', text: `Largest at a searched interval boundary; larger ranges may occur outside it. No certified global maximum.` };

  if (!limitation && distance) limitation = { tone: 'muted', text: distance.km === null ? 'Mapped-point distance unavailable; no numerical estimate is established.' : 'Distance to the mapped anchor, not the crater rim. Source registration and position accuracy are unknown.' };
  if (!limitation && [...byPair.values()].some(f => f.extremum === 'maximum')) limitation = { tone: 'muted', text: 'Step-limited search in loaded coverage; not a certified global maximum.' };

  let hostAccount: string | null = null;
  if (r.answerSource === 'host-facts') {
    hostAccount = turn.status === 'done'
      ? `The viewer's own account is shown: the model's answer contradicted its results (${r.answerIssues[0] ?? 'see Action details'}).`
      : 'The model stopped before finishing; the viewer\'s measured account is shown and the requested view may be incomplete.';
  }
  const interpretation = measurements.length ? distance ? 'Straight-line separation to the mapped anchor.' : 'Measured between object centers.' : null;
  return { measurements, interpretation, outcome, limitation, hostAccount, diagnostics };
}
