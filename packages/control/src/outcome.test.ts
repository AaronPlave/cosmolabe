import { describe, expect, it } from 'vitest';
import { adopt, evaluate, parsePredicate, preconditionProblem, release, retireDomain, slotOf, valueAt, type Predicate } from './outcome.js';
import type { ScriptComposedObject, ScriptEventVisualization, ViewerControl } from './contracts.js';

const host = (methods: Partial<ViewerControl>) => methods as ViewerControl;
const ref = { scene: 1, query: 'psyche-mars', id: 'e2', revision: 3 };
const visualization = (over: Partial<ScriptEventVisualization> = {}): ScriptEventVisualization => ({
  scene: 1, selected: ref, et: 100, playing: false, selectedObject: 'Psyche', highlightedBodies: [],
  timeline: { min: 0, max: 1, selectedInResults: true, selectedInVisibleLane: true },
  renderer: { observedEt: 100, selected: { query: 'psyche-mars', id: 'e2' }, markerGroups: 1, visibleGlyphs: 1, visibleSpans: 0, occultationVisible: false },
  status: 'observed', limitations: [],
  presentation: { tracked: 'Mars', reference: null, participants: [{ object: 'Psyche', ndc: [0, 0, 0.5], inView: true, drawEnabled: true }, { object: 'Mars', ndc: [0.2, 0, 0.9], inView: true, drawEnabled: true }] },
  ...over,
});
const bodies = { observer: 'Psyche', target: 'Mars' };
const range = (km: number) => [{ key: 'range', label: 'Range', value: km, unit: 'km' }];
const events = (closest: string, over: Partial<ScriptEventVisualization> = {}, e2Km = 4500) => host({
  getEventVisualization: () => visualization(over),
  isPlaying: () => over.playing ?? false,
  listEventResults: () => ({ total: 2, items: [{ id: 'e1', et: 50, temporality: 'instant', bodies, metrics: range(9e7) }, { id: 'e2', et: 100, temporality: 'instant', bodies, metrics: range(e2Km) }] as never }),
  getEventResultPage: () => ({ items: [{ reference: { ...ref, id: closest }, event: {} }] }) as never,
  getEventQueryInfo: () => ({ definition: { query: { params: {} } } }) as never,
});
/** What presentEventResult's contract derives, plus "the closest". */
const presented: Predicate[] = [{ p: 'eventSelected', query: 'psyche-mars', pick: 'closest' }, { p: 'paused', value: true }, { p: 'eventEpoch', query: 'psyche-mars' },
  { p: 'eventFramed', query: 'psyche-mars' }, { p: 'eventDrawn', query: 'psyche-mars' }];

const object = (o: Partial<ScriptComposedObject> & { object: string }): ScriptComposedObject => ({ available: true, drawEnabled: true, rangeKm: 10_000, radiusKm: 3389.5,
  angularRadiusDeg: 19, bearingDeg: [10, 0], ndc: [0.3, 0], inView: true, occlusion: null, ...o });
const view = (mars: Partial<ScriptComposedObject>) => host({ getViewComposition: () => ({ scene: 1, et: 5, playing: false, tracked: 'Psyche', orbitDistanceKm: 0.06, fovDeg: 45, aspect: 1.6,
  objects: [object({ object: 'Psyche', rangeKm: 0.06, radiusKm: 0.0125, ndc: [0, 0], bearingDeg: [0, 0] }), object({ object: 'Mars', ...mars })] }) });
const closeUp: Predicate[] = [{ p: 'inView', object: 'Psyche' }, { p: 'inView', object: 'Mars' }, { p: 'legible', object: 'Mars' }, { p: 'range', object: 'Psyche', maxKm: 0.1 }];

