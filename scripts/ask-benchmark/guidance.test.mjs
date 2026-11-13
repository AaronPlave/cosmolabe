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

it('ranks selected, active and computed evidence before preset views independent of registration order', () => {
  const capabilities = ['camera.viewpoint','events.getEventResultPage','activities.getActivity','activities.seekActivity','profiles.sampleProfileData','profiles.upsertProfile'].map(id => ({id,available:true}));
  const scene = { selectedObject:'Probe', time:{et:50},
    viewpoints:{items:[{name:'Later',source:'catalog-viewpoint',epoch:500},{name:'Now',source:'catalog-viewpoint',epoch:50}]},
    searchesHere:[{id:'q',label:'Approach',computed:true}],
    activitiesHere:[{id:'a',name:'Pass',vehicle:'Probe',start:40,end:60,selected:false}],
    sourcePairs:[{observer:'Probe',target:'Body',positionAvailable:true,explicitlySelected:true,coverage:[{start:0,end:100}]}] };
  const examples = guidanceExamples({capabilities,scene});
  expect(examples.map(e=>e.label)).toEqual(['Explain Approach','Explore Pass','Explore Probe–Body motion','Show Now','Show Later']);
  expect(examples[2].prompt).toContain('ET 0 to 100');
  const reversed = {...scene,viewpoints:{items:[...scene.viewpoints.items].reverse()}};
  expect(guidanceExamples({capabilities,scene:reversed})).toEqual(examples);
});

it('offers source-grounded exploration without selection but never treats a configured search as computed', () => {
  const capabilities = ['profiles.upsertProfile','profiles.sampleProfileData','events.getEventResultPage'].map(id=>({id,available:true}));
  const examples = guidanceExamples({capabilities,scene:{sourcePairs:[{observer:'Probe',target:'Body',positionAvailable:true,explicitlySelected:false,coverage:[{start:0,end:100}]}], searchesHere:[{id:'q',label:'Approach',computed:false}]}});
  expect(examples[0].label).toBe('Explore Probe–Body motion');
  expect(examples[1].evidence).toContain('no calculated result');
});
