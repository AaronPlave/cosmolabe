import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ingenuityActivities, moonfallActivities, curiosityActivities } from './mission-activities.mjs';
const root = 'apps/viewer/test-catalogs/';
const read = name => JSON.parse(readFileSync(root+name,'utf8'));

describe('reproducible source-semantic activity importers', () => {
  it('keeps curated catalogs in parity with semantic importers', () => {
    expect(read('ingenuity-jezero.json').activities).toEqual(ingenuityActivities(read('data/ingenuity/flights_index.json')));
    expect(read('moonfall-shackleton.json').activities).toEqual(moonfallActivities());
    expect(read('msl-dingo-gap.json').activities).toEqual(curiosityActivities());
  });
});

import { replaceRootProperty } from './catalog-activity-metadata.mjs';
describe('catalog metadata refresh', () => {
  const fields = ['"activities": [{"old":true}]', '"name": "quoted \\"activities\\" { }"', '"arcs": [1.230000e+04, {"activities": "nested, }"}]'];
  for (const order of [[0,1,2], [1,0,2], [1,2,0]]) {
    it(`replaces root activities in order ${order} twice without changing scientific bytes`, () => {
      const text = '{\n  ' + order.map(i => fields[i]).join(',\n  ') + '\n}\n';
      const records = moonfallActivities();
      const updated = replaceRootProperty(text, 'activities', records);
      expect(JSON.parse(updated)).toEqual({...JSON.parse(text), activities: records});
      expect(updated).toContain(fields[2]);
      expect(updated).toContain(fields[1]);
      expect(replaceRootProperty(updated, 'activities', records)).toBe(updated);
    });
  }
  it('inserts absent metadata, including an empty root', () => {
    for (const text of ['{}', '{"name":"demo"}\n']) {
      const updated = replaceRootProperty(text, 'activities', []);
      expect(JSON.parse(updated)).toEqual({...JSON.parse(text), activities: []});
      expect(replaceRootProperty(updated, 'activities', [])).toBe(updated);
    }
  });
});
