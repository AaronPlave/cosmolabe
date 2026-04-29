import type { SpiceInstance } from '@cosmolabe/spice';
import type { Trajectory } from './Trajectory.js';
import { SpiceTrajectory } from './SpiceTrajectory.js';

const BUILTIN_BODIES: Record<string, { naifId: number; center: string }> = {
  Mercury: { naifId: 199, center: 'SUN' },
  Venus: { naifId: 299, center: 'SUN' },
  Earth: { naifId: 399, center: 'SUN' },
  Mars: { naifId: 499, center: 'SUN' },
  Jupiter: { naifId: 599, center: 'SUN' },
  Saturn: { naifId: 699, center: 'SUN' },
  Neptune: { naifId: 899, center: 'SUN' },
  Uranus: { naifId: 799, center: 'SUN' },
  Pluto: { naifId: 999, center: 'SUN' },
  Moon: { naifId: 301, center: 'EARTH' },
  Sun: { naifId: 10, center: 'SOLAR SYSTEM BARYCENTER' },
};

export function createBuiltinTrajectory(bodyName: string, spice: SpiceInstance, frame = 'ECLIPJ2000'): Trajectory {
  const info = BUILTIN_BODIES[bodyName];
  if (!info) throw new Error(`Unknown builtin body: ${bodyName}`);
  return new SpiceTrajectory(spice, String(info.naifId), info.center, frame);
}
