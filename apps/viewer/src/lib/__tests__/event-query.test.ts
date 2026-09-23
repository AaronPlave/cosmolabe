import { describe, it, expect } from 'vitest';
import { closestApproachKind, distanceRangeKind, type EventKind, type GeometryEvent } from '@cosmolabe/core';
import {
  buildQuery,
  activeEventAtTime,
  eventContainsTime,
  eventFraction,
  eventTimelineFractions,
  headlineMetric,
  sortEvents,
  sortMetricLabel,
  eventSummary,
  eventCalloutLines,
  faultMessage,
  formForKind,
  formatKm,
  formatMetric,
  formatSeconds,
  missingRoles,
} from '../event-query';

const WINDOW = { start: 0, end: 86_400 };
const closest = closestApproachKind as unknown as EventKind<never>;
const range = distanceRangeKind as unknown as EventKind<never>;

describe('form construction', () => {
  it('seeds a form from the kind defaults and the catalog window', () => {
    const form = formForKind(closest, WINDOW);
    expect(form).toEqual({
      kind: 'closest-approach',
      bodies: {},
      params: { scope: 'local' },
      startEt: 0,
      endEt: 86_400,
      step: 3600,
    });
  });

  it('carries bodies, shared params and the step across a kind switch', () => {
    const before = formForKind(closest, WINDOW);
    before.bodies.observer = 'JUNO';
    before.bodies.target = 'EUROPA';
    before.step = 60;

    const after = formForKind(range, WINDOW, before);
    expect(after.bodies).toEqual({ observer: 'JUNO', target: 'EUROPA' });
    expect(after.step).toBe(60);
    // `relation` and `distanceKm` are this kind's own, so they come from its
    // defaults rather than from a form that never had them.
    expect(after.params).toEqual({ relation: '<', distanceKm: '1000000' });
  });

  it('lists the roles a search is still missing', () => {
    const form = formForKind(closest, WINDOW);
    expect(missingRoles(closest, form)).toEqual(['observer', 'target']);
    form.bodies.observer = 'JUNO';
    expect(missingRoles(closest, form)).toEqual(['target']);
  });
});

describe('query construction', () => {
  it('builds a query from the form, parsing params to their declared types', () => {
    const form = formForKind(range, WINDOW);
    form.bodies = { observer: 'EARTH', target: 'MARS' };
    form.params.distanceKm = '250000';

    expect(buildQuery(range, form, 'q1')).toEqual({
      id: 'q1',
      kind: 'distance-range',
      bodies: { observer: 'EARTH', target: 'MARS' },
      window: { start: 0, end: 86_400 },
      step: 3600,
      params: { relation: '<', distanceKm: 250_000 },
    });
  });

  it('omits a blank optional number rather than sending zero', () => {
    const form = formForKind(closest, WINDOW);
    form.bodies = { observer: 'JUNO', target: 'EUROPA' };
    form.params.maxRangeKm = '';

    const query = buildQuery(closest, form, 'q1');
    expect(query.params).toEqual({ scope: 'local' });
    expect('maxRangeKm' in (query.params ?? {})).toBe(false);
  });

  it('copies the bodies so later edits do not mutate a query in flight', () => {
    const form = formForKind(closest, WINDOW);
    form.bodies = { observer: 'JUNO', target: 'EUROPA' };

    const query = buildQuery(closest, form, 'q1');
    form.bodies.target = 'IO';
    expect(query.bodies.target).toBe('EUROPA');
  });
});

describe('formatting', () => {
  it('scales distances from metres to AU', () => {
    expect(formatKm(0.4)).toBe('400.0 m');
    expect(formatKm(12.34)).toBe('12.3 km');
    expect(formatKm(45_000)).toBe('45.0K km');
    expect(formatKm(3.4e6)).toBe('3.40M km');
    expect(formatKm(3e8)).toBe('2.005 AU');
  });

  it('scales durations from seconds to days', () => {
    expect(formatSeconds(4.2)).toBe('4.2 s');
    expect(formatSeconds(90)).toBe('1.5 min');
    expect(formatSeconds(7200)).toBe('2.0 hr');
    expect(formatSeconds(172_800)).toBe('2.0 d');
  });

  it('formats a metric by its unit, falling back to its suggested precision', () => {
    expect(formatMetric({ key: 'range', label: 'Range', value: 2500, unit: 'km' })).toBe('2.5K km');
    expect(formatMetric({ key: 'duration', label: 'Duration', value: 600, unit: 's' })).toBe('10.0 min');
    expect(formatMetric({ key: 'sep', label: 'Separation', value: 1.234, unit: 'deg', precision: 2 }))
      .toBe('1.23 deg');
  });

  it('leads a result row with the metric the search is about', () => {
    const instant: GeometryEvent = {
      id: 'q1:0',
      queryId: 'q1',
      kind: 'closest-approach',
      temporality: 'instant',
      et: 100,
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      label: 'EUROPA closest approach from JUNO',
      metrics: [{ key: 'range', label: 'Range', value: 1200, unit: 'km' }],
    };
    expect(eventSummary(instant)).toBe('Range 1.2K km');

    // The threshold is the query's own input, so a range window leads with the
    // extremum inside it instead.
    const interval: GeometryEvent = {
      id: 'q2:0',
      queryId: 'q2',
      kind: 'distance-range',
      temporality: 'interval',
      start: 0,
      end: 600,
      bodies: { observer: 'EARTH', target: 'MARS' },
      label: 'MARS within 1.00M km of EARTH',
      metrics: [
        { key: 'threshold', label: 'Threshold', value: 1e6, unit: 'km' },
        { key: 'duration', label: 'Duration', value: 600, unit: 's' },
        { key: 'minRange', label: 'Min range', value: 4e5, unit: 'km' },
      ],
    };
    expect(eventSummary(interval)).toBe('Min range 400.0K km');
  });
});

