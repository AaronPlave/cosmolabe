/** The host adapter for Event Finder's existing configuration, solver and selection. */
import type { ViewerControl, ScriptEventSearch, ScriptEventQuery, ScriptEventQueryInfo, ScriptEventReference, ScriptEventVisualization, ScriptEventFocusReceipt, ScriptReadinessRequest, ScriptReadiness } from '@cosmolabe/control';
import { builtinEventKinds, resolveEventQuery, windowOutsideCoverage } from '@cosmolabe/core';
import { analysis, analysisContext, createConfiguredEventQuery, updateConfiguredEventQuery, visibleTimelineEvents, currentEventResultRun } from './analysis.svelte';
import { configuredEventQueries, ef, openConfiguredQuery, removeConfiguredQuery, runSearch, cancelSearch, selectEvent, selectEventForInspection, clearSelection, eventSearchGeneration, setConfiguredQueryEnabled, setConfiguredQueryVisible, inspectEventQuery, recordEventSearchOutcome } from './event-finder.svelte';
import { validateEventLinkState } from './event-link-state';
import { getSceneUniverse, getRenderer, sceneId, onViewerEvent, emit, vs } from './viewer-state.svelte';
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function guard(expected?: number) {
  if (!getSceneUniverse()) throw new Error('No scene is loaded');
  if (expected !== undefined && expected !== sceneId()) throw new Error('The scene changed since this was read');
  if (ef.restoring) throw new Error('A view restore owns Event Finder');
}
export function snapshotEventQueries(): ScriptEventQuery[] {
  return configuredEventQueries().map(item => ({ id: item.id, label: item.label, enabled: item.enabled,
    visible: item.visible, query: copy(resolveEventQuery(item, analysisContext())) }));
}
export function getEventSearch(): ScriptEventSearch {
  const status = (ef.configuredId ? ef.searchOutcomes[ef.configuredId]?.status : undefined) ?? (ef.running ? 'running' : ef.fault ? 'failed' : ef.searched ? 'complete' : 'idle');
  return { scene: getSceneUniverse() ? sceneId() : null, query: ef.configuredId,
    status, progress: status === 'running' ? ef.progress?.fraction ?? null : null,
    error: ef.fault ? { code: ef.fault.code, message: ef.fault.message } : null,
    selected: ef.selectedId && ef.selectedQueryId ? { query: ef.selectedQueryId, id: ef.selectedId } : null };
}
function queryInfo(id: string, expected?: number): ScriptEventQueryInfo {
  const empty = { definition: null, coverage: null, provenance: null, error: null };
  if (!getSceneUniverse() || (expected !== undefined && expected !== sceneId())) return { ...empty, status: 'scene-reloaded' };
  const definition = snapshotEventQueries().find(q => q.id === id);
  if (!definition) return { ...empty, status: 'missing-query' };
  const inspected = inspectEventQuery(definition.query);
  const missingCoverage = inspected.unavailable?.code === 'unavailable' && vs.kernelCount > 0 && inspected.coverage
    && (inspected.coverage.status === 'none' || inspected.coverage.status === 'available' && windowOutsideCoverage(definition.query.window, inspected.coverage.windows).length > 0);
  return { status: inspected.unavailable || !definition.enabled ? 'unavailable' : 'available', definition,
    coverage: copy(inspected.coverage), error: inspected.unavailable ? { code: missingCoverage ? 'missing-coverage' : inspected.unavailable.code, message: inspected.unavailable.message } : !definition.enabled ? { code: 'disabled', message: 'Query is disabled' } : null,
    provenance: { source: 'loaded-spice-kernels', kernelRevision: vs.kernelRevision, kernelCount: vs.kernelCount,
      contextFrame: analysis.reference.frame ?? 'J2000', calculationFrames: inspected.frames,
      timeUnit: 'ET seconds past J2000', stepUnit: 's', abcorr: definition.query.abcorr ?? 'NONE',
      limitations: ['Results apply only to the loaded kernel set and declared window. Search step limits completeness.',
        'Context frame is analysis metadata; scalar range is frame independent. Calculation frames are declared by the event kind.',
        '3D event geometry uses rendered trajectories/positions; it is explanatory, not a second GF calculation.'] } };
}
const currentRun = currentEventResultRun;
function reference(query: string, id: string): ScriptEventReference | null {
  const run = currentRun(query);
  return run ? { scene: run.scene, query, id, revision: run.revision } : null;
}
export function getEventVisualization(): ScriptEventVisualization {
  const selected = ef.selectedQueryId && ef.selectedId ? reference(ef.selectedQueryId, ef.selectedId) : null;
  const inResults = !!selected && analysisContext().eventResults.some(e => e.queryId === selected.query && e.id === selected.id);
  const inLane = !!selected && visibleTimelineEvents().some(e => e.queryId === selected.query && e.id === selected.id);
  const renderer = getRenderer();
  const native = renderer?.getEventVisualization?.() ?? null;
  const drawn = native ? { ...native, occultationVisible: native.occultationVisible && ef.activeId === selected?.id && ef.activeQueryId === selected?.query } : null;
  const et = renderer?.timeController.et ?? vs.et;
  const limitations = ['Draw-enabled glyphs/spans do not guarantee unoccluded pixels or calibrated geometry. No camera framing is applied.'];
  if (!renderer) limitations.push('No renderer is attached.');
  if (ef.selectedId && !selected) limitations.push('Selection has no current computed result provenance.');
  if (!inLane) limitations.push('Selected result is not in a visible timeline lane.');
  if (!drawn || drawn.observedEt !== et) limitations.push('Event visualization has not been observed at the current epoch.');
  if (drawn && !drawn.visibleGlyphs && !drawn.visibleSpans && !drawn.occultationVisible) limitations.push('No selected event marker/span/geometry is draw-enabled; trajectory availability, visibility and view can limit it.');
  const observed = inResults && inLane && drawn?.observedEt === et && drawn.selected?.query === selected?.query && drawn.selected?.id === selected?.id
    && !!(drawn.visibleGlyphs || drawn.visibleSpans || drawn.occultationVisible);
  return { scene: getSceneUniverse() ? sceneId() : null, selected, et, playing: renderer?.timeController.playing ?? vs.playing,
    selectedObject: vs.selectedBodyName, highlightedBodies: [...vs.highlightedBodies],
    timeline: { min: vs.scrubMin, max: vs.scrubMax, selectedInResults: inResults, selectedInVisibleLane: inLane },
    renderer: drawn, status: observed ? 'observed' : 'partial', limitations };
}
/** Shared capture predicate: reads native observations, never seeks or starts a search. */
export function validEventReference(ref: ScriptEventReference): boolean {
  return !!ref && Number.isInteger(ref.scene) && Number.isInteger(ref.revision) && ref.revision > 0
    && typeof ref.query === 'string' && !!ref.query && ref.query.length <= 512
    && typeof ref.id === 'string' && !!ref.id && ref.id.length <= 512
    && Object.keys(ref).every(key => ['scene', 'query', 'id', 'revision'].includes(key));
}
export function getEventReadiness(request: Extract<ScriptReadinessRequest, { kind: 'event' }>): ScriptReadiness {
  const observation = getEventVisualization(), ref = request.reference;
  const result = (status: ScriptReadiness['status'], missing: string[]): ScriptReadiness => ({
    scene: observation.scene, request, status, missing,
    limitations: [...observation.limitations, 'Readiness requires the exact selected run reference and requested epoch in a visible timeline lane, observed by a native render pass. Timeline policy permits absent explanatory geometry; native-draw additionally requires a draw-enabled glyph, span or active geometry. No unoccluded-pixels guarantee.'],
  });
  if (ref.scene !== observation.scene) return result('stale', ['The result belongs to another scene.']);
  const run = currentRun(ref.query);
  if (!run || run.revision !== ref.revision) return result('stale', ['The query/result run is no longer current.']);
  if (!getRenderer()?.getEventVisualization) return result('unavailable', ['Native event observation is unsupported.']);
  if (ef.restoring) return result('unavailable', ['A view restore owns Event Finder.']);
  if (!analysisContext().eventResults.some(e => e.queryId === ref.query && e.id === ref.id)) return result('unavailable', ['The result is unavailable.']);
  if (!observation.selected || observation.selected.query !== ref.query || observation.selected.id !== ref.id || observation.selected.revision !== ref.revision)
    return result('stale', ['The selected event was changed.']);
  if (observation.et !== request.et || observation.playing) return result('stale', ['The epoch changed or playback is active. Freeze time before capture.']);
  const missing: string[] = [];
  if (!observation.timeline.selectedInVisibleLane) missing.push('The selected event is not in a visible timeline lane.');
  const drawn = observation.renderer;
  if (drawn?.observedEt !== request.et || drawn.selected?.query !== ref.query || drawn.selected?.id !== ref.id)
    missing.push('The selected event has not been observed at the requested epoch and current camera.');
  if (request.policy === 'native-draw' && !drawn?.visibleGlyphs && !drawn?.visibleSpans && !drawn?.occultationVisible)
    missing.push('No selected explanatory geometry is draw-enabled.');
  return result(missing.length ? 'partial' : 'ready', missing);
}
export const eventControl: Pick<Required<ViewerControl>, 'getEventSearchOptions' | 'openEventQuery' | 'listEventQueries' | 'upsertEventQuery' | 'removeEventQuery' | 'getEventSearch' | 'runEventQuery' | 'cancelEventQuery' | 'listEventResults' | 'selectEventResult' | 'getEventQueryInfo' | 'getEventResultPage' | 'getEventVisualization' | 'focusEventResult'> = {
  getEventSearchOptions: (input = {}) => {
    guard();
    const kinds = builtinEventKinds().list();
    const context = analysisContext(), kind = kinds.find(k => k.kind === input.kind);
    const abcorr = input.abcorr ?? kind?.defaultAbcorr ?? 'NONE';
    const inspected = kind && input.bodies ? inspectEventQuery({ id: 'coverage', kind: kind.kind, bodies: input.bodies, abcorr, window: context.window }) : null;
    const coverage = inspected?.coverage ?? null;
    // A declared catalog window is not proof of kernel coverage. Suggest only
    // an assessed overlap; callers retain exact/approximate coverage caveats.
    const overlaps = coverage?.windows.map(w => ({ start: Math.max(w.start, context.window.start), end: Math.min(w.end, context.window.end) })).filter(w => w.end > w.start) ?? [];
    const suggestedWindow = overlaps.find(w => w.start <= context.currentTime && w.end >= context.currentTime) ?? overlaps.sort((a,b) => (b.end-b.start)-(a.end-a.start))[0] ?? null;
    return { kinds: kinds.map(k => ({ kind: k.kind, label: k.label, roles: k.roles.map(r => ({ role: r.role, required: r.required })), params: k.params ?? [], step: k.defaultStep, abcorr: k.defaultAbcorr ?? 'NONE' })),
      catalogWindow: context.window, coverage: copy(coverage), suggestedWindow,
      error: input.kind && !kind ? { code: 'unknown-kind' } : inspected?.unavailable ? { code: inspected.unavailable.code } : null };
  },
  listEventQueries: () => copy(configuredEventQueries()), getEventSearch, getEventVisualization,
  getEventQueryInfo: (id, opts) => queryInfo(id, opts?.scene),
  getEventResultPage: (id, opts) => {
    const query = queryInfo(id, opts?.scene);
    const offset = opts?.offset ?? 0, limit = opts?.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid result page');
    const empty = { total: 0, offset, nextOffset: null, items: [], query };
    if (query.status === 'missing-query' || query.status === 'scene-reloaded') return { ...empty, status: query.status };
    if (ef.configuredId === id && ef.running) return { ...empty, status: 'searching' };
    if (ef.configuredId === id && ef.fault) return { ...empty, status: 'failed' };
    const run = currentRun(id);
    if (!run) return { ...empty, status: analysis.eventResultRuns[id]?.complete ? 'stale-result' : 'not-searched' };
    const events = analysis.eventResults[id] ?? [];
    return { ...empty, status: events.length ? 'ready' : 'no-results', total: events.length,
      nextOffset: offset + limit < events.length ? offset + limit : null,
      items: events.slice(offset, offset + limit).map(event => ({ reference: reference(id, event.id)!, event: copy(event) })) };
  },
  focusEventResult: (ref, anchor = 'inspect', opts) => {
    const result = (status: ScriptEventFocusReceipt['status']): ScriptEventFocusReceipt => ({ status, reference: ref, anchor, observation: getEventVisualization() });
    if (!validEventReference(ref) || !['inspect', 'start', 'middle', 'end'].includes(anchor)) return result('invalid-reference');
    if (opts?.signal?.aborted) return result('cancelled');
    if (!getSceneUniverse() || ref.scene !== sceneId() || (opts?.scene !== undefined && opts.scene !== sceneId())) return result('scene-reloaded');
    if (ef.restoring) return result('unavailable');
    const query = configuredEventQueries().find(q => q.id === ref.query);
    if (!query) return result('missing-query');
    if (!query.enabled) return result('unavailable');
    const run = currentRun(ref.query);
    if (!run || run.revision !== ref.revision) return result('stale-result');
    const event = analysisContext().eventResults.find(e => e.queryId === ref.query && e.id === ref.id);
    if (!event) return result('missing-result');
    // Entirely synchronous: inspection and optional seek use the UI action.
    // No later continuation can reassert time/camera after manual takeover.
    if (anchor === 'inspect') selectEventForInspection(event); else selectEvent(event, anchor);
    return result(getEventVisualization().status);
  },
  upsertEventQuery: (input, opts) => {
    guard(opts?.scene);
    if (!input || JSON.stringify(input).length > 32768 || typeof input.id !== 'string' || !input.id || input.id.length > 512 || Object.hasOwn(Object.prototype, input.id)) throw new Error('Invalid bounded query definition');
    // The same registry and parameter validator used by versioned view links.
    const validated = validateEventLinkState({ version: 1, current: 0, queries: [{ ...input, query: { ...input.query, id: input.id }, windowMode: 'explicit', searched: false }] }).queries[0];
    if ((validated.query.window.end - validated.query.window.start) / validated.query.step! > 1e6) throw new Error('Event query exceeds the bounded work budget');
    for (const body of Object.values(validated.query.bodies)) if (!getSceneUniverse()!.getBody(body!)) throw new Error(`Event body ${body} is unavailable in this catalog`);
    const { id: _id, ...query } = validated.query;
    if (analysis.items.some(i => i.id === input.id && i.type !== 'event-query')) throw new Error('ID belongs to another analysis definition');
    const existing = configuredEventQueries().find(i => i.id === input.id);
    if (existing) {
      // Opening before edits cancels an older run and invalidates its result ownership.
      openConfiguredQuery(existing.id);
      updateConfiguredEventQuery(existing.id, query, validated.label, 'explicit');
      delete analysis.eventResults[existing.id];
      delete ef.searchOutcomes[existing.id];
      delete analysis.eventResultRuns[existing.id];
      if (ef.selectedQueryId === existing.id) clearSelection();
    } else createConfiguredEventQuery(query, validated.label, 'explicit', input.id);
    openConfiguredQuery(input.id);
    setConfiguredQueryEnabled(input.id, validated.enabled); setConfiguredQueryVisible(input.id, validated.visible);
    emit('events', {}); return true;
  },
  openEventQuery: (id, opts) => {
    guard(opts?.scene); if (!configuredEventQueries().some(q => q.id === id)) return false;
    openConfiguredQuery(id); emit('events', {}); return true;
  },
  removeEventQuery: (id, opts) => {
    guard(opts?.scene); if (!configuredEventQueries().some(q => q.id === id)) return false;
    removeConfiguredQuery(id); emit('events', {}); return true;
  },
  cancelEventQuery: opts => { guard(opts?.scene); cancelSearch(); return true; },
  runEventQuery: async (id, opts = {}) => {
    guard(opts.scene);
    if (!configuredEventQueries().some(q => q.id === id && q.enabled)) throw new Error('Event query is missing or disabled');
    const timeout = opts.timeoutMs ?? 30000;
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120000) throw new Error('Search timeout must be 0–120000 ms');
    const scene = sceneId(), renderer = getRenderer(), kernels = vs.kernelRevision;
    let generation = -1;
    const receipt = (status: ScriptEventSearch['status']): ScriptEventSearch => {
      if (scene === sceneId() && renderer === getRenderer() && kernels === vs.kernelRevision) recordEventSearchOutcome(id, generation, status);
      return { ...getEventSearch(), scene, query: id, status, progress: null, error: ef.configuredId === id && ef.fault ? { code: ef.fault.code, message: ef.fault.message } : null };
    };
    if (opts.signal?.aborted) return receipt('cancelled');
    openConfiguredQuery(id);
    let outcome: ScriptEventSearch['status'] | undefined;
    let stopped!: () => void;
    const stopping = new Promise<void>(resolve => { stopped = resolve; });
    const stop = (status: ScriptEventSearch['status']) => {
      outcome ??= status;
      if (generation === eventSearchGeneration()) cancelSearch();
      stopped();
    };
    const abort = () => stop('cancelled');
    const stale = () => stop('stale');
    const offLoad = onViewerEvent('load', stale), offUnload = onViewerEvent('unload', stale);
    opts.signal?.addEventListener('abort', abort);
    const timer = setTimeout(() => stop('timed-out'), timeout);
    try {
      // runSearch emits its running notification synchronously. Own the
      // expected generation before an observer can abort from that callback.
      generation = eventSearchGeneration() + 1;
      const run = runSearch();
      if (!outcome) generation = eventSearchGeneration();
      await Promise.race([run, stopping]);
      if (scene !== sceneId() || renderer !== getRenderer() || kernels !== vs.kernelRevision) return receipt('stale');
      if (generation !== eventSearchGeneration()) return receipt(outcome ?? 'cancelled');
      return receipt(outcome ?? (ef.fault ? 'failed' : ef.searched ? 'complete' : 'cancelled'));
    } catch (error) {
      return { ...receipt(outcome ?? 'failed'), error: { code: 'search-failed', message: error instanceof Error ? error.message : 'Event search failed' } };
    } finally {
      clearTimeout(timer); offLoad(); offUnload(); opts.signal?.removeEventListener('abort', abort);
    }
  },
  listEventResults: (query, opts) => {
    guard(opts?.scene);
    if (!configuredEventQueries().some(q => q.id === query)) throw new Error('No such event query');
    const offset = opts?.offset ?? 0, limit = opts?.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid result page');
    const results = currentRun(query) ? analysis.eventResults[query] ?? [] : [];
    return { total: results.length, items: copy(results.slice(offset, offset + limit)) };
  },
  selectEventResult: (query, id, anchor = 'inspect', opts) => {
    guard(opts?.scene);
    if (!currentRun(query)) return false;
    const event = analysisContext().eventResults.find(e => e.queryId === query && e.id === id);
    if (!event) return false;
    if (anchor === 'inspect') selectEventForInspection(event);
    else if (['start', 'middle', 'end'].includes(anchor)) selectEvent(event, anchor);
    else throw new Error('Unknown event boundary');
    return true;
  },
};
