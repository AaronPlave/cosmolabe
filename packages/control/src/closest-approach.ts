import type { ScriptCancelSignal, ScriptClosestApproachRequest, ScriptClosestApproachResult, ScriptSceneOptions, ViewerControl } from './contracts.js';
import { etFromCalendarString } from '@cosmolabe/core';
import { evaluate } from './outcome.js';

let sequence = 0;
export const missingFrameDependency = (message: string) => /not a recognized id-code for a reference frame|SPICE\((?:UNKNOWNFRAME|NOFRAME)\)/i.test(message);
/** One bounded analysis built from the public controls. Each search retains native query/run provenance. */
export async function findClosestApproach(host: ViewerControl, request: ScriptClosestApproachRequest, opts: ScriptSceneOptions & { signal?: ScriptCancelSignal } = {}, framePair?: (target: string, observer: string) => boolean): Promise<ScriptClosestApproachResult> {
  const id = `approach-${Date.now().toString(36)}-${++sequence}`;
  const result: ScriptClosestApproachResult = { query: `${id}-0`, status: 'unavailable', reason: null, computedEventVerified: false, windows: [], stepSeconds: null, candidates: 0, result: null, presentation: null, samples: null, sampledView: null,
    limitations: ['Loaded kernels and assessed catalog overlap only. Default Event Finder step limits completeness; this is not an all-time minimum, physical clearance or touchdown.'] };
  const stop = (reason: ScriptClosestApproachResult['reason'], status: ScriptClosestApproachResult['status'] = 'unavailable') => ({ ...result, result: reason && reason !== 'presentation-incomplete' ? null : result.result, status, reason });
  if (!request || !host.listObjects().includes(request.observer) || !host.listObjects().includes(request.target) || request.observer === request.target) return stop('missing-coverage');
  const scene = host.getScene?.()?.id;
  if (opts.scene !== undefined && opts.scene !== scene) return stop('cancelled', 'interrupted');
  if (!host.getEventSearchOptions || !host.upsertEventQuery || !host.runEventQuery || !host.getEventResultPage || !host.presentEventResult) return stop('search-failed');
  const bodies = { observer: request.observer, target: request.target };
  const options = host.getEventSearchOptions({ kind: 'closest-approach', bodies });
  const kind = options.kinds.find(k => k.kind === 'closest-approach');
  const explicit = request.windowMode === 'interval';
  if (!['coverage','interval'].includes(request.windowMode) || !explicit && (request.start !== undefined || request.end !== undefined)) return stop('invalid-window');
  const epoch = (value: number | string | undefined) => typeof value === 'number' ? value : typeof value === 'string' ? etFromCalendarString(value) : NaN;
  let scope: { start: number; end: number };
  try { scope = explicit ? { start: epoch(request.start), end: epoch(request.end) } : options.catalogWindow; }
  catch { return stop('invalid-window'); }
  if (![scope.start, scope.end].every(Number.isFinite) || scope.end <= scope.start) return stop('invalid-window');
  if (!kind || !Number.isFinite(kind.step) || kind.step <= 0) return stop('search-failed');
  const coverage = options.coverage;
  if (!coverage || coverage.status === 'unknown') return stop('coverage-unassessed');
  if (coverage.status === 'none') return stop('missing-coverage');
  const windows = coverage.windows.map(w => ({ start: Math.max(w.start, scope.start), end: Math.min(w.end, scope.end) })).filter(w => w.end > w.start).sort((a,b) => a.start-b.start);
  // An explicit interval is never silently clipped or bridged across a gap.
  if (!windows.length || explicit && !windows.some(w => w.start === scope.start && w.end === scope.end)) return stop('missing-coverage');
  result.windows = explicit ? [scope] : windows;
  result.stepSeconds = kind.step;
  if (windows.length > 4 || result.windows.reduce((n,w) => n + (w.end-w.start)/kind.step, 0) > 1e6) return stop('work-budget');
  if (!coverage.exact) result.limitations = [...result.limitations, 'Coverage bounds are approximate; solver failures remain authoritative.'];
  let interrupted = false, writing = false;
  const off = [host.on('cameraInput', () => { interrupted = true; }), host.on('time', e => { if (!writing && e.cause !== 'playback') interrupted = true; }), host.on('playback', () => { if (!writing) interrupted = true; }), host.on('load', () => { interrupted = true; })];
  const cancelled = () => interrupted || opts.signal?.aborted || host.getScene?.()?.id !== scene;
  const write = <T>(fn: () => T): T => { writing = true; try { return fn(); } finally { writing = false; } };
  const deadline = Date.now() + 30000;
  try {
    for (const [index, window] of result.windows.entries()) {
      if (cancelled()) return stop('cancelled', 'interrupted');
      const query = `${id}-${index}`;
      const definition = { id: query, kind: 'closest-approach', bodies, window, step: kind.step, abcorr: kind.abcorr, params: { scope: 'local' } };
      if (!write(() => host.upsertEventQuery!({ id: query, label: 'Closest approach', enabled: true, visible: true, query: definition }, { scene }))) return stop('search-failed');
      const availability = host.getEventQueryInfo?.(query, { scene });
      if (availability?.error?.code === 'missing-coverage') return stop('missing-coverage');
      const remaining = deadline - Date.now();
      if (remaining <= 0) return stop('work-budget');
      const run = await host.runEventQuery(query, { scene, signal: opts.signal, timeoutMs: remaining });
      if (cancelled()) return stop('cancelled', 'interrupted');
      if (run.status !== 'complete') {
        if (!missingFrameDependency(run.error?.message ?? '')) return stop(run.status === 'timed-out' ? 'work-budget' : 'search-failed');
        // A distinct qualified alternative, within one contiguous interval; never a computed-event success.
        if (result.windows.length === 1 && host.upsertProfile && host.sampleProfileData) {
          const profile = `${id}-sample`;
          if (!write(() => host.upsertProfile!({ id: profile, enabled: true, visible: true, profile: { quantity: 'range', bodies } }, { scene }))) return stop('missing-dependency');
          result.samples = host.sampleProfileData(profile, { ...window, count: 32 }, { scene });
          const minimum = result.samples.minimum;
          if (cancelled()) return stop('cancelled', 'interrupted');
          if (minimum && Number.isFinite(minimum.value)) {
            if (request.present !== false) {
              write(() => { host.setPlaying(false); host.setTime({ kind: 'et', et: minimum.et }); });
              if (host.getTime() !== minimum.et || host.isPlaying()) return stop('presentation-incomplete');
              if (framePair) {
                const framed = write(() => framePair(request.target, request.observer));
                if (cancelled()) return stop('cancelled', 'interrupted');
                result.sampledView = host.getViewComposition?.([request.target, request.observer]) ?? null;
                if (!framed) result.limitations = [...result.limitations, 'Sampled epoch selected, but pair framing is unavailable.'];
              }
            }
            return stop('missing-dependency', 'sampled');
          }
        }
        return stop('missing-dependency');
      }
      const page = host.getEventResultPage(query, { scene, order: 'range-ascending', limit: 1 });
      if (!['ready','no-results'].includes(page.status) || page.nextOffset !== null && !page.ranking) return stop('search-failed');
      result.candidates += page.total;
      const range = (p: typeof page | null) => p?.items[0]?.event.metrics?.find(m => m.key === 'range' && m.unit === 'km')?.value ?? Infinity;
      if (page.items.length && range(page) < range(result.result)) result.result = page;
    }
    if (!result.result) return stop(null, 'no-results');
    if (cancelled()) return stop('cancelled', 'interrupted');
    if (request.present !== false) {
      const ref = result.result.items[0].reference;
      result.presentation = await write(() => host.presentEventResult!(ref, 'pair', { scene, signal: opts.signal }));
      if (cancelled()) return stop('cancelled', 'interrupted');
      // The same predicates used by granular operations, including actual framing and drawing.
      result.computedEventVerified = evaluate(host, [{ p: 'eventSelected', query: ref.query, id: ref.id, pick: 'closest' }, { p: 'paused', value: true }, { p: 'eventEpoch', query: ref.query }, { p: 'eventFramed', query: ref.query, framing: 'pair' }, { p: 'eventDrawn', query: ref.query }]).status === 'met';
      if (!result.computedEventVerified) return stop('presentation-incomplete');
    }
    return { ...result, status: 'computed', reason: null };
  } catch (error) {
    if (cancelled()) return stop('cancelled', 'interrupted');
    return stop(missingFrameDependency(error instanceof Error ? error.message : '') ? 'missing-dependency' : 'search-failed');
  } finally { for (const dispose of off) dispose(); }
}
