import { describe, expect, it } from 'vitest';
import { checkGoal, mergeGoal, parseGoal, type AskGoal } from './outcome.js';
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
const events = (closest: string, over: Partial<ScriptEventVisualization> = {}) => host({
  getEventVisualization: () => visualization(over),
  listEventResults: () => ({ total: 2, items: [{ id: 'e1', et: 50, temporality: 'instant', bodies }, { id: 'e2', et: 100, temporality: 'instant', bodies }] as never }),
  getEventResultPage: () => ({ items: [{ reference: { ...ref, id: closest }, event: {} }] }) as never,
});
const eventGoal = { kind: 'event-presentation', query: 'psyche-mars', pick: 'closest' } as const;

const object = (o: Partial<ScriptComposedObject> & { object: string }): ScriptComposedObject => ({ available: true, drawEnabled: true, rangeKm: 10_000, radiusKm: 3389.5,
  angularRadiusDeg: 19, bearingDeg: [10, 0], ndc: [0.3, 0], inView: true, occlusion: null, ...o });
const view = (mars: Partial<ScriptComposedObject>) => host({ getViewComposition: () => ({ scene: 1, et: 5, playing: false, tracked: 'Psyche', orbitDistanceKm: 0.06, fovDeg: 45, aspect: 1.6,
  objects: [object({ object: 'Psyche', rangeKm: 0.06, radiusKm: 0.0125, ndc: [0, 0], bearingDeg: [0, 0] }), object({ object: 'Mars', ...mars })] }) });
const camera = { kind: 'camera-composition', anchor: 'Psyche', include: ['Mars'], maxAnchorRangeKm: 0.1 } as const;

