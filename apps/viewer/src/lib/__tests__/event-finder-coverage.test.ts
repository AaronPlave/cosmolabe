import { afterEach, describe, expect, it } from 'vitest';
import {
  coverageWindow,
  currentConfiguredQuery,
  ef,
  practicalSearchWindow,
  resetForScene,
  setKind,
  spiceNameForBody,
  withSpiceNames,
} from '../event-finder.svelte';
import { SpiceTrajectory, type GeometryFinderProvider } from '@cosmolabe/core';
import { vs } from '../viewer-state.svelte';

afterEach(() => resetForScene());

function coverage(start: number, end: number) {
  return {
    bodn2c: (_name: string) => 399,
    spkcov: (_id: number) => [{ start, end }],
  };
}

describe('event finder coverage window', () => {
  it('insets defaults that touch SPK edges for GF derivative probes', () => {
    expect(coverageWindow(
      coverage(0, 100),
      { observer: 'EARTH', target: 'MOON' },
      { start: 0, end: 100 },
    )).toEqual({ start: 3, end: 97 });
  });

  it('does not narrow a catalog window already inside SPK coverage', () => {
    expect(coverageWindow(
      coverage(0, 100),
      { observer: 'EARTH', target: 'MOON' },
      { start: 10, end: 90 },
    )).toEqual({ start: 10, end: 90 });
  });

  it('uses the tightest shared boundary before applying the inset', () => {
    const fake = {
      bodn2c: (name: string) => name === 'EARTH' ? 399 : 301,
      spkcov: (id: number) => id === 399
        ? [{ start: 0, end: 100 }]
        : [{ start: 20, end: 80 }],
    };

    expect(coverageWindow(
      fake,
      { observer: 'EARTH', target: 'MOON' },
      { start: 0, end: 100 },
    )).toEqual({ start: 23, end: 77 });
  });
});

describe('event finder SPICE names', () => {
  // The Psyche FK maps the name PSYCHE to the asteroid (2000016); the catalog's
  // "Psyche" is the spacecraft (-255). Passing the display name through made a
  // spacecraft→Mars search measure the asteroid and miss the Mars flyby.
  it('prefers the catalog naifId over the display name', () => {
    expect(spiceNameForBody({ naifId: -255 }, 'Psyche')).toBe('-255');
  });

  it('falls back to the SPICE trajectory target, then the name', () => {
    const trajectory = Object.create(SpiceTrajectory.prototype, {
      spiceTarget: { get: () => '-159' },
    });
    expect(spiceNameForBody({ trajectory }, 'Europa Clipper')).toBe('-159');
    expect(spiceNameForBody({ trajectory: {} }, 'Mars')).toBe('Mars');
    expect(spiceNameForBody(undefined, 'Mars')).toBe('Mars');
  });

  it('translates body arguments only, leaving frames and shapes alone', async () => {
    const calls: unknown[][] = [];
    const record = (...args: unknown[]) => { calls.push(args); return []; };
    const provider = {
      gfdist: record, gfsep: record, gfoclt: record, gfposc: record,
      range: (...args: unknown[]) => { calls.push(args); return 1; },
    } as unknown as GeometryFinderProvider;
    const toSpice = (name: string) => (name === 'Psyche' ? '-255' : name);
    const wrapped = withSpiceNames(provider, toSpice);
    const w = [{ start: 0, end: 1 }];

    await wrapped.gfdist('Mars', 'NONE', 'Psyche', '<', 1, 0, 60, w);
    await wrapped.gfsep('Psyche', 'POINT', '', 'Sun', 'SPHERE', '', 'NONE', 'Psyche', '<', 1, 0, 60, w);
    await wrapped.gfoclt('ANY', 'Mars', 'ELLIPSOID', 'IAU_Mars', 'Psyche', 'POINT', '', 'NONE', 'Psyche', 60, w);
    await wrapped.gfposc('Psyche', 'J2000', 'NONE', 'Mars', 'LATITUDINAL', 'LATITUDE', '>', 0, 0, 60, w);
    await wrapped.range!('Mars', 'NONE', 'Psyche', 0);

    expect(calls).toEqual([
      ['Mars', 'NONE', '-255', '<', 1, 0, 60, w],
      ['-255', 'POINT', '', 'Sun', 'SPHERE', '', 'NONE', '-255', '<', 1, 0, 60, w],
      ['ANY', 'Mars', 'ELLIPSOID', 'IAU_Mars', '-255', 'POINT', '', 'NONE', '-255', 60, w],
      ['-255', 'J2000', 'NONE', 'Mars', 'LATITUDINAL', 'LATITUDE', '>', 0, 0, 60, w],
      ['Mars', 'NONE', '-255', 0],
    ]);
  });

  it('computes default coverage for the SPICE object, not the display name', () => {
    const fake = {
      // bodn2c('PSYCHE') would be the asteroid; an ID string must skip it.
      bodn2c: (_name: string) => 2000016,
      spkcov: (id: number) => id === -255
        ? [{ start: 10, end: 50 }]
        : [{ start: 0, end: 100 }],
    };
    expect(coverageWindow(
      fake,
      { observer: 'Psyche' },
      { start: 0, end: 100 },
      (name) => (name === 'Psyche' ? '-255' : name),
    )).toEqual({ start: 13, end: 47 });
  });
});

