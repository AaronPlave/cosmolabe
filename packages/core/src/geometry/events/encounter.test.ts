import { describe, expect, it } from 'vitest';
import { classifyApproach } from './encounter.js';

describe('classifyApproach', () => {
  it('uses the participant with a sphere of influence, whichever is called the target', () => {
    expect(classifyApproach(['Psyche', 'Earth'], 1.8e8)).toMatchObject({ criterion: 'sphere-of-influence', body: 'Earth', encounter: false });
    expect(classifyApproach(['Earth', 'Psyche'], 1.8e8)).toMatchObject({ body: 'Earth', encounter: false });
    expect(classifyApproach(['Psyche', 'Mars'], 4500)).toMatchObject({ body: 'Mars', encounter: true });
    expect(classifyApproach(['Voyager 1', 'Jupiter'], 348_900)).toMatchObject({ encounter: true });
    expect(classifyApproach(['Voyager 1', 'Neptune'], 3.48e9)).toMatchObject({ encounter: false });
  });
  it('has no criterion for small bodies unless the search set one', () => {
    expect(classifyApproach(['Cassini', 'Mimas'], 9.5)).toMatchObject({ criterion: null, encounter: null });
    expect(classifyApproach(['Cassini', 'Mimas'], 9.5, 1000)).toMatchObject({ criterion: 'query-max-range', encounter: true });
    expect(classifyApproach(['Psyche', 'Mars'], null)).toMatchObject({ encounter: null });
  });
});
