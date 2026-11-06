/**
 * An answer checked against what the viewer published (#345): the model's
 * prose may say anything, but a number, a date or a "flyby" it states must
 * agree with a typed fact a read returned during the request. This is a check
 * for contradiction, not a judge of style. A sampled recovery must also
 * disclose its missing-data limit.
 */
import type { EventResultFact, ResultFact } from './agent.js';

const AU_KM = 1.495978707e8;
const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };
/** "4,500 km", "3.48 billion kilometres", "1.2 AU", "1.8e8 km", "1.8 × 10^8 km". */
const DISTANCE = /(?<![\d.,])([+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?))(?:\s*(?:e|[×x]\s*10\^?)\s*([+-]?\d+))?\s*(thousand|million|billion)?\s*(km|kilomet(?:er|re)s?|m|met(?:er|re)s?|AU|astronomical units?)\b/gi;
const FLYBY = /\b(fly-?bys?|flew (?:past|by)|swing-?bys?|close (?:flyby|pass|encounter)|encounters?)\b/i;
const NEGATED = /\b(no|not|never|none|neither|nor|without|isn'?t|aren'?t|wasn'?t|weren'?t|didn'?t|doesn'?t|don'?t|cannot|can'?t|rather than|only)\b/i;
const DATE = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b|\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/g;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Distances an answer states, in km. */
export function statedDistancesKm(text: string): { text: string; km: number }[] {
  return [...text.matchAll(DISTANCE)].map(m => {
    const base = Number(m[1].replace(/,/g, '')) * (m[2] ? 10 ** Number(m[2]) : 1) * (m[3] ? SCALE[m[3].toLowerCase()] : 1);
    return { text: m[0], km: /^a/i.test(m[4]) ? base * AU_KM : /^m/i.test(m[4]) ? base / 1000 : base };
  }).filter(d => Number.isFinite(d.km));
}

/** Calendar dates an answer states, as YYYY-MM-DD. */
export function statedDates(text: string): { text: string; day: string }[] {
  return [...text.matchAll(DATE)].map(m => {
    const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : m[4] ? [m[6], String(MONTHS.indexOf(m[4].toLowerCase()) + 1).padStart(2, '0'), m[5].padStart(2, '0')]
      : [m[9], String(MONTHS.indexOf(m[8].toLowerCase()) + 1).padStart(2, '0'), m[7].padStart(2, '0')];
    return { text: m[0], day: `${y}-${mo}-${d}` };
  });
}

const sentences = (text: string) => text.split(/(?<=[.!?;])\s+/);
const dayOf = (utc: string | null) => utc?.slice(0, 10) ?? null;
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * Where an answer contradicts the published facts. Distances must match a
 * published range, altitude, threshold or window within 5%; dates must fall
 * within a day of a published result or searched-window bound; a flyby claim
 * needs a result classified as an encounter.
 */
