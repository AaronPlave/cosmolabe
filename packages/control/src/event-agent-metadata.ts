/** Allowlisted Event Finder transport. Solver fault text and arbitrary parameters stay local. */
import { agentMetadata } from './agent-metadata.js';
import { builtinEventKinds, EVENT_ROLES, etToDate } from '@cosmolabe/core';
import type { ScriptEventQueryInfo, ScriptEventResultPage, ScriptEventVisualization } from './contracts.js';
const kinds = builtinEventKinds();
const corrections = ['NONE', 'LT', 'LT+S', 'CN', 'CN+S', 'XLT', 'XLT+S', 'XCN', 'XCN+S'];
export function eventQueryMetadata(info: ScriptEventQueryInfo, publicText: (s: string | null | undefined) => string | null) {
  const q = info.definition?.query, kind = q && kinds.get(q.kind);
  const params = Object.fromEntries((kind?.params ?? []).flatMap(p => {
    const v = q?.params?.[p.key];
    return p.kind === 'number' && typeof v === 'number' && Number.isFinite(v) || p.kind === 'boolean' && typeof v === 'boolean'
      || p.kind === 'choice' && p.options.some(o => o.value === v) ? [[p.key, v]] : [];
  }));
  return { status: info.status, definition: q && kind ? { id: q.id, kind: kind.kind, enabled: info.definition!.enabled, visible: info.definition!.visible,
    bodies: Object.fromEntries(EVENT_ROLES.flatMap(role => q.bodies[role] ? [[role, q.bodies[role]]] : [])),
    window: { start: q.window.start, end: q.window.end }, windowUtc: { start: etToDate(q.window.start).toISOString(), end: etToDate(q.window.end).toISOString() }, step: q.step, params,
    abcorr: corrections.includes(q.abcorr ?? '') ? q.abcorr : null } : null,
    coverage: info.coverage ? { status: info.coverage.status, exact: info.coverage.exact, windows: info.coverage.windows.map(w => ({ start: w.start, end: w.end })),
      problems: info.coverage.problems.length, caveats: info.coverage.caveats.length } : null,
    error: info.error ? { code: ['unknown-kind', 'missing-body', 'missing-coverage', 'unavailable', 'disabled'].includes(info.error.code) ? info.error.code : 'unavailable' } : null,
    provenance: info.provenance ? { source: info.provenance.source, kernelRevision: info.provenance.kernelRevision, kernelCount: info.provenance.kernelCount,
      contextFrame: publicText(info.provenance.contextFrame), calculationFrames: info.provenance.calculationFrames.map(f => publicText(f)),
      timeUnit: 'ET seconds past J2000', stepUnit: 's', abcorr: corrections.includes(info.provenance.abcorr) ? info.provenance.abcorr : null,
      limitations: info.provenance.source === 'authoritative-trajectories' ? 'Authoritative trajectories and physical terrain; sampled and locally refined candidates, not certified global extrema. Incomplete searches cannot establish an overall winner. Unapproved source and frame text is withheld.' : 'Loaded kernels and window only; step limits completeness. Rendered geometry is explanatory. Unapproved frame names are withheld.' } : null };
}
export function eventPageMetadata(page: ScriptEventResultPage, publicText: (s: string | null | undefined) => string | null) {
  return { ...(page.ranking ? { ranking: page.ranking } : {}), status: page.status, total: page.total, offset: page.offset, nextOffset: page.nextOffset,
    query: eventQueryMetadata(page.query, publicText), items: page.items.slice(0, 100).map(({ reference: r, event: e }) => ({
      reference: { scene: r.scene, query: r.query, id: r.id, revision: r.revision },
      kind: kinds.get(e.kind)?.kind ?? null, temporality: e.temporality,
      ...(e.temporality === 'instant' ? { et: e.et, utc: etToDate(e.et).toISOString() } : { start: e.start, end: e.end, startUtc: etToDate(e.start).toISOString(), endUtc: etToDate(e.end).toISOString() }),
      bodies: Object.fromEntries(EVENT_ROLES.flatMap(role => e.bodies[role] ? [[role, e.bodies[role]]] : [])),
      ...(e.trajectoryAnalysis ? { trajectoryAnalysis: agentMetadata({ publicValue: value => publicText(value) === value }).trajectoryExtremum(e.trajectoryAnalysis) } : {}),
      metrics: (e.metrics ?? []).filter(m => ['range', 'altitude', 'duration', 'radialHeightAboveReferenceSphere', 'heightAboveReferenceEllipsoid', 'heightAbovePhysicalTerrain'].includes(m.key) && ['km', 's'].includes(m.unit ?? '') && Number.isFinite(m.value))
        .map(m => ({ key: m.key, value: m.value, unit: m.unit })),
    })) };
}
export function eventVisualizationMetadata(v: ScriptEventVisualization) {
  const r = v.renderer, s = v.selected;
  return { ...(v.presentation ? { presentation: v.presentation } : {}), scene: v.scene, status: v.status, selected: s ? { scene: s.scene, query: s.query, id: s.id, revision: s.revision } : null,
    et: v.et, playing: v.playing, selectedObject: v.selectedObject, highlightedBodies: v.highlightedBodies.slice(0, 16),
    timeline: { min: v.timeline.min, max: v.timeline.max, selectedInResults: v.timeline.selectedInResults, selectedInVisibleLane: v.timeline.selectedInVisibleLane },
    renderer: r ? { observedEt: r.observedEt, selected: r.selected ? { query: r.selected.query, id: r.selected.id } : null,
      markerGroups: r.markerGroups, visibleGlyphs: r.visibleGlyphs, visibleSpans: r.visibleSpans, occultationVisible: r.occultationVisible } : null,
    limitations: 'Counts describe draw-enabled objects from an observed render pass, not unoccluded pixels. Presentation reports actual projected centers, not occlusion or visible pixels. Partial means an incomplete observation.' };
}
