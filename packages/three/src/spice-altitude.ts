import type { HeritageSpice } from '@cosmolabe/frames';

/**
 * The slice of a SPICE instance {@link spiceAltitude} needs: the heritage
 * adapter on the main thread and the one inside the geometry worker both
 * satisfy it.
 *
 * Lives here rather than in `@cosmolabe/core` so the worker can import it
 * without pulling core's module graph (and its TLE propagator) into its bundle.
 */
export type SpiceAltitudeSource = Pick<HeritageSpice, 'bodn2c' | 'bodc2n' | 'bodvrd' | 'subpnt'>;

type Abcorr = Parameters<HeritageSpice['subpnt']>[4];

/**
 * The observer's altitude (km) above the target's reference ellipsoid, or `NaN`
 * when SPICE has no shape for the target.
 *
 * This is the number a flyby is quoted by — "640 km above Europa", not
 * "2,200 km from Europa's centre" — and it is SPICE's, not ours: `subpnt`'s
 * `NEAR POINT/ELLIPSOID` method finds the nearest point on the triaxial
 * ellipsoid the kernel pool's `RADII` define, and the altitude is the length of
 * the observer→surface vector it returns. Nothing here projects onto an
 * ellipsoid by hand.
 *
 * "No shape" is an answer, not a failure: a spacecraft or barycentre target has
 * no `RADII`, so it reports `NaN` and the caller omits the metric. Anything
 * else SPICE objects to — no ephemeris at `et`, no body-fixed frame — is thrown,
 * so the caller decides whether a missing annotation should fail its search.
 *
 * The body-fixed frame is the target's `IAU_<NAME>` frame, which is what the
 * furnished PCK supplies for every body with `RADII`. The frame has to be
 * centred on the target for `subpnt`, but the altitude itself does not depend
 * on its orientation.
 */
export function spiceAltitude(
  spice: SpiceAltitudeSource,
  target: string,
  abcorr: string,
  observer: string,
  et: number,
): number {
  // The viewer hands SPICE NAIF ids as strings ("502"), since a catalog display
  // name is not a SPICE name. The frame wants the SPICE name, so resolve it.
  const id = /^-?\d+$/.test(target.trim()) ? Number(target) : spice.bodn2c(target);
  const name = id == null ? null : spice.bodc2n(id);
  if (!name) return NaN;

  let radii: number[];
  try {
    radii = spice.bodvrd(String(id), 'RADII');
  } catch {
    // bodvrd throws when the pool has no RADII for the body: no shape.
    return NaN;
  }
  if (radii.length !== 3 || !radii.every((r) => Number.isFinite(r) && r > 0)) return NaN;

  const fixref = `IAU_${name.toUpperCase()}`;
  return spice.subpnt(
    'NEAR POINT/ELLIPSOID', String(id), et, fixref, abcorr as Abcorr, observer,
  ).altitude;
}
