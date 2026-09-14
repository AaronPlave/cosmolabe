import { describe, it, expect, vi } from 'vitest';
import {
  EVENT_ROLES,
  EventKindRegistry,
  EventSearch,
  applyEventFocus,
  compareEvents,
  cspiceWasmGeometryFinder,
  eventBodies,
  eventDuration,
  eventEnd,
  eventMidpoint,
  eventNearest,
  eventOverlaps,
  eventStart,
  eventTimelineSpan,
  focusForEvent,
  isIntervalEvent,
  requiredRoles,
  type EtInterval,
  type EventKind,
  type GeometryEvent,
  type GeometryFinderProvider,
  type InstantEvent,
  type IntervalEvent,
} from '../geometry/events/index.js';

/** A GF provider that records calls and replays canned intervals. */
function fakeProvider(intervals: EtInterval[] = []): GeometryFinderProvider & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return intervals;
  };
  return {
    calls,
    gfdist: record('gfdist'),
    gfsep: record('gfsep'),
    gfoclt: record('gfoclt'),
    gfposc: record('gfposc'),
  } as GeometryFinderProvider & { calls: unknown[][] };
}

/**
 * A stand-in event kind. The concrete kinds (closest approach, range,
 * occultation) are follow-on work; this exercises the shared model against the
 * real GF boundary shape.
 */
const rangeKind: EventKind<{ refval: number }> = {
  kind: 'test:in-range',
  label: 'In range',
  temporality: 'interval',
  roles: [
    { role: 'observer', label: 'Observer' },
    { role: 'target', label: 'Target' },
    { role: 'center', label: 'Center', required: false, default: 'SUN' },
  ],
  defaultStep: 3600,
  defaultAbcorr: 'LT+S',
  validate: (query) =>
    typeof query.params?.refval === 'number' && query.params.refval > 0
      ? undefined
      : { code: 'invalid-params', message: 'refval must be a positive distance in km' },
  run: async (query, ctx) => {
    const windows = await ctx.provider.gfdist(
      query.bodies.target!, query.abcorr, query.bodies.observer!,
      '<', query.params!.refval, 0, query.step, [query.window],
    );
    return windows.map((w): IntervalEvent => ({
      id: ctx.nextEventId(),
      queryId: query.id,
      kind: query.kind,
      temporality: 'interval',
      bodies: query.bodies,
      label: `${query.bodies.target} in range`,
      start: w.start,
      end: w.end,
      metrics: [{ key: 'threshold', label: 'Range threshold', value: query.params!.refval, unit: 'km' }],
    }));
  },
};

const instant = (et: number, over: Partial<InstantEvent> = {}): InstantEvent => ({
  id: `i${et}`, queryId: 'q', kind: 'test:instant', temporality: 'instant',
  bodies: { observer: 'EARTH', target: 'MOON' }, label: 'instant', et, ...over,
});

const interval = (start: number, end: number, over: Partial<IntervalEvent> = {}): IntervalEvent => ({
  id: `v${start}`, queryId: 'q', kind: 'test:interval', temporality: 'interval',
  bodies: { observer: 'EARTH', front: 'MOON', back: 'SUN' }, label: 'interval', start, end, ...over,
});

function search(provider: GeometryFinderProvider) {
  return new EventSearch({ registry: new EventKindRegistry().register(rangeKind), provider });
}

const baseQuery = {
  id: 'q1',
  kind: 'test:in-range',
  bodies: { observer: 'EARTH', target: 'MOON' },
  window: { start: 0, end: 86400 },
  params: { refval: 400000 },
};

