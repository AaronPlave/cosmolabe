import { expect, it } from 'vitest';
import { guidanceExamples } from './guidance.mjs';

it('does not infer data or calculations from an available operation alone', () => {
  const capabilities = ['profiles.upsertProfile', 'profiles.sampleProfileData', 'surface.getImagery'].map(id => ({ id, available: true }));
  const scene = { focusImagery: { body: 'Body', total: 0 }, viewpoints: { items: [] } };
  expect(guidanceExamples({ capabilities, scene, pair: { observer: 'A', target: 'B', positionAvailable: null } })).toEqual([]);
  const examples = guidanceExamples({ capabilities, scene, pair: { observer: 'A', target: 'B', positionAvailable: true } });
  expect(examples).toHaveLength(1);
  expect(examples[0].evidence).toMatch(/interval coverage not certified/);
  expect(examples[0].evidence).toMatch(/not clearance/);
});

it('keeps authored examples distinct from computed evidence and withholds unavailable actions', () => {
  const scene = { viewpoints: { items: [{ name: 'A', source: 'session-viewpoint' }, { name: 'B', source: 'catalog-viewpoint' }] } };
  expect(guidanceExamples({ capabilities: [{ id: 'camera.viewpoint', available: false }], scene })).toEqual([]);
  const [example] = guidanceExamples({ capabilities: [{ id: 'camera.viewpoint', available: true }], scene });
  expect(example.label).toBe('Show B');
  expect(example.prompt).toContain('authored');
  expect(example.evidence).toMatch(/not verified/);
});

it('labels imagery as configured even when its reported layer status is ok', () => {
  const [example] = guidanceExamples({ capabilities: [{ id: 'surface.getImagery', available: true }], scene: { focusImagery: { body: 'Earth', total: 1, layers: [{ status: 'ok' }] } } });
  expect(example.evidence).toContain('configured');
  expect(example.evidence).toContain('coverage not established');
});
