import { beforeEach, describe, expect, it } from 'vitest';
import type { InstantEvent } from '@cosmolabe/core';
import {
  analysis,
  analysisContext,
  createConfiguredEventQuery,
  createConfiguredProfile,
  resetAnalysis,
  setConfiguredItemEnabled,
  setConfiguredItemVisible,
  setEventResults,
  updateConfiguredEventQuery,
  visibleTimelineEvents,
} from '../analysis.svelte';
import { vs } from '../viewer-state.svelte';

const event: InstantEvent = {
  id: 'result-1',
  queryId: 'event-query-1',
  kind: 'closest-approach',
  temporality: 'instant',
  bodies: { observer: 'EARTH', target: 'MOON' },
  label: 'Moon closest approach',
  et: 150,
};

describe('viewer analysis state', () => {
  beforeEach(() => {
    resetAnalysis();
    vs.et = 150;
    vs.scrubBaseMin = 100;
    vs.scrubBaseMax = 200;
  });

  it('keeps configured items stable while their configuration changes', () => {
    const item = createConfiguredEventQuery(
      { kind: 'closest-approach', bodies: { observer: 'EARTH', target: 'MOON' } },
      'Moon approach',
    );
    setConfiguredItemEnabled(item.id, false);
    const changed = updateConfiguredEventQuery(
      item.id,
      { kind: 'closest-approach', bodies: { observer: 'EARTH', target: 'MARS' } },
      'Mars approach',
    );

    expect(changed).toMatchObject({ id: item.id, enabled: false, label: 'Mars approach' });
    expect(changed?.type === 'event-query' && changed.query.bodies?.target).toBe('MARS');
  });

  it('lets event and profile items coexist with independent state', () => {
    const query = createConfiguredEventQuery({ kind: 'closest-approach' }, 'Approaches');
    const profile = createConfiguredProfile({ quantity: 'range', bodies: { target: 'MARS' } }, 'Mars range');
    setEventResults(query.id, [{ ...event, queryId: query.id }]);

    expect(analysis.items.map((item) => item.type)).toEqual(['event-query', 'continuous-profile']);
    expect(visibleTimelineEvents()).toHaveLength(1);

    setConfiguredItemVisible(query.id, false);
    expect(visibleTimelineEvents()).toEqual([]);
    // Hidden is presentation-only: other analysis consumers still receive it.
    expect(analysisContext().eventResults).toHaveLength(1);
    expect(profile.visible).toBe(true);

    setConfiguredItemVisible(query.id, true);
    setConfiguredItemEnabled(query.id, false);
    expect(visibleTimelineEvents()).toEqual([]);
    // Disabled means the item no longer participates in shared analysis, even
    // though its cached result remains available if it is enabled again.
    expect(analysisContext().eventResults).toEqual([]);
    expect(analysis.eventResults[query.id]).toHaveLength(1);
    expect(profile.enabled).toBe(true);
  });

  it('exposes the viewer playhead, range, defaults, and derived results as one context', () => {
    analysis.bodies = { observer: 'EARTH', target: 'MOON' };
    analysis.quantities.push({
      id: 'range-now', quantity: 'range', et: 150, value: 384_400, unit: 'km',
      bodies: { observer: 'EARTH', target: 'MOON' },
    });
    const query = createConfiguredEventQuery({ kind: 'closest-approach' }, 'Approaches');
    setEventResults(query.id, [{ ...event, queryId: query.id }]);

    expect(analysisContext()).toMatchObject({
      bodies: { observer: 'EARTH', target: 'MOON' },
      reference: { frame: 'J2000', abcorr: 'LT+S' },
      window: { start: 100, end: 200 },
      currentTime: 150,
    });
    expect(analysisContext().quantities).toHaveLength(1);
    expect(analysisContext().eventResults).toHaveLength(1);
  });
});