describe('geometry event model', () => {
  it('represents both instantaneous and interval events', () => {
    expect(isIntervalEvent(instant(100))).toBe(false);
    expect(eventStart(instant(100))).toBe(100);
    expect(eventEnd(instant(100))).toBe(100);
    expect(eventDuration(instant(100))).toBe(0);
    expect(eventMidpoint(instant(100))).toBe(100);

    const span = interval(100, 300);
    expect(isIntervalEvent(span)).toBe(true);
    expect(eventStart(span)).toBe(100);
    expect(eventEnd(span)).toBe(300);
    expect(eventDuration(span)).toBe(200);
    expect(eventMidpoint(span)).toBe(200);
  });

  it('associates events with the bodies involved, de-duplicated', () => {
    expect(eventBodies(interval(0, 1))).toEqual(['EARTH', 'MOON', 'SUN']);
    expect(eventBodies(instant(0, { bodies: { observer: 'MARS', target: 'MARS' } }))).toEqual(['MARS']);
  });

  it('orders bodies canonically, not by participant-object insertion order', () => {
    // Same roles, opposite key order: highlighting must not depend on how the
    // participant object happened to be built.
    const forward = instant(0, { bodies: { observer: 'EARTH', front: 'MOON', back: 'SUN' } });
    const reversed = instant(0, { bodies: { back: 'SUN', front: 'MOON', observer: 'EARTH' } });

    expect(eventBodies(forward)).toEqual(eventBodies(reversed));
    expect(eventBodies(reversed)).toEqual(['EARTH', 'MOON', 'SUN']);
    // And the order is EVENT_ROLES', not the union's incidental spelling.
    expect(EVENT_ROLES.indexOf('observer')).toBeLessThan(EVENT_ROLES.indexOf('front'));
  });

  it('sorts mixed instant and interval events chronologically', () => {
    const events: GeometryEvent[] = [interval(500, 900), instant(100), interval(100, 400)];
    expect([...events].sort(compareEvents).map(eventStart)).toEqual([100, 100, 500]);
    // Tie on start: the shorter event sorts first.
    expect([...events].sort(compareEvents)[0].temporality).toBe('instant');
  });
});

describe('EventSearch', () => {
  it('runs a kind through the GF boundary and returns sorted events', async () => {
    const provider = fakeProvider([{ start: 600, end: 900 }, { start: 100, end: 200 }]);
    const result = await search(provider).run(baseQuery);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((e) => eventStart(e))).toEqual([100, 600]);
    expect(result.events[0]).toMatchObject({
      queryId: 'q1', kind: 'test:in-range', temporality: 'interval', label: 'MOON in range',
    });
    // Ids are minted per search, so results stay addressable.
    expect(new Set(result.events.map((e) => e.id)).size).toBe(2);
  });

  it('applies the kind defaults for step, aberration correction, and optional roles', async () => {
    const provider = fakeProvider();
    await search(provider).run(baseQuery);

    const [, target, abcorr, observer, relate, refval, adjust, step] = provider.calls[0];
    expect({ target, abcorr, observer, relate, refval, adjust, step })
      .toEqual({ target: 'MOON', abcorr: 'LT+S', observer: 'EARTH', relate: '<', refval: 400000, adjust: 0, step: 3600 });
  });

  it('lets the query override the defaults', async () => {
    const provider = fakeProvider();
    await search(provider).run({ ...baseQuery, step: 60, abcorr: 'NONE' });

    expect(provider.calls[0][2]).toBe('NONE');
    expect(provider.calls[0][7]).toBe(60);
  });

  it('distinguishes "found nothing" from "could not look"', async () => {
    const found = await search(fakeProvider([])).run(baseQuery);
    expect(found).toEqual({ ok: true, queryId: 'q1', events: [] });

    const failed = await search(fakeProvider()).run({ ...baseQuery, kind: 'test:nope' });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.fault.code).toBe('unknown-kind');
  });

  it('reports a missing required body against the role that is missing', async () => {
    const result = await search(fakeProvider()).run({ ...baseQuery, bodies: { observer: 'EARTH' } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault).toMatchObject({ code: 'missing-body', role: 'target' });
    expect(result.fault.message).toContain('Target');
  });

  it('accepts a query that omits only optional roles', async () => {
    const result = await search(fakeProvider([{ start: 1, end: 2 }])).run(baseQuery);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The optional role's default is filled in and carried onto the event.
    expect(result.events[0].bodies.center).toBe('SUN');
  });

  it('rejects an inverted, empty, or non-finite search window', async () => {
    for (const window of [{ start: 10, end: 10 }, { start: 100, end: 0 }, { start: 0, end: NaN }]) {
      const result = await search(fakeProvider()).run({ ...baseQuery, window });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.fault.code).toBe('invalid-window');
    }
  });

  it('rejects a non-positive or non-finite step', async () => {
    for (const step of [0, -60, NaN, Infinity]) {
      const result = await search(fakeProvider()).run({ ...baseQuery, step });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.fault.code).toBe('invalid-step');
    }
  });

  it('allows a step longer than the search window', async () => {
    // A GF step is a sampling step, not a span the window must contain: GF
    // samples the endpoints, so a condition changing across a short window is
    // still resolvable. Kinds needing a tighter step enforce it themselves.
    const provider = fakeProvider([{ start: 0, end: 600 }]);
    const result = await search(provider).run({ ...baseQuery, window: { start: 0, end: 600 }, step: 999999 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    expect(provider.calls[0][7]).toBe(999999);
  });

  it('surfaces kind-specific parameter validation', async () => {
    const result = await search(fakeProvider()).run({ ...baseQuery, params: { refval: -1 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault).toMatchObject({ code: 'invalid-params' });
  });

  it('wraps a provider failure as a structured fault rather than throwing', async () => {
    const provider = fakeProvider();
    provider.gfdist = () => { throw new Error('SPICE(NOFRAMECONNECT)'); };

    const result = await search(provider).run(baseQuery);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault).toMatchObject({ code: 'provider-error', window: baseQuery.window });
    expect(result.fault.message).toContain('NOFRAMECONNECT');
  });

  it('stamps the kind\'s declared primary role onto the events it returns', async () => {
    const registry = new EventKindRegistry().register({ ...rangeKind, primaryRole: 'observer' });
    const provider = fakeProvider([{ start: 1, end: 2 }]);
    const result = await new EventSearch({ registry, provider }).run(baseQuery);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0].primaryRole).toBe('observer');
    // …so selection follows the kind rather than the fallback ordering.
    expect(focusForEvent(result.events[0]).primary).toBe('EARTH');
  });

  it('leaves an event\'s own primary role in place over the kind default', async () => {
    const registry = new EventKindRegistry().register({
      ...rangeKind,
      primaryRole: 'observer',
      run: async (query, ctx) => [{
        id: ctx.nextEventId(), queryId: query.id, kind: query.kind, temporality: 'instant',
        bodies: query.bodies, label: 'x', et: 0, primaryRole: 'target',
      }],
    });
    const result = await new EventSearch({ registry, provider: fakeProvider() }).run(baseQuery);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0].primaryRole).toBe('target');
  });

  it('exposes registered kinds and their required roles for query configuration', () => {
    const kinds = search(fakeProvider()).kinds();
    expect(kinds.map((k) => k.kind)).toEqual(['test:in-range']);
    expect(requiredRoles(kinds[0]).map((r) => r.role)).toEqual(['observer', 'target']);
  });
});

