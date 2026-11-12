/** Assessment-only prototype for #379; no model calls or runtime UI integration. */
export function guidanceExamples({ capabilities, scene, pair = null }) {
  const available = new Set(capabilities.filter(c => c.available).map(c => c.id));
  const result = [];
  if (available.has('camera.viewpoint')) {
    for (const v of (scene.viewpoints?.items ?? []).filter(v => v.source === 'catalog-viewpoint').slice(0, 2)) {
      result.push({ kind: 'show', label: `Show ${v.name}`, prompt: `Show the authored viewpoint ${JSON.stringify(v.name)} and explain what is actually visible.`,
        evidence: 'Authored viewpoint available; resulting view not verified.' });
    }
  }
  const imagery = scene.focusImagery;
  if (available.has('surface.getImagery') && imagery?.total > 0) {
    result.push({ kind: 'inspect', label: `Inspect imagery on ${imagery.body}`, prompt: `What imagery is configured on ${JSON.stringify(imagery.body)}, and what is its current loading status? Distinguish configuration from verified coverage.`,
      evidence: `${imagery.total} configured layers; current-view coverage not established.` });
  }
  if (pair?.positionAvailable === true && available.has('profiles.upsertProfile') && available.has('profiles.sampleProfileData')) {
    result.push({ kind: 'explore', label: `Compare ${pair.observer}–${pair.target} center distance`,
      prompt: `Show how the center distance between ${JSON.stringify(pair.observer)} and ${JSON.stringify(pair.target)} changes over the visible timeline. Report sampling limits and gaps.`,
      evidence: 'Positions available at the inspected epoch; interval coverage not certified. Center distance is not clearance.' });
  }
  // Do not pad to a promised count with unsupported science or generic operations.
  return result.slice(0, 5);
}