describe('outcome checks', () => {
  it('validates goal shape before reading anything', () => {
    expect(() => parseGoal({ kind: 'camera-composition', anchor: 'Psyche' })).toThrow(/include/);
    expect(() => parseGoal({ ...camera, include: ['A', 'B', 'C', 'D', 'E'] })).toThrow(/0-4/);
    expect(() => parseGoal({ kind: 'teleport' })).toThrow(/kind must be/);
    // Ready terrain alone must never count as "coloured by elevation".
    expect(() => parseGoal({ kind: 'surface-appearance', body: 'Mars' })).toThrow(/baseColor or palette/);
    expect(() => parseGoal({ ...camera, release: ['anchor'] })).toThrow(/release/);
    // The anchor alone ("zoom into Psyche") is a goal too.
    expect(parseGoal({ kind: 'camera-composition', anchor: 'Psyche', include: [], maxAnchorRangeKm: 0.1 }).kind).toBe('camera-composition');
    expect(parseGoal({ kind: 'ground-point', object: 'Ingenuity', mode: 'pin' }).kind).toBe('ground-point');
  });

  it('camera: hidden, fully occluded or out-of-frame objects fail; a few-pixel object is only partial', () => {
    expect(checkGoal(view({}), camera).status).toBe('met');
    expect(checkGoal(view({ drawEnabled: false }), camera).status).toBe('unmet');
    expect(checkGoal(view({ occlusion: { by: 'Phobos', kind: 'full' } }), camera).status).toBe('unmet');
    expect(checkGoal(view({ inView: false, ndc: null }), camera).status).toBe('unmet');
    expect(checkGoal(view({ angularRadiusDeg: 0.0001 }), camera).status).toBe('partial');
    expect(checkGoal(view({ radiusKm: null, angularRadiusDeg: null }), camera).status).toBe('partial');
  });

  it('carries earlier constraints forward unless the person released them', () => {
    const earlier = { ...camera, et: 5, paused: true } as AskGoal;
    const later = parseGoal({ kind: 'camera-composition', anchor: 'Psyche', include: ['Phobos'] });
    const { goal, carried } = mergeGoal(earlier, later);
    expect(goal).toMatchObject({ include: ['Phobos', 'Mars'], maxAnchorRangeKm: 0.1, et: 5, paused: true });
    expect(carried.join(' ')).toMatch(/include Mars.*maxAnchorRangeKm 0.1/);
    expect(mergeGoal(earlier, { ...later, release: ['maxAnchorRangeKm', 'et'] }).goal).not.toHaveProperty('maxAnchorRangeKm');
    // A looser range cannot replace a tighter one.
    expect(mergeGoal(earlier, { ...later, maxAnchorRangeKm: 50 } as AskGoal).goal).toMatchObject({ maxAnchorRangeKm: 0.1 });
    expect(mergeGoal({ ...camera, anchor: 'Mars' } as AskGoal, later).carried).toEqual([]);
    // More than four objects is reported as a conflict, never trimmed.
    const crowded = mergeGoal({ ...camera, include: ['Mars', 'Phobos', 'Deimos', 'Earth'] } as AskGoal, parseGoal({ ...camera, include: ['Sun'] }));
    expect(crowded.goal).toMatchObject({ include: ['Sun', 'Mars', 'Phobos', 'Deimos', 'Earth'] });
    expect(crowded.conflict).toMatch(/more than 4 objects; release include/);
    expect(mergeGoal(earlier, later).conflict).toBeNull();
  });

  it('event presentation finds the selected result on any page, not just the first 100', () => {
    const many = Array.from({ length: 484 }, (_, i) => ({ id: `e${i}`, et: i, temporality: 'instant', bodies }));
    const h = host({ ...events('e450'), getEventVisualization: () => visualization({ selected: { ...ref, id: 'e450' }, et: 450, renderer: { ...visualization().renderer!, selected: { query: 'psyche-mars', id: 'e450' } } }),
      listEventResults: (_q, o) => ({ total: many.length, items: many.slice(o?.offset ?? 0, (o?.offset ?? 0) + (o?.limit ?? 100)) as never }) });
    const result = checkGoal(h, eventGoal);
    expect(result.checks.find(c => c.name === 'epoch')).toMatchObject({ ok: true });
    expect(result.status).toBe('met');
  });

  it('event presentation: closest selected, paused at its epoch and framed', () => {
    expect(checkGoal(events('e2'), eventGoal).status).toBe('met');
    const wrong = checkGoal(events('e1'), eventGoal);
    expect(wrong.status).toBe('unmet');
    expect(wrong.checks.find(c => c.name === 'closest')?.ok).toBe(false);
  });

  it('event presentation: playing, framing of other bodies, or drawing of another result is not success', () => {
    expect(checkGoal(events('e2', { playing: true }), eventGoal).status).toBe('unmet');
    const stale = { tracked: 'Earth', reference: null, participants: [{ object: 'Earth', ndc: [0, 0, 0.5], inView: true, drawEnabled: true }] };
    expect(checkGoal(events('e2', { presentation: stale }), eventGoal).status).toBe('unmet');
    expect(checkGoal(events('e2', { status: 'partial' }), eventGoal).status).toBe('partial');
    const otherDrawn = visualization().renderer!;
    expect(checkGoal(events('e2', { renderer: { ...otherDrawn, selected: { query: 'psyche-mars', id: 'e1' } } }), eventGoal).status).toBe('partial');
  });

  it('surface appearance: settings without ready data are partial; wrong palette unmet', () => {
    const settings = { baseColor: 'elevation', palette: 'terrain' } as never;
    const surface = (status: 'ready' | 'partial') => host({ getSurfaceAppearance: () => ({ settings, unavailable: null }), getReadiness: request => ({ scene: 1, status, request, missing: [], limitations: [] }) });
    expect(checkGoal(surface('ready'), { kind: 'surface-appearance', body: 'Mars', baseColor: 'elevation', palette: 'terrain' }).status).toBe('met');
    expect(checkGoal(surface('partial'), { kind: 'surface-appearance', body: 'Mars', baseColor: 'elevation' }).status).toBe('partial');
    expect(checkGoal(surface('ready'), { kind: 'surface-appearance', body: 'Mars', palette: 'blue-gold' }).status).toBe('unmet');
    expect(checkGoal(surface('ready'), { kind: 'surface-appearance', body: 'Mars' } as AskGoal).status).toBe('unmet');
    expect(checkGoal(host({}), { kind: 'surface-appearance', body: 'Mars', baseColor: 'elevation' }).status).toBe('inconclusive');
  });

  describe('ground point', () => {
    const point = (bodyName: string) => ({ bodyName, bodyFixedPositionKm: [3390, 0, 0] as const });
    const projection = { status: 'available', body: 'Mars', et: 10, point: point('Mars'), reason: null, annotation: { layer: 'notes', coordinates: {}, position: [77.45, 18.44] } } as never;

    it('a pin on the wrong body is not success', () => {
      const pinned = (bodyName: string) => host({ projectGroundPoint: () => projection, getProbePoint: () => ({ scene: 1, observedEt: 10, placedEt: 10, drawn: true, point: point(bodyName) as never, annotation: null }) });
      expect(checkGoal(pinned('Mars'), { kind: 'ground-point', object: 'Ingenuity', mode: 'pin' }).status).toBe('met');
      expect(checkGoal(pinned('Phobos'), { kind: 'ground-point', object: 'Ingenuity', mode: 'pin' }).status).toBe('unmet');
    });

    it('a saved point must be at the vehicle\'s sub-point, not just selected on the right body', () => {
      const saved = (at: [number, number], visible = true, type = 'Point') => host({ projectGroundPoint: () => projection, getSelectedGeographicFeature: () => ({ layer: 'notes', feature: 'f1' }),
        listGeographicLayers: () => [{ id: 'notes', body: 'Mars', visible }] as never,
        listGeographicFeatures: () => ({ total: 1, features: [{ id: 'f1', name: 'p', type, sourceId: null, ...(type === 'Point' ? { point: at } : {}) }] }) });
      const goal = { kind: 'ground-point', object: 'Ingenuity', mode: 'saved' } as const;
      expect(checkGoal(saved([77.45, 18.44]), goal).status).toBe('met');
      expect(checkGoal(saved([77.45, 18.44], false), goal).status).toBe('partial');
      expect(checkGoal(saved([10, 18.44]), goal).status).toBe('unmet');
      expect(checkGoal(saved([77.45, 18.44], true, 'Polygon'), goal).status).toBe('unmet');
    });
  });
});
