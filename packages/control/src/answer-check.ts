/**
 * An answer checked against what the viewer published (#345): the model's
 * prose may say anything, but a number, a date or a "flyby" it states must
 * agree with a typed fact a read returned during the request. This is a check
 * for contradiction, not a judge of style: an answer that states nothing
 * checkable passes.
 */
import type { EventResultFact, ResultFact } from './agent.js';

const AU_KM = 1.495978707e8;
const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };
/** "4,500 km", "3.48 billion kilometres", "1.2 AU", "1.8e8 km", "1.8 × 10^8 km". */
const DISTANCE = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*(?:e|×\s*10\^?)\s*([+-]?\d+))?\s*(thousand|million|billion)?\s*(km|kilomet(?:er|re)s?|AU|astronomical units?)\b/gi;
const FLYBY = /\b(fly-?bys?|flew (?:past|by)|swing-?bys?|close (?:flyby|pass|encounter)|encounters?)\b/i;
const NEGATED = /\b(no|not|never|none|neither|nor|without|isn'?t|aren'?t|wasn'?t|weren'?t|didn'?t|doesn'?t|don'?t|cannot|can'?t|rather than|only)\b/i;
const DATE = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b|\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/g;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Distances an answer states, in km. */
export function statedDistancesKm(text: string): { text: string; km: number }[] {
  return [...text.matchAll(DISTANCE)].map(m => {
    const base = Number(m[1].replace(/,/g, '')) * (m[2] ? 10 ** Number(m[2]) : 1) * (m[3] ? SCALE[m[3].toLowerCase()] : 1);
    return { text: m[0], km: /^a/i.test(m[4]) ? base * AU_KM : base };
  }).filter(d => Number.isFinite(d.km) && d.km > 0);
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
  if (!events.length) return [];
  const windows = facts.filter(f => f.kind === 'event-window');
  const issues: string[] = [];
  // 1 AU is a unit people compare against, not a claim.
  const known = [AU_KM, ...events.flatMap(f => [f.rangeKm, f.altitudeKm, f.thresholdKm]), ...windows.map(w => w.maxRangeKm)].filter((v): v is number => typeof v === 'number' && v > 0);
  for (const d of statedDistancesKm(text)) {
    // Rounded speech ("about 1 AU", "3.5 billion km") is fine; an unsupported number is not.
    if (!known.some(k => Math.abs(d.km - k) <= 0.05 * k + 0.5)) issues.push(`"${d.text}" matches no distance the viewer reported (${[...new Set(events.flatMap(f => [f.rangeKm, f.altitudeKm]).filter((v): v is number => typeof v === 'number'))].slice(0, 6).map(v => `${v.toPrecision(4)} km`).join(', ')})`);
  }
  const days = [...events.map(f => dayOf(f.utc)), ...windows.flatMap(w => [dayOf(w.startUtc), dayOf(w.endUtc)])].filter((v): v is string => !!v);
  for (const d of statedDates(text)) if (days.length && !days.some(k => dayDiff(k, d.day) <= 1)) issues.push(`"${d.text}" matches no date the viewer reported`);
  const classified = events.filter(f => f.encounter !== null);
  if (classified.length && classified.every(f => f.encounter === false)) {
    const claim = sentences(text).find(s => FLYBY.test(s) && !NEGATED.test(s));
    if (claim) {
      const f = classified[0];
      issues.push(`"${claim.trim().slice(0, 120)}" presents a flyby, but every result is outside the ${f.criterion === 'sphere-of-influence' ? `${f.criterionBody}'s sphere of influence (${f.thresholdKm?.toExponential(2)} km)` : `encounter limit (${f.thresholdKm} km)`}: distant range minima, not flybys`);
    }
  }
  return issues;
}

/** A plain account of published event facts: what the host shows when the model's answer contradicts them. */
export function factSummary(facts: readonly ResultFact[]): string {
  const events = facts.filter((f): f is EventResultFact => f.kind === 'event-result' && f.rangeKm !== null);
  if (!events.length) return '';
  const closest = events.reduce((a, b) => (b.rangeKm! < a.rangeKm! ? b : a));
  const range = (km: number) => km >= 1e6 ? `${km.toExponential(2)} km` : `${Math.round(km).toLocaleString('en-US')} km`;
  const kind = closest.encounter === true ? 'a flyby' : closest.encounter === false ? 'a distant range minimum, not a flyby' : 'a closest approach';
  return `The viewer's closest ${closest.observer ?? ''}–${closest.target ?? ''} result is ${range(closest.rangeKm!)}${closest.utc ? ` on ${closest.utc.slice(0, 10)}` : ''}: ${kind}${closest.criterion === 'sphere-of-influence' && closest.thresholdKm ? ` (${closest.criterionBody}'s sphere of influence is ${range(closest.thresholdKm)})` : ''}.`;
}