describe('timeline and 3D integration', () => {
  it('focuses an interval at its start, end, or middle', () => {
    const span = interval(100, 300);
    expect(focusForEvent(span).et).toBe(100);
    expect(focusForEvent(span, 'end').et).toBe(300);
    expect(focusForEvent(span, 'middle').et).toBe(200);
    expect(focusForEvent(span).interval).toEqual({ start: 100, end: 300 });
  });

  it('gives an instantaneous event no span to frame', () => {
    const focus = focusForEvent(instant(500));
    expect(focus.et).toBe(500);
    expect(focus.interval).toBeUndefined();
  });

  it('selects the body the event names as primary', () => {
    const event = instant(0, {
      bodies: { observer: 'EARTH', target: 'MOON' },
      primaryRole: 'observer',
    });
    // The declared role wins over the fallback ordering, which prefers target.
    expect(focusForEvent(event).primary).toBe('EARTH');
  });

  it('falls back to a role preference only when nothing declared one', () => {
    expect(focusForEvent(instant(0)).primary).toBe('MOON');
    // Occultation-shaped roles: the occulted body is what the user cares about.
    expect(focusForEvent(interval(0, 1)).primary).toBe('SUN');
    expect(focusForEvent(instant(0, { bodies: { observer: 'EARTH' } })).primary).toBe('EARTH');
    expect(focusForEvent(instant(0, { bodies: {} })).primary).toBeUndefined();
  });

  it('falls back when the declared role has no body assigned', () => {
    const event = instant(0, { bodies: { target: 'MOON' }, primaryRole: 'illuminator' });
    expect(focusForEvent(event).primary).toBe('MOON');
  });

  it('drives simulation time, selection, and highlighting on the host', () => {
    const host = { setTime: vi.fn(), selectBody: vi.fn(), highlightBodies: vi.fn() };
    applyEventFocus(focusForEvent(interval(100, 300), 'middle'), host);

    expect(host.setTime).toHaveBeenCalledWith(200);
    expect(host.selectBody).toHaveBeenCalledWith('SUN');
    expect(host.highlightBodies).toHaveBeenCalledWith(['EARTH', 'MOON', 'SUN']);
  });

  it('still syncs time on a host with no selection or highlight channel', () => {
    const host = { setTime: vi.fn() };
    expect(() => applyEventFocus(focusForEvent(instant(42)), host)).not.toThrow();
    expect(host.setTime).toHaveBeenCalledWith(42);
  });

  it('widens sub-minimum spans so brief events stay visible on the timeline', () => {
    expect(eventTimelineSpan(interval(100, 300))).toEqual({ start: 100, end: 300 });
    expect(eventTimelineSpan(interval(100, 300), 100)).toEqual({ start: 100, end: 300 });
    expect(eventTimelineSpan(instant(200), 100)).toEqual({ start: 150, end: 250 });
    expect(eventTimelineSpan(interval(100, 140), 100)).toEqual({ start: 70, end: 170 });
  });

  it('culls events outside the visible time range, keeping partial overlaps', () => {
    const span = interval(100, 300);
    expect(eventOverlaps(span, { start: 0, end: 99 })).toBe(false);
    expect(eventOverlaps(span, { start: 301, end: 400 })).toBe(false);
    expect(eventOverlaps(span, { start: 0, end: 100 })).toBe(true);
    expect(eventOverlaps(span, { start: 200, end: 220 })).toBe(true);
    expect(eventOverlaps(span, { start: 0, end: 1000 })).toBe(true);
  });

  it('finds the event covering or nearest the current time', () => {
    const events = [interval(100, 300), instant(1000)];
    expect(eventNearest(events, 200)?.id).toBe('v100');
    expect(eventNearest(events, 900)?.id).toBe('i1000');
    expect(eventNearest(events, 0)?.id).toBe('v100');
    expect(eventNearest([], 0)).toBeUndefined();
  });
});

