import { describe, it, expect } from 'vitest';
import {
  EventSearch,
  builtinEventKinds,
  closestApproachKind,
  defaultParams,
  distanceRangeKind,
  occultationKind,
  eventBodies,
  focusForEvent,
  isIntervalEvent,
  type EtInterval,
  type GeometryFinderProvider,
} from '../geometry/events/index.js';

/**
 * A GF stand-in that records its calls and replays canned windows per relation.
 *
 * The kinds' contract with SPICE is which GF call they make with which
 * arguments — the geometry itself is CSPICE's and is not re-tested here. What
 * is tested is that the kinds ask the right question and dress the answer
 * correctly, including the `range` annotation path, which is optional on the
 * provider and so has two behaviors to pin.
 */
function provider(options: {
  windows?: Record<string, EtInterval[]>;
  occultationWindows?: Record<string, EtInterval[]>;
  /** Omit to build a provider that cannot measure range. */
  range?: (target: string, observer: string, et: number) => number;
} = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const base = {
    calls,
    gfdist: async (
      target: string, abcorr: string, observer: string,
      relate: string, refval: number, adjust: number, step: number, cnfine: EtInterval[],
    ) => {
      calls.push({ fn: 'gfdist', args: [target, abcorr, observer, relate, refval, adjust, step, cnfine] });
      return options.windows?.[relate] ?? [];
    },
    gfsep: async () => [],
    gfoclt: async (...args: unknown[]) => {
      calls.push({ fn: 'gfoclt', args });
      return options.occultationWindows?.[String(args[0])] ?? [];
    },
    gfposc: async () => [],
  };

  if (!options.range) return base as unknown as GeometryFinderProvider & { calls: typeof calls };

  return {
    ...base,
    range: async (target: string, _abcorr: string, observer: string, et: number) => {
      calls.push({ fn: 'range', args: [target, observer, et] });
      return options.range!(target, observer, et);
    },
  } as unknown as GeometryFinderProvider & { calls: typeof calls };
}

const WINDOW: EtInterval = { start: 0, end: 86_400 };

function searchOver(p: GeometryFinderProvider) {
  return new EventSearch({ registry: builtinEventKinds(), provider: p });
}

describe('built-in event kinds', () => {
  it('registers both kinds under the names queries use', () => {
    const registry = builtinEventKinds();
    expect(registry.list().map((k) => k.kind)).toEqual([
      'closest-approach',
      'distance-range',
      'occultation',
    ]);
    expect(registry.get('closest-approach')?.label).toBe('Closest approach');
  });

  it('explains itself, since a picker cannot write the sentence for it', () => {
    for (const kind of builtinEventKinds().list()) {
      expect(kind.description, `${kind.kind} has no description`).toBeTruthy();
    }
  });

  it('declares its parameters so a generic form can render them', () => {
    expect(closestApproachKind.params?.map((p) => p.key)).toEqual(['scope', 'maxRangeKm']);
    expect(defaultParams(closestApproachKind)).toEqual({ scope: 'local' });
    expect(defaultParams(distanceRangeKind)).toEqual({ relation: '<', distanceKm: 1_000_000 });
    expect(defaultParams(occultationKind)).toEqual({ state: 'all' });
  });
});

