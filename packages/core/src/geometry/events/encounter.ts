/**
 * Whether a range minimum is an encounter (#345).
 *
 * A closest-approach search returns mathematical local minima of range. Most
 * minima over a long window are not flybys: Psyche's minima from Earth after
 * launch are all beyond 1.8e8 km, Voyager 1's from Neptune 3.5e9 km. Calling
 * one a flyby needs a criterion, so this states which one it applied, with
 * its threshold and source, and says "unknown" where it has none.
 *
 * The criterion is the target's sphere of influence, r = a (μ/μ_primary)^(2/5)
 * (Laplace), the region inside which the target, not its primary, dominates
 * the trajectory: the patched-conic definition of a planetary flyby. Values
 * are the standard ones (Curtis, Orbital Mechanics for Engineering Students,
 * Table A.2), three significant figures. Small moons and asteroids have
 * spheres smaller than the targeted passes missions call flybys, so they get
 * no criterion here rather than a misleading one.
 */
export const SPHERE_OF_INFLUENCE_KM: Readonly<Record<string, number>> = {
  Mercury: 1.12e5, Venus: 6.16e5, Earth: 9.25e5, Moon: 6.61e4, Mars: 5.77e5,
  Jupiter: 4.82e7, Saturn: 5.48e7, Uranus: 5.18e7, Neptune: 8.66e7, Pluto: 3.08e6,
};

export interface EncounterClass {
  /** The criterion applied, or null when none applies to this target. */
  readonly criterion: 'sphere-of-influence' | 'query-max-range' | null;
  readonly thresholdKm: number | null;
  readonly rangeKm: number | null;
  /** true: within the criterion; false: a range minimum only; null: no criterion or no range. */
  readonly encounter: boolean | null;
  readonly basis: string;
}

/**
 * Classify one closest-approach result against `target`'s sphere of
 * influence, or, for a target without one, the search's own max-range filter
 * when it had one (every result already passed it).
 */
export function classifyApproach(target: string, rangeKm: number | null | undefined, queryMaxRangeKm?: number): EncounterClass {
  const range = typeof rangeKm === 'number' && Number.isFinite(rangeKm) ? rangeKm : null;
  const soi = SPHERE_OF_INFLUENCE_KM[target];
  if (soi !== undefined) {
    const encounter = range === null ? null : range <= soi;
    return { criterion: 'sphere-of-influence', thresholdKm: soi, rangeKm: range, encounter,
      basis: `${target}'s sphere of influence is ${soi.toExponential(2)} km (Laplace radius, Curtis Table A.2); ${range === null ? 'range unmeasured' : encounter ? 'this approach is inside it: a flyby' : 'this approach is outside it: a distant range minimum, not a flyby'}.` };
  }
  if (queryMaxRangeKm !== undefined && Number.isFinite(queryMaxRangeKm)) {
    return { criterion: 'query-max-range', thresholdKm: queryMaxRangeKm, rangeKm: range, encounter: range === null ? null : range <= queryMaxRangeKm,
      basis: `within the search's own ${queryMaxRangeKm} km limit; no sphere-of-influence value for ${target}.` };
  }
  return { criterion: null, thresholdKm: null, rangeKm: range, encounter: null,
    basis: `no encounter criterion for ${target}: this is a range minimum; whether it counts as a flyby is not established here.` };
}
