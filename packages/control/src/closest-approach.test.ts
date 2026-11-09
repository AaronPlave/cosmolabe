import { describe, expect, it, vi } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { findClosestApproach } from './closest-approach.js';
import { createAgentTools } from './agent.js';
import { checkAnswer } from './answer-check.js';
import { adopt } from './outcome.js';
import { resultText } from './agent-loop.js';
import type { ResultFact } from './agent.js';
import type { ScriptEventQuery, ScriptEventReference, ScriptEventResultPage, ScriptEventFocusReceipt, ScriptEventSearch, ScriptProfileData, ViewerControl } from './contracts.js';

const window = { start: 0, end: 100 };
function fixture(windows = [window]) {
  const host: ViewerControl & FakeViewer = new FakeViewer();
  let current: ScriptEventQuery | null = null, selected: ScriptEventReference | null = null;
  host.getEventSearchOptions = () => ({ kinds: [{ kind: 'closest-approach', label: 'Closest', roles: [], params: [], step: 10, abcorr: 'NONE' }], catalogWindow: { start: 0, end: 300 }, coverage: { status: 'available', exact: true, windows, caveats: [], problems: [] }, suggestedWindow: windows[0], error: null });
  host.upsertEventQuery = vi.fn(d => { current = d; return true; });
  host.getEventQueryInfo = () => ({ status: 'available', definition: current, coverage: host.getEventSearchOptions!().coverage, provenance: null, error: null });
  host.getEventResultPage = vi.fn((query = 'q'): ScriptEventResultPage => ({ status: 'ready', query: host.getEventQueryInfo(), ranking: { order: 'range-ascending', compared: 2 }, total: 2, offset: 0, nextOffset: 1, items: [{ reference: { scene: 1, revision: 1, query, id: 'closest' }, event: { id: 'closest', label: 'Closest', queryId: query, kind: 'closest-approach', temporality: 'instant', et: 50, bodies: { observer: 'Cassini', target: 'Titan' }, metrics: [{ key: 'range', label: 'Range', value: 5, unit: 'km' }] } }] }));
  host.listEventResults = query => ({ total: 2, items: host.getEventResultPage!(query).items.map(i => i.event) });
  host.getEventVisualization = () => ({ scene: 1, selected, et: host.getTime(), playing: host.isPlaying(), selectedObject: null, highlightedBodies: [], timeline: { min: 0, max: 300, selectedInResults: !!selected, selectedInVisibleLane: !!selected }, renderer: selected ? { observedEt: host.getTime(), selected: { query: selected.query, id: selected.id }, markerGroups: 1, visibleGlyphs: 1, visibleSpans: 0, occultationVisible: false } : null, status: selected ? 'observed' : 'partial', presentation: { tracked: 'Titan', reference: 'Titan', participants: ['Cassini','Titan'].map(object => ({ object, ndc: [0,0,0], drawEnabled: true, inView: true })) }, limitations: [] });
  host.presentEventResult = vi.fn(async (reference: ScriptEventReference): Promise<ScriptEventFocusReceipt> => { selected = reference; host.setPlaying(false); host.setTime({ kind: 'et', et: 50 }); return { status: 'observed', reference, anchor: 'middle', observation: host.getEventVisualization() }; });
  host.findClosestApproach = (request, opts = {}) => findClosestApproach(host, request, opts);
  return host;
}
const request = { observer: 'Cassini', target: 'Titan', windowMode: 'coverage' as const };
const samples: ScriptProfileData = { scene: 1, id: 'profile', status: 'available', quantity: 'range', unit: 'km', bodies: { observer: request.observer, target: request.target }, requestedWindow: window, window, samples: [{ et: 0, utc: '2000-01-01T12:00:00.000Z', value: 9 }, { et: 100, utc: '2000-01-01T12:01:40.000Z', value: 2.47 }], missing: 0, gaps: [], minimum: { et: 100, utc: '2000-01-01T12:01:40.000Z', value: 2.47 }, maximum: { et: 0, utc: '2000-01-01T12:00:00.000Z', value: 9 }, sampling: { method: 'uniform', requestedCount: 2, maxCount: 32, stepSeconds: 100, coverage: 'not-certified', interpolation: 'none' }, limitations: [] };

