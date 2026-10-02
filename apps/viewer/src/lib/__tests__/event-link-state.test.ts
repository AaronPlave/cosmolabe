import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventStart } from '@cosmolabe/core';
import { validateEventLinkState, matchSharedEvent, type EventLinkState } from '../event-link-state';

const runtime = vi.hoisted(() => ({ spice: null as unknown, missing: false }));
vi.mock('../loader', () => ({
  getSpice: () => runtime.spice,
  getUniverse: () => ({ getBody: () => runtime.missing ? undefined : { naifId: 399 } }),
  getGeometryWorker: () => null,
  geometryScopeForWindow: () => ({}),
}));

import { captureSharedEvents, restoreSharedEvents, resetForScene, ef, selectedEventOf } from '../event-finder.svelte';
import { analysis, analysisContext } from '../analysis.svelte';
import { vs } from '../viewer-state.svelte';

const context = (): EventLinkState => ({ version: 1, current: 0, queries: [{
  query: { id: 'old-local-id', kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Moon' },
    window: { start: 0, end: 100 }, step: 10, abcorr: 'NONE', params: { scope: 'global' } },
  label: 'Lunar encounter', enabled: true, visible: false, windowMode: 'explicit', searched: true,
}], selected: { query: 0, temporality: 'instant', start: 15, end: 15 } });

function spice(gfdist = vi.fn(() => [{ start: 15, end: 15 }])) {
  return { gfdist, spkpos: () => ({ position: [1000, 0, 0] }), vnorm: () => 1000 };
}
afterEach(() => { resetForScene(); runtime.spice = null; runtime.missing = false; });

describe('event link schema', () => {
  it('validates shared model definitions and strips scripts/results/unrecognized params', () => {
    const s = context();
    const q = s.queries[0];
    expect(validateEventLinkState({ ...s, script: 'execute', results: [{ arbitrary: true }], queries: [
      { ...q, query: { ...q.query, params: { scope: 'global', script: 'execute' } } },
    ] })).toEqual(s);
  });
  it.each([
    [{ version: 2 }, /version/],
    [{ current: 99 }, /current/],
    [{ selected: { query: 2 } }, /no query/],
    [{ selected: { query: 0, temporality: 'instant', start: 10, end: 11 } }, /instant/],
    [{ selected: { query: 0, temporality: 'instant', start: 101, end: 101 } }, /outside/],
  ])('rejects malformed context %j', (patch, message) => {
    expect(() => validateEventLinkState({ ...context(), ...patch })).toThrow(message);
  });
  it('rejects bad kinds, sampling windows, parameters, and selected disabled searches', () => {
    const s = context(), q = s.queries[0];
    for (const patch of [{ kind: 'unknown' }, { step: 0 }, { window: { start: 100, end: 0 } },
      { params: { scope: 'arbitrary' } }, { abcorr: 'arbitrary' }]) {
      expect(() => validateEventLinkState({ ...s, queries: [{ ...q, query: { ...q.query, ...patch } }] })).toThrow(/Event context/);
    }
    expect(() => validateEventLinkState({ ...s, queries: [{ ...q, enabled: false }] })).toThrow(/enabled/);
  });
  it('bounds query count, rejects ambiguous identity and never executes incomplete drafts', () => {
    const q = context().queries[0];
    expect(() => validateEventLinkState({ version: 1, current: 0, queries: Array(17).fill(q) })).toThrow(/16/);
    expect(() => validateEventLinkState({ version: 1, current: 0, queries: [q, q] })).toThrow(/duplicate/);
    const draft = { ...q, searched: false, draft: true, query: { ...q.query, bodies: {} } };
    expect(validateEventLinkState({ version: 1, current: 0, queries: [draft] }).queries[0].draft).toBe(true);
    expect(() => validateEventLinkState({ version: 1, current: 0, queries: [{ ...draft, searched: true }] })).toThrow(/draft/);
  });
  it('matches epochs/spans/state instead of positional IDs, and rejects absent or ambiguous results', () => {
    const event = { id: 'new-id', queryId: 'new-query', kind: 'closest-approach', temporality: 'instant' as const,
      et: 15.0001, bodies: {}, label: 'approach' };
    expect(matchSharedEvent([event], context().selected!)).toBe(event);
    expect(() => matchSharedEvent([event, event], context().selected!)).toThrow(/uniquely/);
    expect(() => matchSharedEvent([{ ...event, et: 17 }], context().selected!)).toThrow(/uniquely/);
  });
});

