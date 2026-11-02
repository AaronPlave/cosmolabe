/** The host adapter for Event Finder's existing configuration, solver and selection. */
import type { ViewerControl, ScriptEventSearch, ScriptEventQuery } from '@cosmolabe/control';
import { resolveEventQuery } from '@cosmolabe/core';
import { analysis, analysisContext, createConfiguredEventQuery, updateConfiguredEventQuery } from './analysis.svelte';
import { configuredEventQueries, ef, openConfiguredQuery, removeConfiguredQuery, runSearch, cancelSearch, selectEvent, selectEventForInspection, clearSelection, eventSearchGeneration, setConfiguredQueryEnabled, setConfiguredQueryVisible } from './event-finder.svelte';
import { validateEventLinkState } from './event-link-state';
import { getSceneUniverse, getRenderer, sceneId, onViewerEvent, emit } from './viewer-state.svelte';
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
  return { scene: getSceneUniverse() ? sceneId() : null, query: ef.configuredId,
    status: ef.running ? 'running' : ef.fault ? 'failed' : ef.searched ? 'complete' : 'idle',
    progress: ef.progress?.fraction ?? null, error: ef.fault ? { code: ef.fault.code, message: ef.fault.message } : null,
    selected: ef.selectedId && ef.selectedQueryId ? { query: ef.selectedQueryId, id: ef.selectedId } : null };
}
export const eventControl: Pick<Required<ViewerControl>, 'openEventQuery' | 'listEventQueries' | 'upsertEventQuery' | 'removeEventQuery' | 'getEventSearch' | 'runEventQuery' | 'cancelEventQuery' | 'listEventResults' | 'selectEventResult'> = {
  listEventQueries: () => copy(configuredEventQueries()), getEventSearch,
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
    const scene = sceneId(), renderer = getRenderer();
    const receipt = (status: ScriptEventSearch['status']): ScriptEventSearch => ({ ...getEventSearch(), scene, query: id, status });
    if (opts.signal?.aborted) return receipt('cancelled');
    openConfiguredQuery(id);
    let outcome: ScriptEventSearch['status'] | undefined;
    let generation = -1;
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
      const run = runSearch(); generation = eventSearchGeneration();
      await Promise.race([run, stopping]);
      if (scene !== sceneId() || renderer !== getRenderer()) return receipt('stale');
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
    const results = analysis.eventResults[query] ?? [];
    return { total: results.length, items: copy(results.slice(offset, offset + limit)) };
  },
  selectEventResult: (query, id, anchor = 'inspect', opts) => {
    guard(opts?.scene);
    const event = analysisContext().eventResults.find(e => e.queryId === query && e.id === id);
    if (!event) return false;
    if (anchor === 'inspect') selectEventForInspection(event);
    else if (['start', 'middle', 'end'].includes(anchor)) selectEvent(event, anchor);
    else throw new Error('Unknown event boundary');
    return true;
  },
};
