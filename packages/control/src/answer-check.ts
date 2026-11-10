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
  const height = facts.filter(f => f.kind === 'height-analysis').at(-1);
  for (const m of text.matchAll(/\b(?:all|across|over)\s+(?:the\s+)?(\d+)\s+(?:[a-z][a-z'-]*\s+){0,3}?(flights?|hops?|activities|intervals?)\b/gi)) {
    const kind=/^activit/i.test(m[2])?'activity':m[2].toLowerCase().replace(/s$/,'');
    const inventory=facts.filter(f=>f.kind==='activity-inventory').filter(f=>text.toLowerCase().includes(f.object.toLowerCase())).at(-1);
    const expected=height?.requested || (inventory ? kind==='activity'||kind==='interval' ? Object.values(inventory.counts).reduce((a,b)=>a+b,0) : inventory.counts[kind] : undefined);
    if (expected!==undefined && Number(m[1])!==expected) issues.push(`The full native collection contains ${expected} requested intervals, not ${m[1]}. A bounded name-resolution candidate list is not the collection size.`);
  }
  if (height) {
    if (height.evaluated && height.evaluated>height.completed) {
      const subset=new RegExp(`\\b(?:highest|lowest|best|maximum|minimum)\\b[^.!?]{0,100}\\b(?:of|among)\\s+(?:the\\s+)?${height.completed}\\s+(?:flights?|intervals?|results?)\\b`,'i');
      const gapFreeSubset=/\b(?:highest|lowest|best|maximum|minimum)\b[^.!?]{0,50}\b(?:of|among)\b[^.!?]{0,80}\b(?:fully measured|fully covered|gap-free|without gaps)\b/i;
      if (subset.test(text)||gapFreeSubset.test(text)) issues.push(`The candidate compares all ${height.evaluated} returned interval candidates, including partial ones; ${height.completed} counts intervals without detected gaps, not the comparison subset. State that distinction.`);
    }
    for (const m of text.matchAll(/\b(?:analy[sz]ed|evaluated|compared|covered)\s+(?:only\s+)?(\d+)\s+(?:of\s+(?:the\s+)?\d+\s+)?(?:flights?|intervals?|activities)\b/gi)) {
      const context=text.slice(Math.max(0,m.index!-18),m.index!+m[0].length+30);
      if(height.evaluated && Number(m[1])!==height.evaluated && !/fully|completely|gap-free|without (?:detected )?gaps|no detected gaps/i.test(context)) issues.push(`All ${height.evaluated} intervals produced candidates; ${height.completed} is the gap-free count, not how many were analyzed. State both counts accurately.`);
    }
    for(const m of text.matchAll(/\b(?:after|only)\s+(\d+)\s+of\s+\d+\s+(?:flights?|intervals?|activities)\b/gi)) {
      if(height.evaluated && Number(m[1])!==height.evaluated && /budget|allowance/i.test(text)) issues.push(`The collection produced ${height.evaluated} interval candidates. Local numerical limits did not stop it after ${m[1]} intervals; ${height.completed} counts gap-free results.`);
    }
    if (height.budgetExhausted===false && /\bbudget\s+(?:(?:was|is|has been|had been)\s+)?(?:ran out|run out|exhausted|reached|used up)|\b(?:ran|run)\s+out\s+of\s+(?:its |the |work |evaluation )*budget\b/i.test(text)) issues.push('No numerical work-budget exhaustion was reported. Explain the actual coverage gaps instead of inventing a budget failure.');
    if (height.terrainSourceKnown && /\bterrain source\s+(?:(?:is|was)\s+)?(?:not (?:identified|known)|unknown|unidentified)/i.test(text)) issues.push('The result used an identified versioned physical terrain source. Its private identifier may be withheld from Ask; that does not make the source unidentified or its accuracy certified.');
    if (height.sourceKind==='estimated-reconstruction' && !/estimated|reconstruct|not\s+(?:3D\s+)?telemetry/i.test(text)) issues.push('The trajectory source is an estimated reconstruction, not telemetry. State that provenance with the numerical result.');
    if (height.sourceKind==='synthetic' && !/synthetic|demo/i.test(text)) issues.push('The numerical source is synthetic. State that provenance with the result.');
    if (sentences(text).some(s => /\b(?:certified|verified|true|exact)\s+(?:global\s+)?(?:maximum|minimum|highest|lowest|winner)\b/i.test(s) && !NEGATED.test(s))) issues.push('Height extrema are sampled and locally refined; no certified global height error or physical accuracy is available.');
    if (!height.winner && height.status!=='clarification' && sentences(text).some(s => !s.includes('?') && /\b(?:highest|lowest|winner|maximum|minimum)\b/i.test(s) && /\b(?:all|every|entire)\b/i.test(s) && !/\b(?:sampled|available|covered|partial|candidate)\b/i.test(s) && !NEGATED.test(s))) issues.push('Incomplete or unexecuted height scope cannot establish a collection winner. State the actual limitation and completed/requested interval counts.');
  }
  const authored=facts.filter(f=>f.kind==='authored-viewpoint');
  if (authored.length && !events.length && !facts.some(f=>f.kind==='sampled-range')) {
    for (const date of statedDates(text)) if (!authored.some(f=>dayOf(f.utc)===date.day)) issues.push(`"${date.text}" matches no authored viewpoint date read in this request.`);
  }
  const existence = facts.filter(f => f.kind === 'scene-existence');
  for (const sentence of sentences(text).filter(s => /exist|scene|configur/i.test(s))) {
    const later = /\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|hours?|hrs?)(?:\s*(?:and\s*)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s))?\s+later\b/ig;
    for (const m of sentence.matchAll(later)) {
      const unit = /^h/i.test(m[2]) ? 3600 : /^m/i.test(m[2]) ? 60 : 1;
      const seconds = Number(m[1]) * unit + Number(m[3] ?? 0);
      const tolerance = Math.max(1, m[3] ? 0.5 : unit / 2);
      if (existence.length && !existence.some(f => Math.abs(f.secondsBeforeStart - seconds) <= tolerance)) issues.push('The relative scene-existence time contradicts the returned ET difference. Quote the configured start UTC or the provided seconds-before-start; this is a rendering boundary, not a physical release time.');
    }
  }
  const samples = facts.filter(f => f.kind === 'sampled-range');
  const sampled = samples.filter(f => f.eventSearchUnavailable).at(-1);
  const disclosedMissing = sampled && new RegExp(`\\b${sampled.missing}\\s+(?:missing|(?:sample|position)s? missing)\\b|\\bmissing (?:samples?|positions?)\\s*[:=]?\\s*${sampled.missing}\\b${sampled.missing === 0 ? '|\\b(?:no|zero|none)\\s+(?:missing|gaps?)\\b|\\bgaps?\\s*[:=]?\\s*(?:0|none)\\b' : ''}`, 'i').test(text);
  if (sampled && !disclosedMissing) issues.push(`The sampled alternative omits its missing-data limit: report ${sampled.missing} missing samples out of ${sampled.count}; do not infer continuous coverage.`);
  if (samples.length && !events.length) {
    const unsupported = sentences(text).find(s => /\b(?:true|exact|verified|confirmed|actual)\s+(?:physical\s+)?(?:separation|release|detachment|contact|touchdown)\b/i.test(s) && !NEGATED.test(s) && !/\b(?:not|cannot|can't|doesn't|does not|unresolved|unknown|uncertain|unconfirmed)\b/i.test(s));
    if (unsupported) issues.push('Sampled center distances cannot establish a true/exact/verified physical transition. Describe sampled relative motion and its cadence as evidence consistent with a transition, not a certified release or contact time.');
  }
  if (!events.length && !samples.length) return issues;
  const windows = facts.filter(f => f.kind === 'event-window');
  // 1 AU is a unit people compare against, not a claim.
  const known = [...(events.length ? [AU_KM] : []), ...events.flatMap(f => [f.rangeKm, f.altitudeKm, f.thresholdKm]), ...windows.map(w => w.maxRangeKm), ...samples.flatMap(s => [s.minimumKm, ...(s.samples ?? []).map(v => v.km)])].filter((v): v is number => typeof v === 'number' && v >= 0);
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
  // An overall decrease can contain a rebound; a steady/monotonic claim cannot.
  const history = [...(samples.at(-1)?.samples ?? [])].sort((a,b) => a.et-b.et);
  for (const sentence of sentences(text)) {
    const trend = /(?:fell|decreased?|declined?|dropped?)\s+(?:steadily|monotonically)|(?:steadily|monotonically)\s+(?:fell|decreased?|declined?|dropped?)/i.test(sentence) ? -1
      : /(?:rose|increased?|grew)\s+(?:steadily|monotonically)|(?:steadily|monotonically)\s+(?:rose|increased?|grew)/i.test(sentence) ? 1 : 0;
    if (trend && !NEGATED.test(sentence) && history.some((v,i) => i > 0 && trend * (v.km-history[i-1].km) < -Math.max(1e-6, history[i-1].km*0.01))) issues.push('The claimed steady/monotonic trend contradicts a reversal in the returned samples. Describe the overall change and rebound instead.');
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
  const height = facts.filter(f => f.kind === 'height-analysis').at(-1);
  if (height?.status==='clarification') return height.message;
  const metric=height?.metric==='heightAbovePhysicalTerrain'?'geodetic-normal physical terrain clearance':height?.metric==='heightAboveReferenceEllipsoid'?'reference-ellipsoid height':height?.metric==='radialHeightAboveReferenceSphere'?'radial reference-sphere height':height?.metric;
  const budget=height?.budgetLimitedIntervals?` ${height.budgetLimitedIntervals} ${height.budgetLimitedIntervals===1?'interval exhausted its':'intervals exhausted their'} numerical allowance.`:'';
  const terrain=height?.terrainSourceKnown?' A versioned physical terrain source was used.':'';
  const source=height?.sourceKind==='estimated-reconstruction'?' Source is an estimated reconstruction, not telemetry.':height?.sourceKind==='synthetic'?' Source is synthetic.':'';
  if (height?.candidate && !height.winner) return `${height.evaluated}/${height.requested} intervals produced numerical candidates; ${height.completed} have no detected gaps. The best available sampled ${metric} candidate is ${height.candidate.value} km at ${height.candidate.utc} (${height.candidate.activityId??height.candidate.object}); ${height.gapIntervals} intervals have declared trajectory gaps up to ${height.maximumGapSeconds} seconds.${budget} No full-scope winner or global error bound is established.${source}${terrain}${height.shown?' The viewer is paused at this candidate with its vehicle selected and tracked.':''}`;
  if (height) return height.winner ? `${height.completed}/${height.requested} requested intervals have sampled-complete results. The sampled and locally refined ${metric} result for ${height.winner.object} is ${height.winner.value} km at ${height.winner.utc}${height.winner.activityId ? ` (${height.winner.activityId})` : ''}. Global height error and source accuracy are not certified; navigation is a separate viewer outcome.${source}${terrain}`
    : `${height.message} ${height.completed}/${height.requested} requested intervals completed; no collection winner was established.`;
  const events = facts.filter((f): f is EventResultFact => f.kind === 'event-result' && f.rangeKm !== null);
  const sampled = facts.filter(f => f.kind === 'sampled-range').at(-1);
  if (sampled && (!events.length || sampled.eventSearchUnavailable)) {
    return `${sampled.eventSearchUnavailable ? 'Event Finder could not compute the requested event because a SPICE frame dependency is unavailable. ' : ''}The minimum among ${sampled.count} returned ${sampled.observer}–${sampled.target} center-distance samples from ${sampled.startUtc} to ${sampled.endUtc} (${sampled.missing} missing) is ${sampled.minimumKm} km at ${sampled.minimumUtc} (ET ${sampled.minimumEt}). This is an approximate sampled minimum, not a verified closest approach, physical surface clearance or touchdown.`;
  }
  if (!events.length) {
    const existence = facts.filter(f => f.kind === 'scene-existence').at(-1);
    const authored=facts.filter(f=>f.kind==='authored-viewpoint').at(-1);
    const inventory=facts.filter(f=>f.kind==='activity-inventory').at(-1);
    return existence ? `The clock is at ET ${existence.observedEt}. ${existence.object}'s configured scene existence starts at ${existence.startUtc ?? `ET ${existence.startEt}`}, ${existence.secondsBeforeStart.toFixed(3)} seconds later. It is not independently drawn at this earlier time. This is a rendering boundary, not a measured release event.` : authored ? `The authored scene viewpoint "${authored.name}" has time ${authored.utc}. This is a catalog annotation, not a computed physical event.` : inventory ? `${inventory.object} has ${Object.entries(inventory.counts).map(([kind,total])=>`${total} enabled ${kind} activities`).join(', ')} in the native catalog. A bounded name-resolution list is not the full collection or a numerical result.` : '';
  }
  const closest = events.reduce((a, b) => (b.rangeKm! < a.rangeKm! ? b : a));
  const range = (km: number) => km >= 1e6 ? `${km.toExponential(2)} km` : `${Number(km.toPrecision(6)).toLocaleString('en-US', { maximumSignificantDigits: 6 })} km`;
  const kind = closest.encounter === true ? 'a flyby' : closest.encounter === false ? 'a distant range minimum, not a flyby' : 'a closest approach';
  return `The viewer's closest ${closest.observer ?? ''}–${closest.target ?? ''} result is ${range(closest.rangeKm!)}${closest.utc ? ` on ${closest.utc.slice(0, 10)}` : ''}: ${kind}${closest.criterion === 'sphere-of-influence' && closest.thresholdKm ? ` (${closest.criterionBody}'s sphere of influence is ${range(closest.thresholdKm)})` : ''}.`;
}
