import type { Trajectory, CartesianState } from '../Trajectory.js';
import type { Vec3 } from '@cosmolabe/spice';
import { tass17Position, TASS17Satellite } from './TASS17.js';
import { l1Position, L1Satellite } from './L1.js';
import { gust86Position, Gust86Satellite } from './Gust86.js';
import { marsSatPosition, MarsSatSatellite } from './MarsSat.js';

type PositionFn = (et: number) => [number, number, number];

/**
 * Wraps an analytical position function as a Trajectory.
 * Returns positions in km relative to the parent body, J2000 ecliptic frame.
 * Velocity is computed via finite differencing (Δt = 1s).
 */
export class AnalyticalTrajectory implements Trajectory {
  private readonly positionFn: PositionFn;
  private _period?: number;

  get startTime(): number | undefined { return undefined; }
  get endTime(): number | undefined { return undefined; }
  get period(): number | undefined { return this._period; }

  constructor(positionFn: PositionFn, period?: number) {
    this.positionFn = positionFn;
    this._period = period;
  }

  stateAt(et: number): CartesianState {
    const p = this.positionFn(et);
    // Finite difference velocity (km/s)
    const dt = 1.0;
    const p2 = this.positionFn(et + dt);
    const velocity: Vec3 = [
      (p2[0] - p[0]) / dt,
      (p2[1] - p[1]) / dt,
      (p2[2] - p[2]) / dt,
    ];
    return { position: p, velocity };
  }
}

// Satellite name → enum lookups
const TASS17_MAP: Record<string, TASS17Satellite> = {
  Mimas: TASS17Satellite.Mimas,
  Enceladus: TASS17Satellite.Enceladus,
  Tethys: TASS17Satellite.Tethys,
  Dione: TASS17Satellite.Dione,
  Rhea: TASS17Satellite.Rhea,
  Titan: TASS17Satellite.Titan,
  Hyperion: TASS17Satellite.Hyperion,
  Iapetus: TASS17Satellite.Iapetus,
};

const L1_MAP: Record<string, L1Satellite> = {
  Io: L1Satellite.Io,
  Europa: L1Satellite.Europa,
  Ganymede: L1Satellite.Ganymede,
  Callisto: L1Satellite.Callisto,
};

const GUST86_MAP: Record<string, Gust86Satellite> = {
  Miranda: Gust86Satellite.Miranda,
  Ariel: Gust86Satellite.Ariel,
  Umbriel: Gust86Satellite.Umbriel,
  Titania: Gust86Satellite.Titania,
  Oberon: Gust86Satellite.Oberon,
};

const MARSSAT_MAP: Record<string, MarsSatSatellite> = {
  Phobos: MarsSatSatellite.Phobos,
  Deimos: MarsSatSatellite.Deimos,
};

/**
 * Create an analytical theory trajectory by theory name and satellite name.
 * Returns null if the satellite name is not recognized for the given theory.
 */
export function createAnalyticalTrajectory(
  theoryType: string,
  satelliteName: string,
): AnalyticalTrajectory | null {
  switch (theoryType) {
    case 'TASS17': {
      const sat = TASS17_MAP[satelliteName];
      if (sat == null) return null;
      return new AnalyticalTrajectory(et => tass17Position(sat, et));
    }
    case 'L1': {
      const sat = L1_MAP[satelliteName];
      if (sat == null) return null;
      return new AnalyticalTrajectory(et => l1Position(sat, et));
    }
    case 'Gust86': {
      const sat = GUST86_MAP[satelliteName];
      if (sat == null) return null;
      return new AnalyticalTrajectory(et => gust86Position(sat, et));
    }
    case 'MarsSat': {
      const sat = MARSSAT_MAP[satelliteName];
      if (sat == null) return null;
      return new AnalyticalTrajectory(et => marsSatPosition(sat, et));
    }
    default:
      return null;
  }
}

/**
 * Try to create an analytical trajectory for a body name by checking all theories.
 * Used as a fallback when SPICE is unavailable.
 */
export function createAnalyticalTrajectoryByName(bodyName: string): AnalyticalTrajectory | null {
  if (bodyName in TASS17_MAP) return createAnalyticalTrajectory('TASS17', bodyName);
  if (bodyName in L1_MAP) return createAnalyticalTrajectory('L1', bodyName);
  if (bodyName in GUST86_MAP) return createAnalyticalTrajectory('Gust86', bodyName);
  if (bodyName in MARSSAT_MAP) return createAnalyticalTrajectory('MarsSat', bodyName);
  return null;
}