describe('event finder practical default window', () => {
  const year = 365.25 * 86_400;

  it('centers a two-year default on the current time inside a long catalog', () => {
    expect(practicalSearchWindow({ start: -100 * year, end: 100 * year }, 10)).toEqual({
      start: 10 - year,
      end: 10 + year,
    });
  });

  it('clamps the default at either catalog edge', () => {
    expect(practicalSearchWindow({ start: 0, end: 10 * year }, 0)).toEqual({
      start: 0,
      end: 2 * year,
    });
    expect(practicalSearchWindow({ start: 0, end: 10 * year }, 10 * year)).toEqual({
      start: 8 * year,
      end: 10 * year,
    });
  });

  it('leaves a shorter catalog span unchanged', () => {
    expect(practicalSearchWindow({ start: 10, end: 20 }, 15)).toEqual({ start: 10, end: 20 });
  });

  it('supports a smaller kind-specific practical span', () => {
    const day = 86_400;
    expect(practicalSearchWindow({ start: 0, end: 365 * day }, 180 * day, 90 * day)).toEqual({
      start: 135 * day,
      end: 225 * day,
    });
  });
});

describe('event finder window provenance', () => {
  it('preserves an explicit window when the event type changes', async () => {
    vs.et = 500;
    vs.scrubBaseMin = 0;
    vs.scrubBaseMax = 1_000;
    ef.kind = 'closest-approach';
    ef.form = {
      kind: 'closest-approach',
      bodies: { observer: 'EARTH', target: 'MOON' },
      params: {},
      startEt: 120,
      endEt: 340,
      step: 3_600,
    };
    ef.windowPinned = true;
    const { createConfiguredEventQuery } = await import('../analysis.svelte');
    ef.configuredId = createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'EARTH', target: 'MOON' } }, 'Q').id;

    setKind('distance-range');

    expect(ef.form).toMatchObject({ kind: 'distance-range', startEt: 120, endEt: 340 });
    expect(ef.windowPinned).toBe(true);
    expect(currentConfiguredQuery()?.windowMode).toBe('explicit');
    expect(currentConfiguredQuery()?.query.window).toEqual({ start: 120, end: 340 });
  });
});

describe('removing an event search', () => {
  it('drops its item, results, selection and preview, and moves the form to a neighbour', async () => {
    const { removeConfiguredQuery, configuredEventQueries, previewEvent } = await import('../event-finder.svelte');
    const { analysis, createConfiguredEventQuery, setEventResults } = await import('../analysis.svelte');
    const a = createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Mars' } }, 'A');
    const b = createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Venus' } }, 'B');
    const result = {
      id: 'r0', queryId: b.id, kind: 'closest-approach', temporality: 'instant' as const,
      et: 10, bodies: { observer: 'Earth', target: 'Venus' }, label: 'b',
    };
    setEventResults(a.id, []);
    setEventResults(b.id, [result]);
    ef.configuredId = b.id;
    ef.selectedId = 'r0';
    ef.selectedQueryId = b.id;
    previewEvent(result);

    removeConfiguredQuery(b.id);

    expect(configuredEventQueries().map((q) => q.id)).toEqual([a.id]);
    expect(analysis.eventResults[b.id]).toBeUndefined();
    expect([ef.selectedId, ef.previewId, ef.previewQueryId]).toEqual([null, null, null]);
    expect(ef.configuredId).toBe(a.id);
  });
});