describe('sorting', () => {
  /** Three results: chronological order is the reverse of nearest-first. */
  function approach(id: string, et: number, km?: number): GeometryEvent {
    return {
      id,
      queryId: 'q1',
      kind: 'closest-approach',
      temporality: 'instant',
      et,
      bodies: { observer: 'JUNO', target: 'EUROPA' },
      label: 'approach',
      ...(km === undefined ? {} : { metrics: [{ key: 'range', label: 'Range', value: km, unit: 'km' }] }),
    };
  }

  const events = [approach('a', 100, 9000), approach('b', 200, 2200), approach('c', 300, 5000)];

  it('leaves chronological order alone', () => {
    expect(sortEvents(events, 'time').map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('puts the nearest approach first when sorting by value', () => {
    expect(sortEvents(events, 'metric').map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the list it was given', () => {
    sortEvents(events, 'metric');
    expect(events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts an unmeasured result last rather than as if it were zero', () => {
    const mixed = [approach('none', 50), approach('near', 400, 10)];
    expect(sortEvents(mixed, 'metric').map((e) => e.id)).toEqual(['near', 'none']);
  });

  it('falls back to chronological order for equal values', () => {
    const tied = [approach('late', 900, 500), approach('early', 100, 500)];
    expect(sortEvents(tied, 'metric').map((e) => e.id)).toEqual(['early', 'late']);
  });

  it('names the sort after the metric the results actually carry', () => {
    expect(sortMetricLabel(events)).toBe('range');
    expect(sortMetricLabel([approach('x', 1)])).toBeUndefined();
  });

  it('ignores the threshold when picking the metric a result is about', () => {
    const window: GeometryEvent = {
      id: 'w',
      queryId: 'q2',
      kind: 'distance-range',
      temporality: 'interval',
      start: 0,
      end: 600,
      bodies: { observer: 'EARTH', target: 'MARS' },
      label: 'window',
      metrics: [
        { key: 'threshold', label: 'Threshold', value: 1e6, unit: 'km' },
        { key: 'duration', label: 'Duration', value: 600, unit: 's' },
        { key: 'minRange', label: 'Min range', value: 4e5, unit: 'km' },
      ],
    };
    expect(headlineMetric(window)?.key).toBe('minRange');
    expect(sortMetricLabel([window])).toBe('min range');
  });
});

describe('faults', () => {
  it('passes through the messages a kind wrote for the user', () => {
    expect(faultMessage({ code: 'invalid-params', message: 'Distance must be positive' }))
      .toBe('Distance must be positive');
    expect(faultMessage({ code: 'missing-body', message: 'Needs a target', role: 'target' }))
      .toBe('Needs a target');
  });

  it('rewrites the structural faults in the panel\'s own terms', () => {
    expect(faultMessage({ code: 'invalid-window', message: 'end <= start' })).toMatch(/ends after it starts/);
    expect(faultMessage({ code: 'invalid-step', message: 'nope' })).toMatch(/at least one second/);
    expect(faultMessage({ code: 'provider-error', message: 'SPICE(NOFRAME)' })).toMatch(/SPICE\(NOFRAME\)/);
  });
});

describe('timeline placement', () => {
  const event: GeometryEvent = {
    id: 'q1:0',
    queryId: 'q1',
    kind: 'closest-approach',
    temporality: 'instant',
    et: 250,
    bodies: { target: 'EUROPA' },
    label: 'x',
  };

  it('places an event as a fraction of the visible range', () => {
    expect(eventFraction(event, { start: 0, end: 1000 })).toBe(0.25);
  });

  it('drops events outside the range rather than clamping them to an edge', () => {
    expect(eventFraction(event, { start: 300, end: 1000 })).toBeNull();
    expect(eventFraction(event, { start: 0, end: 100 })).toBeNull();
    expect(eventFraction(event, { start: 5, end: 5 })).toBeNull();
  });

  it('draws and clips interval events as spans', () => {
    const interval: GeometryEvent = {
      ...event,
      temporality: 'interval',
      start: 100,
      end: 600,
    };
    expect(eventTimelineFractions(interval, { start: 0, end: 1000 }))
      .toEqual({ start: 0.1, end: 0.6 });
    expect(eventTimelineFractions(interval, { start: 200, end: 400 }))
      .toEqual({ start: 0, end: 1 });
    expect(eventTimelineFractions(interval, { start: 700, end: 900 })).toBeNull();
  });

  it('finds the event under the playhead without requiring selection', () => {
    const wide: GeometryEvent = {
      ...event,
      id: 'wide',
      temporality: 'interval',
      start: 100,
      end: 600,
    };
    const narrow: GeometryEvent = {
      ...wide,
      id: 'narrow',
      start: 200,
      end: 300,
    };

    expect(eventContainsTime(wide, 100)).toBe(true);
    expect(eventContainsTime(wide, 600)).toBe(true);
    expect(eventContainsTime(wide, 601)).toBe(false);
    expect(activeEventAtTime([wide, narrow], 250)?.id).toBe('narrow');
    expect(activeEventAtTime([wide, narrow], 250, 'wide')?.id).toBe('wide');
    expect(activeEventAtTime([wide, narrow], 700)).toBeUndefined();
  });
});

describe('scene callout copy', () => {
  // Stand-in for etToUtcString: seconds since epoch as a fixed UTC string.
  const utc = (et: number) => `2031-05-27 12:${String(Math.floor(et / 60)).padStart(2, '0')}:${String(et % 60).padStart(2, '0')} UTC`;

  it('reads as a structured annotation, not a sentence, for a closest approach', () => {
    const event: GeometryEvent = {
      id: 'a', queryId: 'q', kind: 'closest-approach', temporality: 'instant', et: 1688,
      bodies: { observer: 'Europa Clipper', target: 'Europa' },
      label: 'Europa closest approach from Europa Clipper',
      metrics: [{ key: 'range', label: 'Range', value: 303_252.98, unit: 'km', precision: 1 }],
    };
    expect(eventCalloutLines(event, { utc })).toEqual([
      'Closest approach · Europa',
      '303.3K km · 2031-05-27 12:28 UTC',
    ]);
    // The marker is on the observer's own trajectory: no "Observer:" line.
    expect(eventCalloutLines(event, { utc, selected: true })).toEqual([
      'Closest approach · Europa',
      '303.3K km · 2031-05-27 12:28 UTC',
    ]);
  });

  it('names eclipse boundaries and spans without restating the relationship as prose', () => {
    const event: GeometryEvent = {
      id: 'e', queryId: 'q', kind: 'occultation', temporality: 'interval', start: 3456, end: 3894,
      state: 'full', bodies: { observer: 'Europa Clipper', front: 'Europa', back: 'SUN' },
      label: 'Full eclipse: Europa in front of SUN',
      metrics: [{ key: 'duration', label: 'Duration', value: 438, unit: 's', precision: 0 }],
    };
    expect(eventCalloutLines(event, { utc, boundary: 'start' })).toEqual([
      'Full eclipse begins', '2031-05-27 12:57:36 UTC',
    ]);
    expect(eventCalloutLines(event, { utc, boundary: 'end' })[0]).toBe('Full eclipse ends');
    expect(eventCalloutLines(event, { utc })).toEqual(['Full eclipse', 'Duration 7.3 min']);
    expect(eventCalloutLines(event, { utc, selected: true })).toEqual([
      'Full eclipse', 'Duration 7.3 min', 'Europa occults SUN',
    ]);
  });

  it('lifts the relation out of a distance-range label', () => {
    const event: GeometryEvent = {
      id: 'r', queryId: 'q', kind: 'distance-range', temporality: 'interval', start: 0, end: 600,
      bodies: { observer: 'Europa Clipper', target: 'Europa' },
      label: 'Europa within 10.0K km of Europa Clipper',
      metrics: [
        { key: 'threshold', label: 'Threshold', value: 10_000, unit: 'km' },
        { key: 'duration', label: 'Duration', value: 600, unit: 's' },
        { key: 'minRange', label: 'Min range', value: 1_600, unit: 'km' },
      ],
    };
    expect(eventCalloutLines(event, { utc })).toEqual([
      'Within 10.0K km · Europa', 'Min range 1.6K km · Duration 10.0 min',
    ]);
    // Selection adds the window, dropping what the end shares with the start.
    expect(eventCalloutLines(event, { utc, selected: true })[2]).toBe('2031-05-27 12:00 → 12:10 UTC');
    const days = (et: number) =>
      ({ 0: '2026-05-13 04:00:12 UTC', 1e5: '2026-05-18 08:00:40 UTC', 1e7: '2027-01-02 00:00:00 UTC' })[et]!;
    expect(eventCalloutLines({ ...event, start: 0, end: 1e5 }, { utc: days, selected: true })[2])
      .toBe('2026-05-13 04:00 → 05-18 08:00 UTC');
    expect(eventCalloutLines({ ...event, start: 0, end: 1e7 }, { utc: days, selected: true })[2])
      .toBe('2026-05-13 04:00 → 2027-01-02 00:00 UTC');
  });
});
