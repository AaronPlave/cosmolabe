import { describe, expect, it } from 'vitest';
import {
  resolveContinuousProfile,
  resolveEventQuery,
  type AnalysisContext,
  type ConfiguredAnalysisItem,
  type ConfiguredContinuousProfile,
  type ConfiguredEventQuery,
} from '../geometry/analysis.js';

const context: AnalysisContext = {
  bodies: { observer: 'EARTH', target: 'MOON', illuminator: 'SUN' },
  reference: { frame: 'J2000', abcorr: 'LT+S' },
  window: { start: 100, end: 200 },
  currentTime: 150,
  quantities: [],
  eventResults: [],
};

describe('analysis context', () => {
  it('resolves an event item through the existing EventQuery boundary', () => {
    const item: ConfiguredEventQuery = {
      id: 'earth-moon-range',
      type: 'event-query',
      label: 'Earth to Moon range',
      enabled: true,
      visible: true,
      query: { kind: 'distance-range', params: { thresholdKm: 400_000 } },
    };

    expect(resolveEventQuery(item, context)).toEqual({
      id: 'earth-moon-range',
      kind: 'distance-range',
      params: { thresholdKm: 400_000 },
      bodies: context.bodies,
      window: context.window,
      abcorr: 'LT+S',
    });
  });

  it('lets each configured item override a shared relationship and window', () => {
    const event: ConfiguredEventQuery = {
      id: 'mars-range', type: 'event-query', label: 'Mars range', enabled: true, visible: true,
      query: {
        kind: 'distance-range',
        bodies: { target: 'MARS' },
        window: { start: 300, end: 400 },
        abcorr: 'NONE',
      },
    };
    const profile: ConfiguredContinuousProfile = {
      id: 'venus-phase', type: 'continuous-profile', label: 'Venus phase', enabled: true, visible: false,
      profile: { quantity: 'phase-angle', bodies: { target: 'VENUS' }, frame: 'ECLIPJ2000' },
    };

    expect(resolveEventQuery(event, context)).toMatchObject({
      id: 'mars-range', bodies: { observer: 'EARTH', target: 'MARS', illuminator: 'SUN' },
      window: { start: 300, end: 400 }, abcorr: 'NONE',
    });
    expect(resolveContinuousProfile(profile, context)).toEqual({
      quantity: 'phase-angle',
      bodies: { observer: 'EARTH', target: 'VENUS', illuminator: 'SUN' },
      window: { start: 100, end: 200 },
      frame: 'ECLIPJ2000',
      abcorr: 'LT+S',
    });
  });

  it('keeps event and continuous-profile configurations distinct and coexistent', () => {
    const items: ConfiguredAnalysisItem[] = [
      { id: 'events-a', type: 'event-query', label: 'Events A', enabled: false, visible: true, query: { kind: 'closest-approach' } },
      { id: 'profile-b', type: 'continuous-profile', label: 'Profile B', enabled: true, visible: false, profile: { quantity: 'range' } },
    ];

    expect(items.map(({ id, type, enabled, visible }) => ({ id, type, enabled, visible }))).toEqual([
      { id: 'events-a', type: 'event-query', enabled: false, visible: true },
      { id: 'profile-b', type: 'continuous-profile', enabled: true, visible: false },
    ]);
  });
});
