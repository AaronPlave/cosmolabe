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
    expect(checkAnswer(text, facts)).toEqual([expect.stringMatching(/drawing observation|visual comparison/)]);
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


it('keeps two drawn dates distinct and refuses inferred content change', async () => {
  const { checkAnswer, factSummary } = await import('./answer-check.js');
  const facts: import('./agent.js').ImageryEvidenceFact[] = ['2026-11-04', '2026-11-05'].map((date, et) => ({
    kind: 'imagery-state', body: 'Earth', et, surface: 'streamed', layers: [
      { id: 'daily', name: 'Daily image', visible: true, drawn: true, date, pending: false, illumination: 'baked' },
    ],
  }));
  for (const text of ['The cloud patterns changed.', 'Earth imagery shows different clouds.', 'The weather changed.', 'The image content differs between the dates.', 'The only thing that changes is the daily overlay.']) {
    expect(checkAnswer(text, facts)).toEqual([expect.stringMatching(/independent visual comparison/)]);
  }
  expect(checkAnswer('Imagery was drawn at both dates. The selected acquisition date changed; cloud changes cannot be established.', facts)).toEqual([]);
  const summary = factSummary(facts);
  expect(summary).toContain('2026-11-04'); expect(summary).toContain('2026-11-05');
  expect(summary).toContain('no independent visual comparison');
  // A later successful draw cannot erase the earlier missing observation.
  facts[0] = { ...facts[0], layers: [{ ...facts[0].layers[0], drawn: false }] };
  expect(checkAnswer('The imagery is drawn at both times.', facts)).toEqual([expect.stringMatching(/ET 0/)]);
});

it('does not let a later caveat erase an unsupported positive content claim', async () => {
  const {checkAnswer}=await import('./answer-check.js');
  const facts: import('./agent.js').ImageryEvidenceFact[]=[{kind:'imagery-state',body:'Earth',et:2,surface:'streamed',layers:[{id:'daily',name:'Daily',visible:true,drawn:true,date:'2026-11-05',pending:false,illumination:'baked'}]}];
  expect(checkAnswer('Its cloud cover would differ between the composites, but I cannot describe specific changes.',facts)).toContainEqual(expect.stringMatching(/independent visual comparison/));
});
