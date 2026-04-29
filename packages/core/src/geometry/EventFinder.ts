import type { SpiceInstance, TimeWindow } from '@cosmolabe/spice';

export type EventType = 'eclipse' | 'occultation' | 'conjunction' | 'opposition' | 'periapsis' | 'apoapsis';

export interface EventFinderConfig {
  searchWindow: TimeWindow;
  stepSize: number;  // seconds
}

export class EventFinder {
  constructor(private readonly spice: SpiceInstance) {}

  findEclipses(
    target: string,
    eclipsingBody: string,
    observer: string,
    config: EventFinderConfig,
  ): TimeWindow[] {
    return this.spice.gfoclt(
      'ANY', eclipsingBody, 'ELLIPSOID', `IAU_${eclipsingBody}`,
      target, 'POINT', '',
      'LT', observer,
      config.stepSize,
      [config.searchWindow],
    );
  }

  findOccultations(
    target: string,
    occultingBody: string,
    observer: string,
    config: EventFinderConfig,
  ): TimeWindow[] {
    return this.spice.gfoclt(
      'ANY', occultingBody, 'ELLIPSOID', `IAU_${occultingBody}`,
      target, 'POINT', '',
      'LT+S', observer,
      config.stepSize,
      [config.searchWindow],
    );
  }

  findDistanceExtrema(
    target: string,
    observer: string,
    type: 'periapsis' | 'apoapsis',
    config: EventFinderConfig,
  ): TimeWindow[] {
    const relate = type === 'periapsis' ? 'LOCMIN' : 'LOCMAX';
    return this.spice.gfdist(
      target, 'NONE', observer,
      relate, 0, 0,
      config.stepSize,
      [config.searchWindow],
    );
  }
}