describe('outcome predicates', () => {
  it('validates predicate shape before reading anything', () => {
    expect(() => parsePredicate({ p: 'inView' })).toThrow(/needs object/);
    expect(() => parsePredicate({ p: 'teleport' })).toThrow(/p must be one of/);
    expect(() => parsePredicate({ p: 'range', object: 'Psyche' })).toThrow(/maxKm/);
    expect(() => parsePredicate({ p: 'state', read: 'getTime' })).toThrow(/equals/);
    expect(() => parsePredicate({ p: 'epoch' })).toThrow(/et .* or utc/);
    expect(parsePredicate({ p: 'selected', object: null })).toEqual({ p: 'selected', object: null });
  });

  it('camera: hidden, fully occluded or out-of-frame objects fail; a few-pixel object is only partial', () => {
    expect(evaluate(view({}), closeUp).status).toBe('met');
    expect(evaluate(view({ drawEnabled: false }), closeUp).status).toBe('unmet');
    expect(evaluate(view({ occlusion: { by: 'Phobos', kind: 'full' } }), closeUp).status).toBe('unmet');
    expect(evaluate(view({ inView: false, ndc: null }), closeUp).status).toBe('unmet');
    expect(evaluate(view({ angularRadiusDeg: 0.0001 }), closeUp).status).toBe('partial');
    expect(evaluate(view({ radiusKm: null, angularRadiusDeg: null }), closeUp).status).toBe('partial');
    expect(evaluate(host({}), closeUp).status).toBe('inconclusive');
  });

  it('holds a conversation: same slot replaces, a new camera subject retires the old camera goal, release drops by slot', () => {
    let held = adopt([], [...closeUp, { p: 'paused', value: true }, { p: 'state', read: 'getSurfaceAppearance', args: ['Mars'], path: 'settings.baseColor', equals: 'elevation' }]).held;
    // "keep it closer": the same slot, replaced.
    const tighter = adopt(held, [{ p: 'range', object: 'Psyche', maxKm: 0.05 }]);
    expect(tighter.replaced[0]).toMatch(/range Psyche <= 0.1 km → range Psyche <= 0.05 km/);
    held = tighter.held;
    // "now show Jupiter": the camera's subject changes; Psyche/Mars camera goals go, the clock and surface stay.
    const jupiter = adopt([...held, { p: 'tracked', object: 'Psyche' }], [{ p: 'tracked', object: 'Jupiter' }, { p: 'inView', object: 'Jupiter' }]);
    expect(jupiter.retired).toEqual(expect.arrayContaining(['inView Psyche', 'inView Mars', 'legible Mars', 'range Psyche <= 0.05 km']));
    expect(jupiter.replaced).toEqual(['tracked Psyche → tracked Jupiter']);
    expect(jupiter.held.map(slotOf)).toEqual(expect.arrayContaining(['playing', 'state:getSurfaceAppearance["Mars"]settings.baseColor', 'tracked', 'view:Jupiter']));
    // Rotating around the same anchor keeps what was asked about it.
    const same = adopt([...held, { p: 'tracked', object: 'Psyche' }], [{ p: 'tracked', object: 'Psyche' }, { p: 'inView', object: 'Phobos' }]);
    expect(same.retired).toEqual([]);
    // An event's framing owns the camera too, but a constraint about the new subject itself survives.
    const event = adopt(held, [{ p: 'eventFramed', query: 'q' }]);
    expect(event.held.some(p => p.p === 'range')).toBe(false);
    const back = adopt(event.held.concat([{ p: 'range', object: 'Psyche', maxKm: 1 }]), [{ p: 'tracked', object: 'Psyche' }]);
    expect(back.held).toContainEqual({ p: 'range', object: 'Psyche', maxKm: 1 });
    const r = release(held, ['range:Psyche', 'view:Saturn']);
    expect(r.released).toEqual(['range Psyche <= 0.05 km']);
    expect(r.unknown).toEqual(['view:Saturn']);
    // The person's own camera and clock moves end what the request held them to.
    expect(retireDomain(held, 'camera').some(p => p.p === 'inView')).toBe(false);
    expect(retireDomain(held, 'time').some(p => p.p === 'paused')).toBe(false);
  });

  it('a result an operation selects inherits what the person required of it', () => {
    const held = adopt([], [{ p: 'eventSelected', query: 'q', pick: 'closest', encounter: true }]).held;
    expect(adopt(held, [{ p: 'eventSelected', query: 'q', id: 'e2' }]).held).toEqual([{ p: 'eventSelected', query: 'q', pick: 'closest', encounter: true, id: 'e2' }]);
    expect(adopt(held, [{ p: 'eventSelected', query: 'other', id: 'e2' }]).held).toEqual([{ p: 'eventSelected', query: 'other', id: 'e2' }]);
  });

  it('event presentation finds the selected result on any page, not just the first 100', () => {
    const many = Array.from({ length: 484 }, (_, i) => ({ id: `e${i}`, et: i, temporality: 'instant', bodies }));
    const h = host({ ...events('e450'), isPlaying: () => false, getEventVisualization: () => visualization({ selected: { ...ref, id: 'e450' }, et: 450, renderer: { ...visualization().renderer!, selected: { query: 'psyche-mars', id: 'e450' } } }),
      listEventResults: (_q, o) => ({ total: many.length, items: many.slice(o?.offset ?? 0, (o?.offset ?? 0) + (o?.limit ?? 100)) as never }) });
    const result = evaluate(h, presented);
    expect(result.checks.find(c => c.slot === 'clock')).toMatchObject({ ok: true });
    expect(result.status).toBe('met');
  });

  it('event presentation: closest selected, paused at its epoch and framed', () => {
    expect(evaluate(events('e2'), presented).status).toBe('met');
    const wrong = evaluate(events('e1'), presented);
    expect(wrong.status).toBe('unmet');
    expect(wrong.checks.find(c => c.slot === 'event')).toMatchObject({ ok: false, detail: expect.stringContaining('closest is e1') });
  });

  it('event presentation: playing, framing of other bodies, or drawing of another result is not success', () => {
    expect(evaluate(events('e2', { playing: true }), presented).status).toBe('unmet');
    const stale = { tracked: 'Earth', reference: null, participants: [{ object: 'Earth', ndc: [0, 0, 0.5], inView: true, drawEnabled: true }] };
    expect(evaluate(events('e2', { presentation: stale }), presented).status).toBe('unmet');
    expect(evaluate(events('e2', { status: 'partial' }), presented).status).toBe('partial');
    const otherDrawn = visualization().renderer!;
    expect(evaluate(events('e2', { renderer: { ...otherDrawn, selected: { query: 'psyche-mars', id: 'e1' } } }), presented).status).toBe('partial');
  });

  it('a range minimum is an encounter only inside the target\'s sphere of influence', () => {
    const flyby: Predicate[] = [{ p: 'eventSelected', query: 'psyche-mars', encounter: true }];
    expect(evaluate(events('e2'), flyby).status).toBe('met');
    // Mars's sphere of influence is 5.77e5 km: a 9e7 km minimum is not a flyby.
    const distant = evaluate(events('e2', {}, 9e7), flyby);
    expect(distant.status).toBe('unmet');
    expect(distant.checks[0].detail).toMatch(/sphere of influence .* not a flyby/);
    // Asked for before acting, it stops the presentation instead of reporting it afterwards.
    const asked = flyby.map(p => ({ ...p, stated: true }));
    expect(preconditionProblem(events('e2', {}, 9e7), [{ p: 'eventSelected', query: 'psyche-mars', id: 'e2' }], asked)).toMatch(/not one/);
    expect(preconditionProblem(events('e2'), [{ p: 'eventSelected', query: 'psyche-mars', id: 'e2' }], asked)).toBeNull();
    expect(preconditionProblem(events('e1'), [{ p: 'eventSelected', query: 'psyche-mars', id: 'e2' }], [{ p: 'eventSelected', query: 'psyche-mars', pick: 'closest', stated: true }])).toMatch(/closest result, which is e1/);
    // Only what the person stated stops an action; an earlier action's result does not.
    expect(preconditionProblem(events('e2', {}, 9e7), [{ p: 'eventSelected', query: 'psyche-mars', id: 'e2' }], flyby)).toBeNull();
  });

  it('allows only an operation contract to classify incomplete state evidence as partial', () => {
    const h = host({ getProfile: () => ({ status: 'partial', definition: { id: 'p' } }) as never });
    const reads = new Set(['getProfile']);
    const presentation: Predicate = { p: 'state', read: 'getProfile', args: ['p'], path: 'status', equals: 'available', soft: true };
    const definition: Predicate = { p: 'state', read: 'getProfile', args: ['p'], path: 'definition.id', equals: 'p' };
    expect(evaluate(h, [definition, presentation], { reads }).status).toBe('partial');
    expect(evaluate(h, [{ ...definition, equals: 'missing' }, presentation], { reads }).status).toBe('unmet');
    const modelGoal = parsePredicate(presentation);
    expect(modelGoal).not.toHaveProperty('soft');
    expect(evaluate(h, [modelGoal], { reads }).status).toBe('unmet');
  });
  it('state predicates compare any registered read; unregistered reads are not called', () => {
    const settings = { baseColor: 'elevation', palette: 'terrain' };
    let called = false;
    const h = host({ getSurfaceAppearance: () => ({ settings: settings as never, unavailable: null }), snapshot: () => { called = true; return ''; } });
    const reads = new Set(['getSurfaceAppearance']);
    const want = (path: string, equals: unknown): Predicate => ({ p: 'state', read: 'getSurfaceAppearance', args: ['Mars'], path, equals });
    expect(evaluate(h, [want('settings.baseColor', 'elevation')], { reads }).status).toBe('met');
    expect(evaluate(h, [want('settings.palette', 'blue-gold')], { reads }).status).toBe('unmet');
    // A path that leads nowhere is absent: "removed" is equals null.
    expect(evaluate(h, [want('settings.contours', null)], { reads }).status).toBe('met');
    expect(evaluate(h, [{ p: 'state', read: 'snapshot', equals: '' }], { reads }).status).toBe('inconclusive');
    expect(called).toBe(false);
    expect(valueAt({ layers: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] }, 'layers[id=b].v')).toBe(2);
    expect(valueAt({ features: [{ point: [77.45, 18.44], type: 'Point' }] }, 'features[point=77.45,18.44].type')).toBe('Point');
  });

  it('readiness is soft evidence: settings that hold with data not drawn are partial', () => {
    const h = (status: 'ready' | 'partial') => host({ getSurfaceAppearance: () => ({ settings: { baseColor: 'elevation' } as never, unavailable: null }),
      getReadiness: request => ({ scene: 1, status, request, missing: [], limitations: [] }) });
    const goal: Predicate[] = [{ p: 'state', read: 'getSurfaceAppearance', args: ['Mars'], path: 'settings.baseColor', equals: 'elevation' }, { p: 'ready', kind: 'terrain', body: 'Mars' }];
    expect(evaluate(h('ready'), goal, { reads: new Set(['getSurfaceAppearance']) }).status).toBe('met');
    expect(evaluate(h('partial'), goal, { reads: new Set(['getSurfaceAppearance']) }).status).toBe('partial');
  });

  it('epoch: a running clock holds no moment; calendar text is read as UTC', () => {
    const clock = (time: number, playing: boolean) => host({ getTime: () => time, isPlaying: () => playing });
    expect(evaluate(clock(100, false), [{ p: 'epoch', et: 100 }]).status).toBe('met');
    expect(evaluate(clock(160, true), [{ p: 'epoch', et: 100 }]).status).toBe('inconclusive');
    expect(evaluate(clock(64.184, false), [{ p: 'epoch', utc: '2000-01-01T12:00:00Z' }]).status).toBe('met');
  });

  describe('ground point', () => {
    const point = (bodyName: string) => ({ bodyName, bodyFixedPositionKm: [3390, 0, 0] as const });
    const projection = { status: 'available', body: 'Mars', et: 10, point: point('Mars'), reason: null, annotation: { layer: 'notes', coordinates: {}, position: [77.45, 18.44] } } as never;

    it('a pin on the wrong body is not success', () => {
      const pinned = (bodyName: string) => host({ projectGroundPoint: () => projection, getProbePoint: () => ({ scene: 1, observedEt: 10, placedEt: 10, drawn: true, point: point(bodyName) as never, annotation: null }) });
      const pin: Predicate[] = [{ p: 'probeUnder', object: 'Ingenuity' }, { p: 'probeDrawn' }];
      expect(evaluate(pinned('Mars'), pin).status).toBe('met');
      expect(evaluate(pinned('Phobos'), pin).status).toBe('unmet');
    });

    it('a saved point must be at the vehicle\'s sub-point, in a visible layer, not just selected on the right body', () => {
      const saved = (at: [number, number], visible = true, type = 'Point') => host({ projectGroundPoint: () => projection, getSelectedGeographicFeature: () => ({ layer: 'notes', feature: 'f1' }),
        listGeographicLayers: () => [{ id: 'notes', body: 'Mars', visible }] as never,
        listGeographicFeatures: () => ({ total: 1, features: [{ id: 'f1', name: 'p', type, sourceId: null, ...(type === 'Point' ? { point: at } : {}) }] }) });
      const goal: Predicate[] = [{ p: 'featureSelected' }, { p: 'featureUnder', object: 'Ingenuity' }];
      expect(evaluate(saved([77.45, 18.44]), goal).status).toBe('met');
      expect(evaluate(saved([77.45, 18.44], false), goal).status).toBe('unmet');
      expect(evaluate(saved([10, 18.44]), goal).status).toBe('unmet');
      expect(evaluate(saved([77.45, 18.44], true, 'Polygon'), goal).status).toBe('unmet');
    });

    it('a saved point need not be selected unless that was asked: the nearest in the annotation layer counts', () => {
      const saved = (points: [number, number][]) => host({ projectGroundPoint: () => projection, getSelectedGeographicFeature: () => null,
        listGeographicLayers: () => [{ id: 'notes', body: 'Mars', visible: true }] as never,
        listGeographicFeatures: () => ({ total: points.length, features: points.map((point, i) => ({ id: `f${i}`, name: 'p', type: 'Point', sourceId: null, point })) }) });
      const under: Predicate[] = [{ p: 'featureUnder', object: 'Ingenuity' }];
      expect(evaluate(saved([[10, 18.44], [77.45, 18.44]]), under).status).toBe('met');
      expect(evaluate(saved([[10, 18.44]]), under).status).toBe('unmet');
      expect(evaluate(saved([]), under).checks[0].detail).toBe('no saved point in notes');
      expect(evaluate(saved([[77.45, 18.44]]), [{ p: 'featureSelected' }, ...under]).status).toBe('unmet');
    });
  });

  it('legible alone is not a placement: out of frame fails it outright, and a small size counts only beside one', () => {
    const legible: Predicate[] = [{ p: 'legible', object: 'Mars' }];
    expect(evaluate(view({ inView: false, ndc: null }), legible).status).toBe('unmet');
    // In frame and large, but wholly behind a nearer body: not seen at all.
    expect(evaluate(view({ occlusion: { kind: 'full', by: 'Psyche' } } as never), legible).checks[0]).toMatchObject({ ok: false, soft: false, detail: 'Mars hidden behind Psyche' });
    // A few pixels across, with nothing else saying where the camera is: not a soft "partial".
    expect(evaluate(view({ rangeKm: 5.7e6, angularRadiusDeg: 0.03 }), legible).status).toBe('unmet');
    expect(evaluate(view({ rangeKm: 5.7e6, angularRadiusDeg: 0.03 }), [{ p: 'inView', object: 'Mars' }, ...legible]).status).toBe('partial');
  });

  it('"all" is only as exhaustive as the solver: every local result, the kind\'s step, one exact coverage window spanned', () => {
    const page = (window: { start: number; end: number }, windows: { start: number; end: number }[] | null, { step = 3600, scope = 'local', exact = true } = {}) => host({
      getEventSearchOptions: () => ({ kinds: [{ kind: 'closest-approach', step: 3600 }] }) as never,
      getEventResultPage: () => ({ status: 'ready', total: 3, offset: 0, nextOffset: null, items: [],
        query: { status: 'available', error: null, provenance: null, coverage: windows ? { status: 'available', windows, exact, problems: [] } : null,
          definition: { id: 'q', label: 'q', enabled: true, visible: true, query: { id: 'q', kind: 'closest-approach', bodies, window, step, abcorr: 'NONE', params: { scope } } } } }) as never });
    const all: Predicate[] = [{ p: 'eventRun', query: 'q', whole: true }];
    const one = [{ start: 100, end: 1e9 - 100 }], whole = { start: 0, end: 1e9 };
    expect(evaluate(page(whole, one), all).status).toBe('met');
    expect(evaluate(page({ start: 0, end: 5e8 }, one), all).checks[0].detail).toMatch(/does not span/);
    // Deepest-only returns one minimum: never "all".
    expect(evaluate(page(whole, one, { scope: 'global' }), all).status).toBe('unmet');
    // What the solver cannot promise is inconclusive, never met: a coarser step, disjoint or estimated coverage, unknown coverage.
    expect(evaluate(page(whole, one, { step: 86400 }), all).status).toBe('inconclusive');
    expect(evaluate(page(whole, [{ start: 100, end: 4e8 }, { start: 6e8, end: 1e9 - 100 }]), all).checks[0].detail).toMatch(/2 disjoint windows/);
    expect(evaluate(page(whole, one, { exact: false }), all).status).toBe('inconclusive');
    expect(evaluate(page(whole, null), all).status).toBe('inconclusive');
    // Without "whole", a complete search is enough.
    expect(evaluate(page({ start: 0, end: 5e8 }, one), [{ p: 'eventRun', query: 'q' }]).status).toBe('met');
  });

  it('what the person stated outranks an action\'s derived result, and survives a new camera subject', () => {
    const stated = adopt([], [{ p: 'range', object: 'Psyche', maxKm: 0.1 }, { p: 'selected', object: 'Mars' }], 'person').held;
    expect(stated.every(p => p.stated)).toBe(true);
    const after = adopt(stated, [{ p: 'tracked', object: 'Mars' }, { p: 'selected', object: 'Earth' }, { p: 'range', object: 'Psyche', maxKm: 500 }]);
    expect(after.held).toEqual(expect.arrayContaining([{ p: 'range', object: 'Psyche', maxKm: 0.1, stated: true }, { p: 'selected', object: 'Mars', stated: true }, { p: 'tracked', object: 'Mars' }]));
    expect(after.retired).toEqual([]);
    // The person restating it replaces it.
    expect(adopt(after.held, [{ p: 'selected', object: 'Earth' }], 'person').held).toContainEqual({ p: 'selected', object: 'Earth', stated: true });
    // A model cannot mark its own predicate as stated.
    expect(parsePredicate({ p: 'paused', value: true, stated: true })).toEqual({ p: 'paused', value: true });
  });
});
