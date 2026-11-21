/** LOLA/LROC map coordinates used by the audited lunar cube products (#238).
 * MOON_ME is an FK-dependent alias; preserve the realization explicitly. */
export const LUNAR_SURFACE_FRAME = 'MOON_ME_DE421';

/** Metadata errata only, for the immutable products audited in #238. Their
 * generators sampled source map longitudes directly; no IAU rotation was ever
 * applied to payloads. Unknown revisions get no correction. */
const LEGACY_ME421_PRODUCTS = new Set([
  'cube-fused-79895697c6b6-g3-m12-b6747ec9d',
  'cube-imagery-nac-6db766f8beebcace',
  'cube-imagery-composite-3f34a19541af7710',
]);
export function lunarProductFrame(declaredFrame: string | undefined, revision: string | undefined): string | undefined {
  return revision && LEGACY_ME421_PRODUCTS.has(revision) && (!declaredFrame || declaredFrame === 'IAU_MOON')
    ? LUNAR_SURFACE_FRAME : declaredFrame;
}