describe('bounded closest-approach composition', () => {
  it('ranks the complete native set and verifies the actual result presentation', async () => {
    const host = fixture();
    const result = await findClosestApproach(host, request);
    expect(result).toMatchObject({ status: 'computed', candidates: 2, computedEventVerified: true, windows: [window], stepSeconds: 10 });
    expect(host.presentEventResult).toHaveBeenCalledOnce();
    expect(host.getTime()).toBe(50);
  });
  it('uses the requested interval even when discovery reports the wider catalog as unavailable', async () => {
    const host = fixture(), options = host.getEventSearchOptions!();
    host.getEventSearchOptions = () => ({ ...options, error: { code: 'unavailable' } });
    expect(await findClosestApproach(host, { ...request, windowMode: 'interval', start: 0, end: 100 })).toMatchObject({ status: 'computed' });
  });
  it('prevents another compound attempt for the pair, even with changed bounds', async () => {
    const host = fixture(), spy = vi.spyOn(host, 'findClosestApproach');
    const tools = createAgentTools(host, { allowAuthoring: true }), task = tools.begin();
    expect(await task.call('findClosestApproach', request)).toMatchObject({ ok: true });
    expect(await task.call('findClosestApproach', { ...request, windowMode: 'interval', start: 20, end: 80 })).toMatchObject({ ok: false, code: 'refused' });
    expect(spy).toHaveBeenCalledOnce();
    task.finish(); tools.dispose();
  });
  it('resolves UTC endpoints using the shared calendar parser and rejects omitted phase bounds', async () => {
    const host = fixture();
    expect(await findClosestApproach(host, { ...request, windowMode: 'interval', start: '2000-01-01T11:58:55.816Z', end: '2000-01-01T12:00:35.816Z' })).toMatchObject({ status: 'computed', windows: [{ start: 0, end: 100 }] });
    expect(await findClosestApproach(host, { ...request, windowMode: 'interval' })).toMatchObject({ status: 'unavailable', reason: 'invalid-window' });
  });
  it('compares all assessed windows while bounding configuration and work', async () => {
    const host = fixture([window, { start: 200, end: 300 }]);
    expect(await findClosestApproach(host, request)).toMatchObject({ status: 'computed', candidates: 4 });
    expect(host.upsertEventQuery).toHaveBeenCalledTimes(2);
    const budget = fixture(Array.from({ length: 5 }, (_,i) => ({ start: i*50, end: i*50+20 })));
    expect(await findClosestApproach(budget, request)).toMatchObject({ status: 'unavailable', reason: 'work-budget' });
    expect(budget.upsertEventQuery).not.toHaveBeenCalled();
  });
  it('distinguishes unknown coverage from evidence of absent coverage', async () => {
    const host = fixture(), options = host.getEventSearchOptions!();
    host.getEventSearchOptions = () => ({ ...options, coverage: { status: 'unknown', exact: false, windows: [], problems: [], caveats: [] } });
    expect(await findClosestApproach(host, request)).toMatchObject({ status: 'unavailable', reason: 'coverage-unassessed' });
    expect(host.upsertEventQuery).not.toHaveBeenCalled();
  });
  it('refuses an explicit interval across a coverage gap without silently clipping it', async () => {
    const host = fixture([window, { start: 200, end: 300 }]);
    expect(await findClosestApproach(host, { ...request, windowMode: 'interval', start: 50, end: 250 })).toMatchObject({ status: 'unavailable', reason: 'missing-coverage' });
    expect(host.upsertEventQuery).not.toHaveBeenCalled();
  });
  it('returns structured frame failure, labels the sampled alternative and does not certify it, and does not certify navigation', async () => {
    const host = fixture();
    host.runEventQuery = vi.fn(async (query: string): Promise<ScriptEventSearch> => ({ scene: 1, query, status: 'failed', progress: null, error: { code: 'search-failed', message: '-226000 is not a recognized id-code for a reference frame /private/secret' }, selected: null }));
    host.sampleProfileData = vi.fn(() => samples);
    const result = await findClosestApproach(host, request);
    expect(result).toMatchObject({ status: 'sampled', reason: 'missing-dependency', computedEventVerified: false, presentation: null, samples });
    expect(JSON.stringify(result)).not.toContain('/private/secret');
    expect(host.getTime()).toBe(100);
    expect(host.presentEventResult).not.toHaveBeenCalled();
  });
  it('keeps a prior selected event from satisfying a newly failed computed-event goal', async () => {
    const host = fixture();
    await findClosestApproach(host, request);
    const old = host.getEventVisualization().selected;
    host.runEventQuery = async query => ({ scene: 1, query, status: 'failed', progress: null, error: { code: 'search-failed', message: 'SPICE(UNKNOWNFRAME)' }, selected: old });
    host.sampleProfileData = () => ({ ...samples, samples: Array.from({ length: 32 }, (_,i) => ({ et: i, utc: `2000-01-01T12:00:${String(i).padStart(2,'0')}.000Z`, value: 2.47+i })) });
    const tools = createAgentTools(host, { allowAuthoring: true });
    const response = await tools.call('findClosestApproach', request);
    expect(response).toMatchObject({ ok: true, data: { status: 'sampled', computedEventVerified: false }, outcome: { report: { status: 'unmet' } } });
    expect(JSON.parse(resultText(response, 6000))).not.toHaveProperty('code', 'result-too-large');
    const bound = adopt([{ p: 'eventSelected', pick: 'closest', stated: true }], response.outcome!.expected, 'action').held;
    expect(bound[0].query).not.toBe(old!.query);
    expect(tools.verify!(bound).status).toBe('unmet');
    expect(host.getEventVisualization().selected).toEqual(old);
    tools.dispose();
  });
  it('uses the native framing adapter at the returned sampled epoch without creating an event', async () => {
    const host = fixture();
    host.runEventQuery = async query => ({ scene: 1, query, status: 'failed', progress: null, error: { code: 'search-failed', message: 'SPICE(UNKNOWNFRAME)' }, selected: null });
    host.sampleProfileData = () => samples;
    const framePair = vi.fn(() => { expect(host.getTime()).toBe(samples.minimum!.et); return true; });
    expect(await findClosestApproach(host, request, {}, framePair)).toMatchObject({ status: 'sampled', computedEventVerified: false, presentation: null, sampledView: { et: samples.minimum!.et } });
    expect(framePair).toHaveBeenCalledWith('Titan','Cassini');
    expect(host.getEventVisualization().selected).toBeNull();
  });
  it('does not sample after other failures or claim a successful partial presentation', async () => {
    const host = fixture();
    host.runEventQuery = async query => ({ scene: 1, query, status: 'failed', progress: null, error: { code: 'search-failed', message: 'bad query' }, selected: null });
    host.sampleProfileData = vi.fn(() => samples);
    expect(await findClosestApproach(host, request)).toMatchObject({ status: 'unavailable', reason: 'search-failed' });
    expect(host.sampleProfileData).not.toHaveBeenCalled();
    const partial = fixture();
    partial.presentEventResult = async reference => ({ status: 'partial', reference, anchor: 'middle', observation: partial.getEventVisualization() });
    expect(await findClosestApproach(partial, request)).toMatchObject({ status: 'unavailable', computedEventVerified: false, reason: 'presentation-incomplete' });
  });
  it.each(['camera', 'time', 'scene', 'cancel'] as const)('respects %s takeover before any presentation', async kind => {
    const host = fixture(), signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    const run = host.runEventQuery.bind(host);
    host.runEventQuery = async query => {
      if (kind === 'camera') host.emit('cameraInput', {});
      if (kind === 'time') host.emit('time', { et: 17, cause: 'viewer' });
      if (kind === 'scene') host.emit('load', { objects: [] });
      if (kind === 'cancel') signal.aborted = true;
      return run(query);
    };
    expect(await findClosestApproach(host, request, { signal })).toMatchObject({ status: 'interrupted', computedEventVerified: false });
    expect(host.presentEventResult).not.toHaveBeenCalled();
  });
  it('publishes actual event facts through the shared tool, inside the provider budget', async () => {
    const host = fixture(), tools = createAgentTools(host, { allowAuthoring: true });
    const result = await tools.call('findClosestApproach', request);
    expect(result).toMatchObject({ ok: true, data: { status: 'computed', computedEventVerified: true }, facts: expect.arrayContaining([expect.objectContaining({ kind: 'event-result', rangeKm: 5 })]) });
    expect(JSON.parse(resultText(result, 6000))).not.toHaveProperty('code', 'result-too-large');
    tools.dispose();
  });
});

