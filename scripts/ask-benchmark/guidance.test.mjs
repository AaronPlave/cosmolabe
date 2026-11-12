import { expect, it } from 'vitest';
import { guidanceExamples } from './guidance.mjs';

it('does not infer data or calculations from an available operation alone', () => {
  const capabilities = ['profiles.upsertProfile', 'profiles.sampleProfileData', 'surface.getImagery'].map(id => ({ id, available: true }));
  const scene = { focusImagery: { body: 'Body', total: 0 }, viewpoints: { items: [] } };
  expect(guidanceExamples({ capabilities, scene, pair: { observer: 'A', target: 'B', explicitlySelected: true, positionAvailable: null } })).toEqual([]);
  const examples = guidanceExamples({ capabilities, scene, pair: { observer: 'A', target: 'B', explicitlySelected: true, positionAvailable: true } });
  expect(examples).toHaveLength(1);
  expect(examples[0].evidence).toMatch(/Some dates may have no data/);
  expect(examples[0].evidence).toMatch(/does not measure distance to a surface/);
});

it('keeps authored examples distinct from computed evidence and withholds unavailable actions', () => {
  const scene = { viewpoints: { items: [{ name: 'A', source: 'session-viewpoint' }, { name: 'B', source: 'catalog-viewpoint' }] } };
  expect(guidanceExamples({ capabilities: [{ id: 'camera.viewpoint', available: false }], scene })).toEqual([]);
  const [example] = guidanceExamples({ capabilities: [{ id: 'camera.viewpoint', available: true }], scene });
  expect(example.label).toBe('Show B');
  expect(example.prompt).toContain('authored');
  expect(example.evidence).toMatch(/small or hidden/);
});

it('labels imagery as configured even when its reported layer status is ok', () => {
  const [example] = guidanceExamples({ capabilities: [{ id: 'surface.getImagery', available: true }], scene: { focusImagery: { body: 'Earth', total: 1, layers: [{ status: 'ok' }] } } });
  expect(example.evidence).toContain('listed in this scene');
  expect(example.evidence).toContain('Check whether they are loaded and visible');
});

it('never turns a default camera pair into an investigative suggestion', () => {
  const capabilities = ['profiles.upsertProfile', 'profiles.sampleProfileData'].map(id => ({ id, available: true }));
  expect(guidanceExamples({ capabilities, scene: {}, pair: { observer: 'A', target: 'B', positionAvailable: true, explicitlySelected: false } })).toEqual([]);
});
