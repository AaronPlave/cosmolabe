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
    has(['camera.viewpoint', 'camera.frameObject', 'camera.composeView']) ? 'Show views' : null,
    has(['spatial.getObjectState', 'surface.getImagery', 'surface.getSurfaceData', 'activities.listActivities']) ? 'Explain data' : null,
    has(['profiles.sampleProfileData', 'analysis.analyzeTrajectoryExtrema']) ? 'Plot' : null,
    has(['events.findClosestApproach', 'events.getEventResultPage', 'profiles.sampleProfileData']) ? 'Compare' : null,
  ].filter((s): s is string => s !== null);
}
export const ASK_AUTHORITY = 'Ask uses the data loaded here. Missing measurements stay unknown; mission background cannot fill them in.';
export function guidanceExamples({ capabilities, scene, pair = null }: {
  capabilities: readonly Capability[]; scene: GuidanceScene; pair?: GuidancePair | null;
}): AskExample[] {
  const available = new Set(capabilities.filter(c => c.available).map(c => c.id));
  const ranked: { score: number; key: string; example: AskExample }[] = [];
  const add = (score: number, key: string, example: AskExample) => ranked.push({ score, key, example });
  const selected = scene.selectedObject;
  const now = scene.time?.et;
  for (const q of scene.searchesHere ?? []) if (available.has('events.getEventResultPage')) add(q.computed ? 1000 : 500, `query:${q.id}`, {
    kind: 'explore', label: `${q.computed ? 'Results:' : 'Search:'} ${q.label}`,
    prompt: q.computed ? `Show me what ${q.label} found and help me understand it.` : `Investigate ${q.label} and show me what the data supports.`,
    evidence: q.computed ? 'Results are ready to explore.' : 'A saved search; it has not produced a result yet.',

  });
  for (const p of scene.profilesHere ?? []) if (available.has('profiles.sampleProfileData')) add(p.plotted ? 850 : 550, `profile:${p.id}`, {
    kind: 'explore', label: `Plot: ${p.label}`, prompt: `Explain ${p.label}.`,
    evidence: p.plotted ? 'A plot is already visible.' : 'A saved plot to explore.',

  });
  for (const a of scene.activitiesHere ?? []) if (available.has('activities.getActivity') && available.has('activities.seekActivity')) {
    const active = now !== undefined && a.start <= now && now <= a.end;
    add(a.selected ? 950 : a.vehicle === selected ? 820 : active ? 700 : 400, `activity:${a.id}`, {
      kind: 'show', label: `Visit ${a.name}`, prompt: `Show ${a.name}.`,
      evidence: `${a.selected ? 'Selected activity' : active ? 'Happening at this scene time' : 'An activity in this scene'} for ${a.vehicle}; timing comes from the catalog.`,

    });
  }
  const imagery = scene.focusImagery;
  if (available.has('surface.getImagery') && imagery && imagery.total > 0) add(imagery.body === selected ? 810 : 620, `imagery:${imagery.body}`, {
    kind: 'inspect', label: `Images of ${imagery.body}`, prompt: `Show ${imagery.body} imagery and its sources.`,
    evidence: `${imagery.total} image layers listed; loading may be incomplete.`,

  });
  for (const p of [pair, ...(scene.sourcePairs ?? [])]) {
    if (!p || (!p.explicitlySelected && !p.coverage?.length) || p.positionAvailable !== true || p.observer === p.target || !available.has('profiles.upsertProfile') || !available.has('profiles.sampleProfileData')) continue;
    add(p.explicitlySelected ? 800 : 650, `pair:${p.observer}:${p.target}`, {
      kind: 'explore', label: `${p.observer}–${p.target} distance`,
      prompt: `Plot ${p.observer}–${p.target} distance over time.`,
      evidence: 'Explore their changing distance using the loaded trajectory.',

    });
  }
  if (available.has('camera.viewpoint')) {
    const views = (scene.viewpoints?.items ?? []).filter(v => v.source === 'catalog-viewpoint').map(v => ({ v,
      score: (selected && v.center === selected ? 300 : 100) + (now !== undefined && v.epoch != null ? 50 / (1 + Math.abs(v.epoch - now) / 86400) : 0),
    })).sort((a,b) => b.score-a.score || a.v.name.localeCompare(b.v.name)).slice(0,2);
    for (const {v,score} of views) add(score, `view:${v.name}`, { kind: 'show', label: `View ${v.name}`, prompt: `Show ${v.name}.`, evidence: 'A saved camera view, not a calculated event.' });
  }
  const seen = new Set<string>();
  return ranked.sort((a,b) => b.score-a.score || a.key.localeCompare(b.key)).filter(r => !seen.has(r.key) && !!seen.add(r.key)).slice(0,5).map(r => r.example);
}