export function checkAnswer(text: string, facts: readonly ResultFact[]): string[] {
  const events = facts.filter((f): f is EventResultFact => f.kind === 'event-result');
  const issues: string[] = [];
  const samples = facts.filter(f => f.kind === 'sampled-range');
  const sampled = samples.filter(f => f.eventSearchUnavailable).at(-1);
  if (sampled && !/\b(?:gaps?|missing)\b/i.test(text)) issues.push(`The sampled alternative omits its missing-data limit: report ${sampled.missing} missing samples out of ${sampled.count}; do not infer continuous coverage.`);
  if (!events.length && !samples.length) return issues;
  const windows = facts.filter(f => f.kind === 'event-window');
  // 1 AU is a unit people compare against, not a claim.
  const known = [AU_KM, ...events.flatMap(f => [f.rangeKm, f.altitudeKm, f.thresholdKm]), ...windows.map(w => w.maxRangeKm), ...samples.flatMap(s => [s.minimumKm, ...(s.samples ?? []).map(v => v.km)])].filter((v): v is number => typeof v === 'number' && v >= 0);
  for (const d of statedDistancesKm(text)) {
    // Rounded speech ("about 1 AU", "3.5 billion km") is fine; an unsupported number is not.
    if (!known.some(k => Math.abs(d.km - k) <= (events.length ? 0.05 * k + 0.5 : Math.max(1e-6, 0.05 * k)))) issues.push(`"${d.text}" matches no distance the viewer reported (${[...new Set([...events.flatMap(f => [f.rangeKm, f.altitudeKm]), ...samples.map(s => s.minimumKm)].filter((v): v is number => typeof v === 'number'))].slice(0, 6).map(v => `${v.toPrecision(4)} km`).join(', ')})`);
  }
  const days = [...events.map(f => dayOf(f.utc)), ...windows.flatMap(w => [dayOf(w.startUtc), dayOf(w.endUtc)]), ...samples.flatMap(s => [dayOf(s.minimumUtc), dayOf(s.startUtc), dayOf(s.endUtc), ...(s.samples ?? []).map(v => dayOf(v.utc))])].filter((v): v is string => !!v);
  for (const d of statedDates(text)) if (days.length && !days.some(k => dayDiff(k, d.day) <= 1)) issues.push(`"${d.text}" matches no date the viewer reported`);
  // Calendar timestamps are compared at the precision the answer actually states.
  // Dates alone keep the existing one-day tolerance; a stated clock time must
  // match a published epoch/window bound within a second or displayed minute.
  const epochs = [...events.map(e => e.utc), ...windows.flatMap(w => [w.startUtc, w.endUtc]), ...samples.flatMap(s => [s.minimumUtc, s.startUtc, s.endUtc, ...(s.samples ?? []).map(v => v.utc)])].filter((v): v is string => !!v).map(Date.parse).filter(Number.isFinite);
  const timestamps = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|\s*UTC)?\b/g;
  for (const m of text.matchAll(timestamps)) {
    const epoch = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}.${m[5] ?? '000'}Z`);
    const tolerance = m[4] ? 1000 : 60000;
    if (epochs.length && !epochs.some(e => Math.abs(e - epoch) < tolerance)) issues.push(`"${m[0]}" matches no epoch the viewer reported`);
  }
  const ets = samples.flatMap(s => [s.minimumEt, ...(s.samples ?? []).map(v => v.et)]);
  for (const m of text.matchAll(/\bET\s*([+-]?\d+(?:\.\d+)?)/g)) {
    if (ets.length && !ets.some(e => Math.abs(e - Number(m[1])) <= 1)) issues.push(`"${m[0]}" matches no sampled epoch the viewer reported`);
  }
  const classified = events.filter(f => f.encounter !== null);
  if (classified.length && classified.every(f => f.encounter === false)) {
    // Names quoted from the catalog ("Mars Flyby (2026-05-15)") are not claims.
    const claim = sentences(text.replace(/["“][^"”]*["”]/g, '')).find(s => FLYBY.test(s) && !NEGATED.test(s));
    if (claim) {
      const f = classified[0];
      issues.push(`"${claim.trim().slice(0, 120)}" presents a flyby, but every result is outside the ${f.criterion === 'sphere-of-influence' ? `${f.criterionBody}'s sphere of influence (${f.thresholdKm?.toExponential(2)} km)` : `encounter limit (${f.thresholdKm} km)`}: distant range minima, not flybys`);
    }
  }
  return issues;
}

/** A plain account of published event or sampled-range facts: what the host shows when the model's answer contradicts them. */
export function factSummary(facts: readonly ResultFact[]): string {
  const events = facts.filter((f): f is EventResultFact => f.kind === 'event-result' && f.rangeKm !== null);
  const sampled = facts.filter(f => f.kind === 'sampled-range').at(-1);
  if (sampled && (!events.length || sampled.eventSearchUnavailable)) {
    return `${sampled.eventSearchUnavailable ? 'Event Finder could not compute the requested event because a SPICE frame dependency is unavailable. ' : ''}The minimum among ${sampled.count} returned ${sampled.observer}–${sampled.target} center-distance samples from ${sampled.startUtc} to ${sampled.endUtc} (${sampled.missing} missing) is ${sampled.minimumKm} km at ${sampled.minimumUtc} (ET ${sampled.minimumEt}). This is an approximate sampled minimum, not a verified closest approach, physical surface clearance or touchdown.`;
  }
  if (!events.length) return '';
  const closest = events.reduce((a, b) => (b.rangeKm! < a.rangeKm! ? b : a));
  const range = (km: number) => km >= 1e6 ? `${km.toExponential(2)} km` : `${Number(km.toPrecision(6)).toLocaleString('en-US', { maximumSignificantDigits: 6 })} km`;
  const kind = closest.encounter === true ? 'a flyby' : closest.encounter === false ? 'a distant range minimum, not a flyby' : 'a closest approach';
  return `The viewer's closest ${closest.observer ?? ''}–${closest.target ?? ''} result is ${range(closest.rangeKm!)}${closest.utc ? ` on ${closest.utc.slice(0, 10)}` : ''}: ${kind}${closest.criterion === 'sphere-of-influence' && closest.thresholdKm ? ` (${closest.criterionBody}'s sphere of influence is ${range(closest.thresholdKm)})` : ''}.`;
}