describe('eclipse / occultation', () => {
  it('uses GFOCLT and preserves deterministic interval boundaries and classification', async () => {
    const p = provider({
      occultationWindows: {
        PARTIAL: [{ start: 100, end: 160 }],
        FULL: [{ start: 160, end: 220 }],
        ANNULAR: [{ start: 500, end: 530 }],
      },
    });

    const result = await searchOver(p).run({
      id: 'eclipse-1',
      kind: 'occultation',
      bodies: { observer: 'CASSINI', back: 'SUN', front: 'SATURN' },
      window: WINDOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(p.calls.filter((call) => call.fn === 'gfoclt').map((call) => call.args[0]))
      .toEqual(['PARTIAL', 'FULL', 'ANNULAR']);
    expect(p.calls[0].args).toEqual([
      'PARTIAL', 'SATURN', 'ELLIPSOID', 'IAU_SATURN',
      'SUN', 'ELLIPSOID', 'IAU_SUN', 'LT', 'CASSINI', 10, [WINDOW],
    ]);
    expect(result.events.map((event) => ({
      state: event.state,
      start: isIntervalEvent(event) ? event.start : NaN,
      end: isIntervalEvent(event) ? event.end : NaN,
      duration: event.metrics?.find((metric) => metric.key === 'duration')?.value,
    }))).toEqual([
      { state: 'partial', start: 100, end: 160, duration: 60 },
      { state: 'full', start: 160, end: 220, duration: 60 },
      { state: 'annular', start: 500, end: 530, duration: 30 },
    ]);
    expect(result.events[0].label).toBe('Partial eclipse: SATURN in front of SUN');
    expect(focusForEvent(result.events[0])).toEqual({
      et: 100,
      bodies: ['CASSINI', 'SATURN', 'SUN'],
      primary: 'SUN',
      interval: { start: 100, end: 160 },
    });
  });

  it('can filter to a single occultation state', async () => {
    const p = provider({ occultationWindows: { FULL: [{ start: 25, end: 75 }] } });
    const result = await searchOver(p).run({
      id: 'occultation-1',
      kind: 'occultation',
      bodies: { observer: 'EARTH', back: 'STAR', front: 'MOON' },
      window: WINDOW,
      params: { state: 'full' },
    });

    expect(result.ok && result.events).toHaveLength(1);
    expect(p.calls.filter((call) => call.fn === 'gfoclt')).toHaveLength(1);
    expect(p.calls.find((call) => call.fn === 'gfoclt')?.args[0]).toBe('FULL');
  });

  it('rejects repeated participants before calling SPICE', async () => {
    const p = provider();
    const result = await searchOver(p).run({
      id: 'bad',
      kind: 'occultation',
      bodies: { observer: 'EARTH', back: 'SUN', front: 'EARTH' },
      window: WINDOW,
    });

    expect(result.ok).toBe(false);
    expect(p.calls).toHaveLength(0);
  });
});

describe('closest approach', () => {
  it('asks gfdist for local distance minima and reports the range at each', async () => {
    const p = provider({
      windows: { LOCMIN: [{ start: 100, end: 100 }, { start: 500, end: 500 }] },
      range: (_t, _o, et) => et * 10,
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [gf] = p.calls;
    expect(gf.args).toEqual(['EUROPA', 'NONE', 'JUNO', 'LOCMIN', 0, 0, 3600, [WINDOW]]);

    expect(result.events).toHaveLength(2);
    const [first] = result.events;
    expect(first.temporality).toBe('instant');
    expect(first.label).toBe('EUROPA closest approach from JUNO');
    expect(first.metrics).toEqual([
      { key: 'range', label: 'Range', value: 1000, unit: 'km', precision: 1 },
    ]);
    expect(eventBodies(first)).toEqual(['JUNO', 'EUROPA']);
  });

  it('searches for the single deepest approach when scoped globally', async () => {
    const p = provider({ windows: { ABSMIN: [{ start: 42, end: 42 }] }, range: () => 7 });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
      params: { scope: 'global' },
    });

    expect(result.ok && result.events).toHaveLength(1);
    expect(p.calls[0].args[3]).toBe('ABSMIN');
  });

  it('runs without distance metrics against a provider that cannot measure range', async () => {
    const p = provider({ windows: { LOCMIN: [{ start: 100, end: 100 }] } });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0].metrics).toBeUndefined();
  });

  it('drops approaches farther than the configured maximum', async () => {
    const p = provider({
      windows: { LOCMIN: [{ start: 100, end: 100 }, { start: 500, end: 500 }] },
      range: (_t, _o, et) => (et === 100 ? 5_000 : 900_000),
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
      params: { maxRangeKm: 10_000 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((e) => (e.temporality === 'instant' ? e.et : null))).toEqual([100]);
  });

  it('faults rather than silently ignoring a max range it cannot apply', async () => {
    const p = provider({ windows: { LOCMIN: [{ start: 100, end: 100 }] } });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
      params: { maxRangeKm: 10_000 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault.code).toBe('provider-error');
    expect(result.fault.message).toMatch(/max range/i);
  });

  it('fails rather than passing through an approach it could not measure', async () => {
    // The dangerous case: the provider has `range`, so the up-front check
    // passes, but this instant comes back unmeasurable. Letting it through
    // would show an approach that was never tested against the filter as one
    // that satisfied it.
    const p = provider({
      windows: { LOCMIN: [{ start: 100, end: 100 }, { start: 500, end: 500 }] },
      range: (_t, _o, et) => (et === 100 ? 5_000 : Number.NaN),
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
      params: { maxRangeKm: 10_000 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault.code).toBe('provider-error');
    expect(result.fault.message).toMatch(/could not be measured/i);
  });

  it('still reports unmeasurable approaches when no filter depends on the range', async () => {
    // Without `maxRangeKm` nothing is being decided by the measurement, so a
    // gap costs the event its metric rather than the whole search.
    const p = provider({
      windows: { LOCMIN: [{ start: 100, end: 100 }] },
      range: () => Number.NaN,
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].metrics).toBeUndefined();
  });

  it('reports one deepest approach even if the provider hands back several', async () => {
    // CSPICE documents ABSMIN as one extremum per confinement window, but the
    // UI offers this scope as "Deepest approach only", so the kind keeps that
    // promise itself rather than assuming it.
    const p = provider({
      windows: { ABSMIN: [{ start: 100, end: 100 }, { start: 500, end: 500 }] },
      range: (_t, _o, et) => (et === 100 ? 9_000 : 120),
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
      params: { scope: 'global' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    const [only] = result.events;
    expect(only.temporality === 'instant' && only.et).toBe(500);
    expect(only.metrics?.[0].value).toBe(120);
  });

  it('keeps every local minimum when the scope is local', async () => {
    const p = provider({
      windows: { LOCMIN: [{ start: 100, end: 100 }, { start: 500, end: 500 }] },
      range: () => 42,
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
    });

    expect(result.ok && result.events).toHaveLength(2);
  });

  it('reports a missing body against the role a picker would highlight', async () => {
    const result = await searchOver(provider()).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO' },
      window: WINDOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault.code).toBe('missing-body');
    expect(result.fault.role).toBe('target');
  });

  it('rejects a nonsensical max range before calling the provider', async () => {
    const p = provider({ windows: { LOCMIN: [{ start: 1, end: 1 }] }, range: () => 1 });
    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
      params: { maxRangeKm: -5 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault.code).toBe('invalid-params');
    expect(p.calls).toHaveLength(0);
  });

  it('selects the target and identifies both bodies when an event is focused', async () => {
    const p = provider({ windows: { LOCMIN: [{ start: 100, end: 100 }] }, range: () => 12 });
    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'closest-approach',
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      window: WINDOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const focus = focusForEvent(result.events[0]);
    expect(focus).toEqual({ et: 100, bodies: ['JUNO', 'EUROPA'], primary: 'EUROPA' });
  });
});

describe('distance range', () => {
  it('asks gfdist for the configured relation and annotates the extreme range inside each window', async () => {
    const p = provider({
      windows: {
        '<': [{ start: 100, end: 700 }],
        ABSMIN: [{ start: 400, end: 400 }],
      },
      range: () => 250_000,
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW,
      params: { relation: '<', distanceKm: 1_000_000 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(p.calls[0].args.slice(0, 6)).toEqual(['MARS', 'NONE', 'EARTH', '<', 1_000_000, 0]);
    expect(p.calls[1].args[3]).toBe('ABSMIN');

    const [event] = result.events;
    expect(isIntervalEvent(event)).toBe(true);
    expect(event.label).toBe('MARS within 1.00M km of EARTH');
    expect(event.metrics).toEqual([
      { key: 'threshold', label: 'Threshold', value: 1_000_000, unit: 'km', precision: 1 },
      { key: 'duration', label: 'Duration', value: 600, unit: 's', precision: 0 },
      { key: 'minRange', label: 'Min range', value: 250_000, unit: 'km', precision: 1 },
    ]);
  });

  it('looks for the maximum inside a "farther than" window', async () => {
    const p = provider({
      windows: { '>': [{ start: 0, end: 600 }], ABSMAX: [{ start: 300, end: 300 }] },
      range: () => 3e6,
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW,
      params: { relation: '>', distanceKm: 2e6 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(p.calls[1].args[3]).toBe('ABSMAX');
    expect(result.events[0].metrics?.at(-1)?.key).toBe('maxRange');
  });

  it('takes the true extremum when the provider returns more than one candidate', async () => {
    // A long in-range window can hold several local minima. Trusting the first
    // returned extremum would report "min range" that is merely the earliest.
    const p = provider({
      windows: {
        '<': [{ start: 0, end: 10_000 }],
        ABSMIN: [{ start: 2_000, end: 2_000 }, { start: 8_000, end: 8_000 }],
      },
      range: (_t, _o, et) => (et === 2_000 ? 900_000 : 120_000),
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW,
      params: { relation: '<', distanceKm: 1_000_000 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0].metrics?.at(-1)).toMatchObject({ key: 'minRange', value: 120_000 });
  });

  it('takes the largest candidate for a "farther than" window', async () => {
    const p = provider({
      windows: {
        '>': [{ start: 0, end: 10_000 }],
        ABSMAX: [{ start: 2_000, end: 2_000 }, { start: 8_000, end: 8_000 }],
      },
      range: (_t, _o, et) => (et === 2_000 ? 3e6 : 9e6),
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW,
      params: { relation: '>', distanceKm: 2e6 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0].metrics?.at(-1)).toMatchObject({ key: 'maxRange', value: 9e6 });
  });

  it('explains an empty result with how close the pair actually got', async () => {
    // The common cause of an empty "closer than" search is a threshold below
    // the target's own radius, which an empty list cannot show.
    const p = provider({
      windows: { '<': [], ABSMIN: [{ start: 4_000, end: 4_000 }] },
      range: () => 1_838.6,
    });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'CLIPPER', target: 'EUROPA' },
      window: WINDOW,
      params: { relation: '<', distanceKm: 1_000 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([]);
    expect(result.hint).toMatch(/closest they get is/i);
    expect(result.hint).toMatch(/centre to centre/i);
  });

  it('leaves a result unexplained rather than failing when the explanation throws', async () => {
    const p = provider({ windows: { '<': [] }, range: () => 1 });
    p.gfdist = async (_t: string, _a: string, _o: string, relate: string) => {
      if (relate === 'ABSMIN') throw new Error('coverage gap');
      return [];
    };

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'CLIPPER', target: 'EUROPA' },
      window: WINDOW,
      params: { relation: '<', distanceKm: 1_000 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([]);
    expect(result.hint).toBeUndefined();
  });

  it('does not try to explain an empty result against a provider with no range', async () => {
    const p = provider({ windows: { '<': [] } });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW,
      params: { relation: '<', distanceKm: 1_000 },
    });

    expect(result.ok && result.hint).toBeUndefined();
  });

  it('reports a threshold crossing as an instant rather than an empty span', async () => {
    const p = provider({ windows: { '=': [{ start: 250, end: 250 }] }, range: () => 1 });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW,
      params: { relation: '=', distanceKm: 5e5 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [event] = result.events;
    expect(event.temporality).toBe('instant');
    expect(isIntervalEvent(event)).toBe(false);
    // No nested extremum search for a window with no interior.
    expect(p.calls.filter((c) => c.fn === 'gfdist')).toHaveLength(1);
  });

  it('applies its declared defaults to a query that carries no params', async () => {
    const p = provider({ windows: { '<': [] } });

    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The search ran and found nothing — distinct from a fault.
    expect(result.events).toEqual([]);
    expect(p.calls[0].args.slice(3, 5)).toEqual(['<', 1_000_000]);
  });

  it('rejects an unsupported relation', async () => {
    const p = provider();
    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW,
      params: { relation: '<=' as '<', distanceKm: 1 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault.code).toBe('invalid-params');
    expect(p.calls).toHaveLength(0);
  });

  it('hands an interval its full span so a timeline can frame it', async () => {
    const p = provider({ windows: { '<': [{ start: 100, end: 700 }] } });
    const result = await searchOver(p).run({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW,
      params: { relation: '<', distanceKm: 1e6 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(focusForEvent(result.events[0])).toEqual({
      et: 100,
      bodies: ['EARTH', 'MARS'],
      primary: 'MARS',
      interval: { start: 100, end: 700 },
    });
  });
});
