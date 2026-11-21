// A host's simulation says when an instrument is acquiring. Its FOV is drawn
// then, or while someone inspects the sensor, or with "Show FOV" — and a time
// the host says nothing about is unknown, never taken as acquiring.
import { describe, expect, it } from 'vitest';
import { UniverseRenderer } from '../UniverseRenderer.js';
import { SensorFrustum } from '../SensorFrustum.js';

function renderer(selected: string | null = null, instrument: string | null = null) {
  const r = Object.create(UniverseRenderer.prototype) as UniverseRenderer & Record<string, unknown>;
  Object.assign(r, {
    _sensorActivity: new Map(),
    _idleSensorsVisible: false,
    universe: { time: 0, state: { get: (k: string) => (k === 'selectedBody' ? selected : undefined) } },
    instrumentView: instrument ? { active: true, sensorName: instrument } : null,
  });
  return r as unknown as Pick<UniverseRenderer, 'setSensorActivity' | 'sensorActivityAt' | 'setIdleSensorsVisible'> & { sensorActivityShown(name: string, et: number): boolean };
}

const CAM = 'Polaris-A Survey Camera';
const survey = [{ startEt: 100, endEt: 138, state: 'acquiring' as const }, { startEt: 0, endEt: 100, state: 'off' as const }];

describe('host sensor activity', () => {
  it('reports the interval state, unknown outside every interval, null for unreported sensors', () => {
    const r = renderer();
    r.setSensorActivity(CAM, survey);
    expect(r.sensorActivityAt(CAM, 50)).toBe('off');
    expect(r.sensorActivityAt(CAM, 100)).toBe('acquiring');
    expect(r.sensorActivityAt(CAM, 137.9)).toBe('acquiring');
    expect(r.sensorActivityAt(CAM, 138)).toBe('unknown');
    expect(r.sensorActivityAt('Other', 120)).toBeNull();
  });

  it('draws the FOV only while acquiring, unless inspected or Show FOV', () => {
    const r = renderer();
    r.setSensorActivity(CAM, survey);
    expect(r.sensorActivityShown(CAM, 120)).toBe(true);
    expect(r.sensorActivityShown(CAM, 50)).toBe(false);
    expect(r.sensorActivityShown(CAM, 500)).toBe(false); // unknown is not acquiring
    const selected = renderer(CAM);
    selected.setSensorActivity(CAM, survey);
    expect(selected.sensorActivityShown(CAM, 50)).toBe(true);
    const inspected = renderer(null, CAM);
    inspected.setSensorActivity(CAM, survey);
    expect(inspected.sensorActivityShown(CAM, 50)).toBe(true);
    r.setIdleSensorsVisible(true);
    expect(r.sensorActivityShown(CAM, 50)).toBe(true);
  });

  it('a sensor no host reports on keeps the catalog behaviour; clearing restores it', () => {
    const r = renderer();
    expect(r.sensorActivityShown(CAM, 50)).toBe(true);
    r.setSensorActivity(CAM, survey);
    r.setSensorActivity(CAM, null);
    expect(r.sensorActivityShown(CAM, 50)).toBe(true);
  });

  it('the frustum is visible only when present, user-visible and activity-shown', () => {
    const sf = Object.create(SensorFrustum.prototype) as SensorFrustum & Record<string, unknown>;
    Object.assign(sf, { _userVisible: true, _present: true, _activityShown: true, visible: true });
    sf.activityShown = false;
    expect(sf.visible).toBe(false);
    sf.activityShown = true;
    expect(sf.visible).toBe(true);
    sf.userVisible = false;
    expect(sf.visible).toBe(false);
  });
});
