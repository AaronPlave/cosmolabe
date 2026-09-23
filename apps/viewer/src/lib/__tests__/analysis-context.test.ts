import { beforeEach, describe, expect, it } from 'vitest';
import type { InstantEvent } from '@cosmolabe/core';
import {
  analysis,
  analysisContext,
  createConfiguredEventQuery,
  configuredProfiles,
  createConfiguredProfile,
  moveConfiguredProfile,
  removeConfiguredItem,
  resetAnalysis,
  resolveProfile,
  setConfiguredItemEnabled,
  setConfiguredItemVisible,
  setEventResults,
  updateConfiguredEventQuery,
  updateConfiguredProfile,
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

  it('preserves whether an event window was automatic or explicitly chosen', () => {
    const item = createConfiguredEventQuery(
      { kind: 'closest-approach', window: { start: 100, end: 200 } },
      'Approach',
    );
    expect(item.windowMode).toBe('automatic');

    const changed = updateConfiguredEventQuery(
      item.id,
      { kind: 'closest-approach', window: { start: 120, end: 180 } },
      undefined,
      'explicit',
    );
    expect(changed?.windowMode).toBe('explicit');
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

  it('keeps multiple profile rows configurable, reorderable and removable', () => {
    const query = createConfiguredEventQuery({ kind: 'closest-approach' }, 'Approaches');
    const range = createConfiguredProfile({ quantity: 'range', bodies: { target: 'MOON' } }, 'Distance');
    const speed = createConfiguredProfile({ quantity: 'relative-speed' }, 'Rel. speed');
    const phase = createConfiguredProfile({ quantity: 'phase-angle' }, 'Phase angle');
    setEventResults(query.id, [{ ...event, queryId: query.id }]);

    moveConfiguredProfile(phase.id, -1);
    expect(configuredProfiles().map((p) => p.id)).toEqual([range.id, phase.id, speed.id]);
    // Moving past either end is a no-op, and event queries keep their place.
    moveConfiguredProfile(range.id, -1);
    expect(configuredProfiles()[0].id).toBe(range.id);
    expect(analysis.items[0].id).toBe(query.id);

    setConfiguredItemVisible(speed.id, false);
    const changed = updateConfiguredProfile(speed.id, { quantity: 'range-rate', bodies: { target: 'MARS' } }, 'Range rate');
    expect(changed).toMatchObject({ id: speed.id, visible: false, label: 'Range rate' });

    removeConfiguredItem(phase.id);
    expect(configuredProfiles().map((p) => p.id)).toEqual([range.id, speed.id]);
    removeConfiguredItem(query.id);
    expect(analysis.eventResults[query.id]).toBeUndefined();
  });

  it('resolves a profile against the shared relationship without pinning it to it', () => {
    analysis.bodies = { observer: 'EARTH', target: 'MOON' };
    const shared = createConfiguredProfile({ quantity: 'range' }, 'Distance');
    const own = createConfiguredProfile({ quantity: 'range', bodies: { target: 'MARS' } }, 'Distance');

    expect(resolveProfile(shared).bodies).toEqual({ observer: 'EARTH', target: 'MOON' });
    expect(resolveProfile(own).bodies).toEqual({ observer: 'EARTH', target: 'MARS' });
    analysis.bodies = { observer: 'SUN', target: 'MOON' };
    expect(resolveProfile(shared).bodies.observer).toBe('SUN');
    expect(resolveProfile(own).window).toEqual({ start: 100, end: 200 });
  });

  it('reorders only the enabled profiles the timeline draws', () => {
    const a = createConfiguredProfile({ quantity: 'range' }, 'A');
    const off = createConfiguredProfile({ quantity: 'range' }, 'Off');
    const b = createConfiguredProfile({ quantity: 'range' }, 'B');
    setConfiguredItemEnabled(off.id, false);

    // B moves above A in one step, past the disabled item in between.
    moveConfiguredProfile(b.id, -1);
    const enabled = configuredProfiles().filter((p) => p.enabled).map((p) => p.id);
    expect(enabled).toEqual([b.id, a.id]);
  });
});