describe('numeric grounding from sampled facts without computed events', () => {
  const facts: ResultFact[] = [{ kind: 'sampled-range', observer: 'A', target: 'B', startUtc: '2014-11-12T00:00:00Z', endUtc: '2014-11-13T00:00:00Z', count: 32, missing: 0, minimumKm: 2.472798, minimumUtc: '2014-11-12T15:34:03Z', minimumEt: 1, eventSearchUnavailable: true }];
  it('rejects fabricated distances, dates and precise times and accepts rounded values', () => {
    expect(checkAnswer('32 samples, 0 missing; sampled minimum 2.47 km at 2014-11-12 15:34 UTC.', facts)).toEqual([]);
    expect(checkAnswer('0 missing. Minimum 999 km at 2014-11-12T19:00:00Z.', facts)).toEqual([expect.stringMatching(/matches no distance/), expect.stringMatching(/matches no epoch/)]);
    expect(checkAnswer('0 missing. Minimum 1 AU.', facts)).toEqual([expect.stringMatching(/matches no distance/)]);
    expect(checkAnswer('0 missing. Minimum -5 km at ET 9999.', facts)).toEqual([expect.stringMatching(/matches no distance/), expect.stringMatching(/matches no sampled epoch/)]);
    expect(checkAnswer('0 missing. Minimum 2470 metres at ET 1.', facts)).toEqual([]);
    expect(checkAnswer('0 missing. Minimum 0 km on 2099-01-01.', facts)).toEqual([expect.stringMatching(/matches no distance/), expect.stringMatching(/matches no date/)]);
  });
  it('grounds ordinary sampled readbacks too, without requiring a failed event search', () => {
    expect(checkAnswer('999 km', [{ ...facts[0], eventSearchUnavailable: false } as ResultFact])).toEqual([expect.stringMatching(/matches no distance/)]);
  });
});
