/** Local composer examples: registry + observed scene facts, no inference or model. */
export interface GuidanceScene {
  viewpoints?: { items?: readonly { name: string; source: string }[] };
  focusImagery?: { body: string; total: number } | null;
}
export interface AskExample { kind: 'show' | 'inspect' | 'explore'; label: string; prompt: string; evidence: string }
export interface GuidancePair { observer: string; target: string; positionAvailable: boolean | null; explicitlySelected: boolean }
export function guidanceExamples({ capabilities, scene, pair = null }: {
  capabilities: readonly { id: string; available: boolean }[];
  scene: GuidanceScene;
  pair?: GuidancePair | null;
}): AskExample[] {
  const available = new Set(capabilities.filter(c => c.available).map(c => c.id));
  const result: AskExample[] = [];
  if (available.has('camera.viewpoint')) {
    for (const v of (scene.viewpoints?.items ?? []).filter(v => v.source === 'catalog-viewpoint').slice(0, 2)) {
      result.push({ kind: 'show', label: `Show ${v.name}`, prompt: `Show the authored viewpoint ${JSON.stringify(v.name)} and explain what is actually visible.`,
        evidence: 'Authored view · resulting visibility unverified' });
    }
  }
  const imagery = scene.focusImagery;
  if (available.has('surface.getImagery') && imagery && imagery.total > 0) {
    result.push({ kind: 'inspect', label: `Inspect imagery on ${imagery.body}`, prompt: `What imagery is configured on ${JSON.stringify(imagery.body)}, and what is its current loading status? Distinguish configuration from verified coverage.`,
      evidence: `${imagery.total} configured layers · current-view coverage not established` });
  }
  if (pair?.explicitlySelected && pair.positionAvailable === true && pair.observer !== pair.target && available.has('profiles.upsertProfile') && available.has('profiles.sampleProfileData')) {
    result.push({ kind: 'explore', label: `Explore ${pair.observer}–${pair.target} distance`,
      prompt: `Show how the center distance between ${JSON.stringify(pair.observer)} and ${JSON.stringify(pair.target)} changes over the visible timeline. Report sampling limits and gaps.`,
      evidence: 'Calculation available · positions available now; interval coverage not certified. Center distance is not clearance.' });
  }
  return result.slice(0, 5);
}