describe('cspiceWasmGeometryFinder', () => {
  it('maps tuple results and scalar bounds onto the provider interface', async () => {
    const engine = {
      gfdist: vi.fn(async () => [[10, 20]] as [number, number][]),
      gfsep: vi.fn(async () => [] as [number, number][]),
      gfoclt: vi.fn(async () => [[1, 2]] as [number, number][]),
      gfposc: vi.fn(async () => [] as [number, number][]),
    };
    const provider = cspiceWasmGeometryFinder(engine);

    await expect(provider.gfdist('MOON', 'NONE', 'EARTH', '<', 4e5, 0, 60, [{ start: 0, end: 100 }]))
      .resolves.toEqual([{ start: 10, end: 20 }]);
    expect(engine.gfdist).toHaveBeenCalledWith('MOON', 'NONE', 'EARTH', '<', 4e5, 60, 0, 100);

    await expect(provider.gfoclt('ANY', 'MOON', 'ELLIPSOID', 'IAU_MOON', 'SUN', 'POINT', '', 'LT', 'EARTH', 60, [{ start: 0, end: 5 }]))
      .resolves.toEqual([{ start: 1, end: 2 }]);
  });

  it('searches each confinement window, since the wasm engine takes one bound', async () => {
    const engine = {
      gfdist: vi.fn(async (_t, _a, _o, _r, _v, _s, start: number) => [[start, start + 1]] as [number, number][]),
      gfsep: vi.fn(async () => [] as [number, number][]),
      gfoclt: vi.fn(async () => [] as [number, number][]),
      gfposc: vi.fn(async () => [] as [number, number][]),
    };

    await expect(
      cspiceWasmGeometryFinder(engine)
        .gfdist('MOON', 'NONE', 'EARTH', '<', 1, 0, 10, [{ start: 0, end: 100 }, { start: 500, end: 600 }]),
    ).resolves.toEqual([{ start: 0, end: 1 }, { start: 500, end: 501 }]);
    expect(engine.gfdist).toHaveBeenCalledTimes(2);
  });

  it('refuses an adjust the wasm binding cannot honour rather than ignoring it', () => {
    const engine = {
      gfdist: vi.fn(async () => [] as [number, number][]),
      gfsep: vi.fn(async () => [] as [number, number][]),
      gfoclt: vi.fn(async () => [] as [number, number][]),
      gfposc: vi.fn(async () => [] as [number, number][]),
    };

    expect(() => cspiceWasmGeometryFinder(engine)
      .gfdist('MOON', 'NONE', 'EARTH', 'LOCMIN', 0, 5, 10, [{ start: 0, end: 100 }]))
      .toThrow(/adjust/);
    expect(engine.gfdist).not.toHaveBeenCalled();
  });
});
