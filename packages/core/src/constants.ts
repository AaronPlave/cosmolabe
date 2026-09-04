/**
 * Shared physical and frame constants.
 *
 * This module deliberately imports nothing, so every layer — core kinematics,
 * the frames tier, the Cesium adapter — can depend on it without a cycle. Any
 * constant duplicated in two places belongs here instead: the obliquity below
 * was written out by hand in three separate files and had silently drifted from
 * the value SPICE uses.
 */

/**
 * Mean obliquity of the ecliptic at J2000, in arcseconds (IAU 1976).
 *
 * Stated in arcseconds because that is the form the standard defines and the
 * form CSPICE uses: 84381.448 exactly. Deriving degrees and radians from it
 * means nobody has to trust a hand-rounded decimal.
 *
 * This matters more than the size of the number suggests. The three
 * hand-written copies this replaces all read 23.4392911 degrees, which is
 * 84381.44796 arcseconds — short by 4.0e-5 arcsec. Measured against
 * `pxform('J2000', 'ECLIPJ2000')`, that truncation put our analytical rotation
 * 0.194 m off at a Saturn-moon distance of 1e6 km and 29.0 m off at 1 AU. With
 * the exact value our analytical obliquity agrees with CSPICE's to zero
 * arcseconds, so the analytical and SPICE-backed paths through the renderer no
 * longer disagree by construction. `obliquity-consistency.test.ts` pins that.
 */
export const OBLIQUITY_J2000_ARCSEC = 84381.448;

/** Mean obliquity of the ecliptic at J2000, in degrees (23.4392911111...). */
export const OBLIQUITY_J2000_DEG = OBLIQUITY_J2000_ARCSEC / 3600;

/** Mean obliquity of the ecliptic at J2000, in radians. */
export const OBLIQUITY_J2000_RAD = (OBLIQUITY_J2000_DEG * Math.PI) / 180;
