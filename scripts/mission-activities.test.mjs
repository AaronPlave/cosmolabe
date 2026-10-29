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
