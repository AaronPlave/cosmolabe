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
