import { expect, it } from 'vitest';
import { agentMetadata } from './agent-metadata.js';
import { FakeViewer } from './__tests__/fake-host.js';
import type { ScriptImageryLayer } from './contracts.js';

it('preserves safe temporal imagery facts without claiming configuration is drawing', () => {
  const base = new FakeViewer().getImagery('Titan')!.layers[0];
  const layer: ScriptImageryLayer = { ...base, status: 'ok', view: null, attribution: 'PRIVATE_SOURCE',
    time: { policy: 'follow-simulation', cadence: 'day', date: '2026-11-04', requestedDate: '2026-11-05',
      state: 'nearest', offsetDays: -1, pending: true, rangeStart: '2020-01-01', rangeEnd: '2026-11-05', illumination: 'baked' } };
  const project = agentMetadata().imageryLayer;
  expect(project(layer)).toMatchObject({ attribution: null, time: layer.time,
    evidence: { configured: true, requests: 'ok', drawnInView: false, coversView: null, completeTiles: null } });
  const drawn = { ...layer, view: { inCoverage: true, zoomLevel: 4, minZoom: 0, missingTiles: 1, degradedTiles: 0, cacheFull: false } };
  expect(project(drawn).evidence).toMatchObject({ drawnInView: true, coversView: true, completeTiles: false });
  const privateTime = { ...layer, time: { ...layer.time!, date: '/private/catalog?key=secret' } };
  expect(JSON.stringify(project(privateTime))).not.toContain('secret');
  expect(JSON.stringify(project(layer))).not.toContain('PRIVATE_SOURCE');
  expect(project(layer)).not.toHaveProperty('source');
});

it('rejects an unobserved imagery/appearance claim while retaining configuration and selected-date statements', async () => {
  const { checkAnswer, factSummary } = await import('./answer-check.js');
  const facts: import('./agent.js').ImageryEvidenceFact[] = [{ kind: 'imagery-state', body: 'Earth', et: 1, surface: 'waiting', layers: [
    { id: 'daily', name: 'Daily image', visible: true, drawn: false, date: '2026-11-05', pending: false, illumination: 'baked' },
  ] }];
  for (const text of ['The imagery is loaded.', 'Both layers are drawn.', "The only thing that changed in Earth's appearance is the daily overlay."]) {
    expect(checkAnswer(text, facts)).toEqual([expect.stringMatching(/drawing observation/)]);
  }
  for (const text of ['The selected imagery date switched to November 5.', 'No imagery is drawn yet.',
    'The loaded scene contains configured imagery; current-view drawing is unknown.',
    'Imagery may be loaded; drawing is unverified.', 'I have not inspected the pixels, so appearance differences are unknown.']) {
    expect(checkAnswer(text, facts)).toEqual([]);
  }
  expect(factSummary(facts)).toContain('selected acquisition date 2026-11-05');
  expect(factSummary(facts)).toContain('No current-view drawing');
  const observed = [{ ...facts[0], layers: [{ ...facts[0].layers[0], drawn: true }] }];
  expect(checkAnswer('The imagery is drawn.', observed)).toEqual([]);
});