describe('draft and configured searches', () => {
  const form = () => ({
    kind: 'closest-approach',
    bodies: { observer: 'Earth', target: 'Mars' } as Record<string, string>,
    params: {},
    startEt: 0,
    endEt: 100,
    step: 3_600,
  });

  it('removing the last search leaves zero, and the form an unsaved draft', async () => {
    const { removeConfiguredQuery, configuredEventQueries, setRole } = await import('../event-finder.svelte');
    const { analysis, createConfiguredEventQuery, setEventResults } = await import('../analysis.svelte');
    const only = createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Mars' } }, 'Only');
    setEventResults(only.id, []);
    ef.kind = 'closest-approach';
    ef.form = form();
    ef.configuredId = only.id;

    removeConfiguredQuery(only.id);

    expect(configuredEventQueries()).toEqual([]);
    expect(ef.configuredId).toBeNull();
    expect(analysis.eventResults).toEqual({});
    expect(ef.form).not.toBeNull();

    // Editing the draft does not bring a search back.
    setRole('target', 'Venus');
    expect(configuredEventQueries()).toEqual([]);
    expect(ef.configuredId).toBeNull();
  });

  it('a draft form never materialises a search on its own', async () => {
    const { configuredEventQueries, createNewSearch, setParam } = await import('../event-finder.svelte');
    ef.kind = 'closest-approach';
    ef.form = form();
    createNewSearch();
    setParam('threshold', '5');
    setKind('distance-range');
    expect(configuredEventQueries()).toEqual([]);
  });

  it('opening a search to edit keeps an unrelated selection', async () => {
    const { openConfiguredQuery, isSelectedEvent } = await import('../event-finder.svelte');
    const { createConfiguredEventQuery } = await import('../analysis.svelte');
    const a = createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Mars' } }, 'A');
    const b = createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Venus' } }, 'B');
    ef.configuredId = a.id;
    ef.selectedId = 'r3';
    ef.selectedQueryId = a.id;

    openConfiguredQuery(b.id);

    expect(ef.configuredId).toBe(b.id);
    expect([ef.selectedId, ef.selectedQueryId]).toEqual(['r3', a.id]);
    // Identity is the pair: the same id in the edited query is not selected.
    expect(isSelectedEvent({ id: 'r3', queryId: a.id })).toBe(true);
    expect(isSelectedEvent({ id: 'r3', queryId: b.id })).toBe(false);
  });

  it('selecting a result inspects it without switching the search being edited', async () => {
    const { selectEvent, isSelectedEvent } = await import('../event-finder.svelte');
    const { createConfiguredEventQuery, setEventResults } = await import('../analysis.svelte');
    const a = createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Mars' } }, 'A');
    const b = createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Venus' } }, 'B');
    const result = {
      id: 'r0', queryId: b.id, kind: 'closest-approach', temporality: 'instant' as const,
      et: 10, bodies: { observer: 'Earth', target: 'Venus' }, label: 'b',
    };
    setEventResults(b.id, [result]);
    ef.configuredId = a.id;

    selectEvent(result);

    expect(ef.configuredId).toBe(a.id);
    expect(isSelectedEvent(result)).toBe(true);
  });

  it('hiding a search from the timeline keeps its selected event; disabling it clears it', async () => {
    const {
      selectEvent, selectedEventOf, setConfiguredQueryVisible, setConfiguredQueryEnabled,
    } = await import('../event-finder.svelte');
    const { analysisContext, createConfiguredEventQuery, setEventResults, visibleTimelineEvents } = await import('../analysis.svelte');
    const q = createConfiguredEventQuery({ kind: 'closest-approach', bodies: { observer: 'Earth', target: 'Venus' } }, 'Q');
    const result = {
      id: 'r0', queryId: q.id, kind: 'closest-approach', temporality: 'instant' as const,
      et: 10, bodies: { observer: 'Earth', target: 'Venus' }, label: 'q',
    };
    setEventResults(q.id, [result]);
    selectEvent(result);

    // `visible` is timeline presentation: the lane goes, the selection stays.
    setConfiguredQueryVisible(q.id, false);
    expect(visibleTimelineEvents()).toEqual([]);
    expect(selectedEventOf(analysisContext().eventResults)?.id).toBe('r0');

    // `enabled` is analysis membership: the selection goes with it.
    setConfiguredQueryEnabled(q.id, false);
    expect([ef.selectedId, ef.selectedQueryId]).toEqual([null, null]);
  });
});

