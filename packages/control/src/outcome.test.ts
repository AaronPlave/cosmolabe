import { describe, expect, it } from 'vitest';
import { checkGoal, parseGoal } from './outcome.js';
import type { ScriptEventVisualization, ViewerControl } from './contracts.js';

const host = (methods: Partial<ViewerControl>) => methods as ViewerControl;
const ref = { scene: 1, query: 'psyche-mars', id: 'e2', revision: 3 };
const visualization = (over: Partial<ScriptEventVisualization> = {}): ScriptEventVisualization => ({
  scene: 1, selected: ref, et: 100, playing: false, selectedObject: 'Psyche', highlightedBodies: [],
  timeline: { min: 0, max: 1, selectedInResults: true, selectedInVisibleLane: true }, renderer: null, status: 'observed', limitations: [],
  presentation: { tracked: 'Mars', reference: null, participants: [{ object: 'Psyche', ndc: [0, 0, 0.5], inView: true, drawEnabled: true }, { object: 'Mars', ndc: [0.2, 0, 0.9], inView: true, drawEnabled: true }] },
  ...over,
});
const events = (closest: string) => host({
  getEventVisualization: () => visualization(),
  listEventResults: () => ({ total: 2, items: [{ id: 'e1', et: 50, temporality: 'instant' }, { id: 'e2', et: 100, temporality: 'instant' }] as never }),
  getEventResultPage: () => ({ items: [{ reference: { ...ref, id: closest }, event: {} }] }) as never,
});

describe('outcome checks', () => {
  it('validates goal shape before reading anything', () => {
    expect(() => parseGoal({ kind: 'camera-composition', anchor: 'Psyche' })).toThrow(/include/);
    expect(() => parseGoal({ kind: 'teleport' })).toThrow(/kind must be/);
    expect(parseGoal({ kind: 'ground-point', object: 'Ingenuity', mode: 'pin' }).kind).toBe('ground-point');
  });

  it('event presentation: closest selected, paused at its epoch and framed', () => {
    expect(checkGoal(events('e2'), { kind: 'event-presentation', query: 'psyche-mars', pick: 'closest' }).status).toBe('met');
    const wrong = checkGoal(events('e1'), { kind: 'event-presentation', query: 'psyche-mars', pick: 'closest' });
    expect(wrong.status).toBe('unmet');
    expect(wrong.checks.find(c => c.name === 'closest')?.ok).toBe(false);
  });

  it('event presentation: playing or unobserved drawing is not success', () => {
    const playing = host({ ...events('e2'), getEventVisualization: () => visualization({ playing: true }) });
    expect(checkGoal(playing, { kind: 'event-presentation', query: 'psyche-mars' }).status).toBe('unmet');
    const undrawn = host({ ...events('e2'), getEventVisualization: () => visualization({ status: 'partial' }) });
    expect(checkGoal(undrawn, { kind: 'event-presentation', query: 'psyche-mars' }).status).toBe('partial');
  });

  it('surface appearance: settings without ready data are partial; wrong palette unmet', () => {
    const settings = { baseColor: 'elevation', palette: 'terrain' } as never;
    const surface = (status: 'ready' | 'partial') => host({ getSurfaceAppearance: () => ({ settings, unavailable: null }), getReadiness: request => ({ scene: 1, status, request, missing: [], limitations: [] }) });
    expect(checkGoal(surface('ready'), { kind: 'surface-appearance', body: 'Mars', baseColor: 'elevation', palette: 'terrain' }).status).toBe('met');
    expect(checkGoal(surface('partial'), { kind: 'surface-appearance', body: 'Mars', baseColor: 'elevation' }).status).toBe('partial');
    expect(checkGoal(surface('ready'), { kind: 'surface-appearance', body: 'Mars', palette: 'blue-gold' }).status).toBe('unmet');
    expect(checkGoal(host({}), { kind: 'surface-appearance', body: 'Mars' }).status).toBe('inconclusive');
  });

  it('ground point: a pin on the wrong body is not success', () => {
    const point = (bodyName: string) => ({ bodyName, bodyFixedPositionKm: [3390, 0, 0] as const });
    const projection = { status: 'available', body: 'Mars', et: 10, point: point('Mars'), reason: null } as never;
    const pinned = (bodyName: string) => host({ projectGroundPoint: () => projection, getProbePoint: () => ({ scene: 1, observedEt: 10, placedEt: 10, drawn: true, point: point(bodyName) as never, annotation: null }) });
    expect(checkGoal(pinned('Mars'), { kind: 'ground-point', object: 'Ingenuity', mode: 'pin' }).status).toBe('met');
    expect(checkGoal(pinned('Phobos'), { kind: 'ground-point', object: 'Ingenuity', mode: 'pin' }).status).toBe('unmet');
    const saved = host({ projectGroundPoint: () => projection, getSelectedGeographicFeature: () => ({ layer: 'notes', feature: 'f1' }),
      listGeographicLayers: () => [{ id: 'notes', body: 'Mars', visible: false }] as never });
    expect(checkGoal(saved, { kind: 'ground-point', object: 'Ingenuity', mode: 'saved' }).status).toBe('partial');
  });
});
