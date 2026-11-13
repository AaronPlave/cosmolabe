/** Local help from shared capabilities and observed scene evidence. No model or writes. */
export interface GuidanceScene {
  selectedObject?: string | null;
  time?: { et: number };
  viewpoints?: { items?: readonly { name: string; source?: string; center?: string | null; epoch?: number | null }[] };
  focusImagery?: { body: string; total: number } | null;
  activitiesHere?: readonly { id: string; name: string; vehicle: string; start: number; end: number; selected: boolean }[];
  profilesHere?: readonly { id: string; label: string; plotted: boolean }[];
  searchesHere?: readonly { id: string; label: string; computed: boolean }[];
  sourcePairs?: readonly GuidancePair[];
}
export interface AskExample { kind: 'show' | 'inspect' | 'explore'; label: string; prompt: string; evidence: string }
export interface GuidancePair {
  observer: string; target: string; positionAvailable: boolean | null; explicitlySelected: boolean;
  coverage?: readonly { start: number; end: number }[];
}
export interface AskHelp { categories: string[]; examples: AskExample[]; authority: string }
type Capability = { id: string; available: boolean };
export function guidanceOverview(capabilities: readonly Capability[]): string[] {
  const has = (ids: string[]) => ids.some(id => capabilities.some(c => c.available && c.id === id));
  return [
    has(['camera.viewpoint', 'camera.frameObject', 'camera.composeView']) ? 'Navigate and frame objects, places and times.' : null,
    has(['spatial.getObjectState', 'surface.getImagery', 'surface.getSurfaceData', 'activities.listActivities']) ? 'Inspect scene data, sources and their limits.' : null,
    has(['profiles.sampleProfileData', 'analysis.analyzeTrajectoryExtrema']) ? 'Measure motion and plot supported quantities.' : null,
    has(['events.findClosestApproach', 'events.getEventResultPage', 'profiles.sampleProfileData']) ? 'Investigate changes and compare native results.' : null,
  ].filter((s): s is string => s !== null);
}
export const ASK_AUTHORITY = 'Answers use this scene’s loaded data. Public mission background cannot fill missing measurements or prove what this view shows.';
export function guidanceExamples({ capabilities, scene, pair = null }: {
  capabilities: readonly Capability[]; scene: GuidanceScene; pair?: GuidancePair | null;
}): AskExample[] {
  const available = new Set(capabilities.filter(c => c.available).map(c => c.id));
  const ranked: { score: number; key: string; example: AskExample }[] = [];
  const add = (score: number, key: string, example: AskExample) => ranked.push({ score, key, example });
  const selected = scene.selectedObject;
  const now = scene.time?.et;
  for (const q of scene.searchesHere ?? []) if (available.has('events.getEventResultPage')) add(q.computed ? 1000 : 500, `query:${q.id}`, {
    kind: 'explore', label: `${q.computed ? 'Explain' : 'Investigate'} ${q.label}`,
    prompt: `Inspect the native search ${JSON.stringify(q.id)}. ${q.computed ? 'Explain its existing results and show a useful result view' : 'Check its source coverage before running it, then show what it supports'}. State the searched interval and limits.`,
    evidence: q.computed ? 'A native result is available; check its interval and frame a useful result.' : 'A search is configured; no calculated result is implied.',
  });
  for (const p of scene.profilesHere ?? []) if (available.has('profiles.sampleProfileData')) add(p.plotted ? 850 : 550, `profile:${p.id}`, {
    kind: 'explore', label: `Understand ${p.label}`, prompt: `Inspect native profile ${JSON.stringify(p.id)}, show its trace and explain its change over the visible timeline, including missing samples and source limits.`,
    evidence: p.plotted ? 'A native trace is already visible; inspect what it measures and where data is missing.' : 'A profile is configured; inspect availability before interpreting it.',
  });
  for (const a of scene.activitiesHere ?? []) if (available.has('activities.getActivity') && available.has('activities.seekActivity')) {
    const active = now !== undefined && a.start <= now && now <= a.end;
    add(a.selected ? 950 : a.vehicle === selected ? 820 : active ? 700 : 400, `activity:${a.id}`, {
      kind: 'show', label: `Explore ${a.name}`, prompt: `Inspect catalog activity ${JSON.stringify(a.id)} and its timing/source limits, then use the native activity and scene controls to show what it describes. Distinguish catalog timing from a computed event.`,
      evidence: `${a.selected ? 'Selected' : active ? 'At the current time' : 'Loaded'} catalog activity for ${a.vehicle}; timing is authored, not newly measured.`,
    });
  }
  const imagery = scene.focusImagery;
  if (available.has('surface.getImagery') && imagery && imagery.total > 0) add(imagery.body === selected ? 810 : 620, `imagery:${imagery.body}`, {
    kind: 'inspect', label: `Inspect imagery on ${imagery.body}`, prompt: `What imagery is configured on ${JSON.stringify(imagery.body)}, where does it come from, and what can the current view establish? Check acquisition dates, loading and drawing separately; do not infer changed content from dates.`,
    evidence: `${imagery.total} imagery layers listed in this scene. Check whether they are loaded and visible here.`,
  });
  for (const p of [pair, ...(scene.sourcePairs ?? [])]) {
    if (!p || (!p.explicitlySelected && !p.coverage?.length) || p.positionAvailable !== true || p.observer === p.target || !available.has('profiles.upsertProfile') || !available.has('profiles.sampleProfileData')) continue;
    const interval = p.coverage?.length ? ` Inspect declared source intervals ${p.coverage.map(w => `ET ${w.start} to ${w.end}`).join('; ')} and use the covered interval; do not bridge gaps.` : ' Use the visible timeline and check coverage.';
    add(p.explicitlySelected ? 800 : 650, `pair:${p.observer}:${p.target}`, {
      kind: 'explore', label: `Explore ${p.observer}–${p.target} motion`,
      prompt: `Investigate how ${JSON.stringify(p.observer)} moves relative to ${JSON.stringify(p.target)}. Show native center-distance and signed range-rate profiles to compare closing and opening.${interval} Explain what the plots show and frame a useful scene view. Report missing samples; this is not surface clearance.`,
      evidence: 'Ask to plot distance between object centers. Some dates may have no data; this does not measure distance to a surface.',
    });
  }
  if (available.has('camera.viewpoint')) {
    const views = (scene.viewpoints?.items ?? []).filter(v => v.source === 'catalog-viewpoint').map(v => ({ v,
      score: (selected && v.center === selected ? 300 : 100) + (now !== undefined && v.epoch != null ? 50 / (1 + Math.abs(v.epoch - now) / 86400) : 0),
    })).sort((a,b) => b.score-a.score || a.v.name.localeCompare(b.v.name)).slice(0,2);
    for (const {v,score} of views) add(score, `view:${v.name}`, { kind: 'show', label: `Show ${v.name}`, prompt: `Show the authored viewpoint ${JSON.stringify(v.name)} and explain what is actually visible.`, evidence: 'Preset camera view; no event calculated. Objects may be small or hidden.' });
  }
  const seen = new Set<string>();
  return ranked.sort((a,b) => b.score-a.score || a.key.localeCompare(b.key)).filter(r => !seen.has(r.key) && !!seen.add(r.key)).slice(0,5).map(r => r.example);
}
