import { describe, expect, it } from 'vitest';
import { createAgentTools } from './agent.js';
import { checkAnswer, factSummary } from './answer-check.js';
import { FakeViewer } from './__tests__/fake-host.js';
import type { ViewerControl } from './contracts.js';

describe('mapped-point numerical evidence', () => {
  it.each([true, false])('publishes current native distance only when available=%s', async available => {
    const host: ViewerControl = new FakeViewer();
    host.getPlaceDistance = (object, place) => ({ status: available ? 'available' : 'unavailable', object, place, placeName: 'Belva', body: 'Mars', et: 0,
      distanceKm: available ? 0.321 : null, frame: 'IAU_MARS', datum: { referenceShape: { kind: 'sphere', radiusKm: 3396.19 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
      coverage: available ? 'available-at-epoch' : 'unavailable', accuracyKm: null, reason: available ? null : 'position-unavailable', sourceClassification: 'unknown', limitations: [] });
    const tools = createAgentTools(host), task = tools.begin();
    const r = await task.call('getPlaceDistance', { object: 'Ingenuity', place: 'mars:belva' });
    expect(r).toMatchObject({ ok: true, data: { distanceKm: available ? .321 : null, frame: 'IAU_MARS', accuracyKm: null } });
    const facts = r.facts ?? [];
    expect(checkAnswer('The distance is 500 m, accurate to 1 m.', facts).length).toBeGreaterThan(0);
    expect(checkAnswer('It was closest at 2021-08-16.', facts)).toContain('A current mapped-point distance does not establish a closest time. No geographic-point time search ran.');
    expect(checkAnswer(available ? 'The current mapped-point distance is 321 m; accuracy is unknown. A closest-time search is not supported.' : 'The current mapped-point distance is unavailable. No numerical estimate is established.', facts)).toEqual([]);
    expect(factSummary(facts)).toMatch(available ? /0.321 km.*IAU_MARS/ : /unavailable/);
    task.finish(); tools.dispose();
  });
});