describe('event link restoration through Event Finder', () => {
  it('recomputes results, preserves query provenance/flags/abcorr and restores selection without seeking', async () => {
    const provider = spice(); runtime.spice = provider;
    vs.et = 42;
    await restoreSharedEvents(context());
    expect(provider.gfdist).toHaveBeenCalledWith('399', 'NONE', '399', 'ABSMIN', 0, 0, 10, [{ start: 0, end: 100 }]);
    expect(analysis.items[0]).toMatchObject({ label: 'Lunar encounter', enabled: true, visible: false, windowMode: 'explicit', query: { abcorr: 'NONE' } });
    expect(ef.form).toMatchObject({ kind: 'closest-approach', startEt: 0, endEt: 100, step: 10, params: { scope: 'global' } });
    expect(ef.windowPinned).toBe(true);
    expect(ef.searched).toBe(true);
    expect(eventStart(selectedEventOf(analysisContext().eventResults)!)).toBe(15);
    expect(ef.selectedQueryId).not.toBe('old-local-id');
    expect(vs.et).toBe(42);
    const captured = captureSharedEvents()!;
    expect(captured.queries[0].query.id).toBe('shared-query-0');
    await restoreSharedEvents(captured);
    expect(captureSharedEvents()).toEqual(captured);
    expect(captureSharedEvents()).toMatchObject({ queries: [{ visible: false, searched: true, windowMode: 'explicit', query: { abcorr: 'NONE' } }], selected: context().selected });
  });
  it('preserves a draft without materializing a configured search or requiring SPICE', async () => {
    const q = context().queries[0];
    const state: EventLinkState = { version: 1, current: 0, queries: [{ ...q, draft: true, searched: false, windowMode: 'automatic', query: { ...q.query, bodies: {} } }] };
    await restoreSharedEvents(state);
    expect(analysis.items).toEqual([]);
    expect(ef.configuredId).toBeNull();
    expect(ef.windowPinned).toBe(false);
    expect(captureSharedEvents()?.queries[0]).toMatchObject({ draft: true, searched: false });
  });
  it('restores the edited query independently from the selected query and clears context on Back to a plain view', async () => {
    runtime.spice = spice();
    const state = context();
    state.current = 1;
    state.queries.push({ ...state.queries[0], searched: false, enabled: false, query: { ...state.queries[0].query, id: 'other', kind: 'distance-range', params: { relation: '<', distanceKm: 1000 } } });
    await restoreSharedEvents(state);
    expect(ef.kind).toBe('distance-range');
    expect(ef.selectedQueryId).not.toBe(ef.configuredId);
    await restoreSharedEvents(undefined);
    expect(analysis.items).toEqual([]);
    expect(ef.form).toBeNull();
    expect(ef.selectedId).toBeNull();
  });
  it('reports unavailable bodies, failed searches, and selected results that cannot be reproduced', async () => {
    runtime.missing = true;
    await expect(restoreSharedEvents(context())).rejects.toThrow(/body.*unavailable/);
    runtime.missing = false;
    await expect(restoreSharedEvents(context())).rejects.toThrow(/no kernels/);
    runtime.spice = spice(vi.fn(() => [{ start: 20, end: 20 }]));
    await expect(restoreSharedEvents(context())).rejects.toThrow(/not uniquely reproduced/);
    expect(ef.restoring).toBe(false);
  });
  it('abandons asynchronous restoration when navigation cancels it', async () => {
    let complete!: (result: { start: number; end: number }[]) => void;
    runtime.spice = spice(vi.fn(() => new Promise(resolve => { complete = resolve; })) as unknown as ReturnType<typeof spice>['gfdist']);
    const controller = new AbortController();
    const pending = restoreSharedEvents(context(), controller.signal);
    controller.abort();
    complete([{ start: 15, end: 15 }]);
    await pending;
    expect(ef.selectedId).toBeNull();
    expect(ef.restoring).toBe(false);
  });
});
