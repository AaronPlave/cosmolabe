import type * as THREE from 'three';

/**
 * The LOD cross-fade 3d-tiles-renderer's TilesFadePlugin is applying to a tile
 * material. While a tile fades, it and its parent or children all draw, each
 * discarding complementary pixels of a Bayer pattern; an overlay drawn on
 * copies of those tiles has to discard the same pixels, or it is blended twice
 * wherever both draw.
 *
 * The plugin offers no public way to read a tile's fade. It keeps its uniforms
 * on the material under a module-private `Symbol('FADE_PARAMS')` and switches
 * the dither on with `defines.FEATURE_FADE` (wrapFadeMaterial). This reads that
 * contract, which `TILE_FADE_TESTED_VERSION` names: `tile-fade.test.ts` drives
 * the bundled plugin's own fade path and checks the installed version, so an
 * upgrade that changes it fails there. At run time, a material that is fading
 * but whose fade cannot be read is reported as `'unreadable'`, never silently
 * treated as settled; the vector layer turns that into a diagnostic.
 * Batched tiles (BatchedTilesPlugin) keep fades in a texture instead; this
 * renderer does not batch tiles.
 */
export const TILE_FADE_TESTED_VERSION = '0.4.27';

export type TileFade = { fadeIn: number; fadeOut: number } | 'unreadable' | null;

/** The fade on a tile material: its values, `'unreadable'` when it fades but they cannot be read, or null when it is not fading. */
export function tileFade(material: THREE.Material | THREE.Material[] | undefined): TileFade {
  const m = Array.isArray(material) ? material[0] : material;
  if (!m || (m as THREE.Material & { defines?: Record<string, unknown> }).defines?.FEATURE_FADE !== 1) return null;
  const key = Object.getOwnPropertySymbols(m).find((s) => s.description === 'FADE_PARAMS');
  const params = key ? (m as unknown as Record<symbol, { fadeIn?: { value: unknown }; fadeOut?: { value: unknown } }>)[key] : undefined;
  const fadeIn = params?.fadeIn?.value, fadeOut = params?.fadeOut?.value;
  if (typeof fadeIn !== 'number' || typeof fadeOut !== 'number') return 'unreadable';
  return { fadeIn, fadeOut };
}
